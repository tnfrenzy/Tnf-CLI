import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { RunStatus, StoredEvent } from "../core/run/events.js";
import { readRoles, roleDefaultModels, type RunManager, type StartRunInput } from "../core/run/run-manager.js";
import type { RunRecord } from "../core/run/run-store.js";
import { scanUsage } from "../core/usage/usage-blocks.js";
import { INBOX_MAX_BYTES, listInbox, saveInboxFile, validateInboxName } from "../core/run/inbox.js";
import { createSkillStore } from "../core/skill-workshop/store.js";
import { createSkillsGen } from "./skills-gen.js";
import type { MatchRole } from "../core/roles/role-match.js";
import { createSkillTrainer } from "../core/skill-workshop/runner.js";
import { makeSaveRunReport } from "../core/skill-workshop/run-report.js";
import { createManagerRunStep, SKILL_WORKSHOP_PROJECT, type StepManager } from "../core/skill-workshop/run-step.js";
import { cadStatus, findCadPython, inspectCad } from "../core/design3d/cad-tools.js";
import { type CommandRunner, type FetchLike } from "../core/release/pipeline.js";
import { locateGit } from "../core/git/git.js";
import { DEFAULT_TOWERS, ideaAgentsOf } from "../core/app/config.js";
import { authorize, type AuthPolicy } from "./auth.js";
import { loadKit } from "../core/design3d/design3d-kit.js";
import { createWorkshop3D, tryCreateWorkshop3D, type Workshop3DEngine } from "../core/workshop3d/index.js";
import { createMaterialLibrary, type MaterialLibrary } from "../core/workshop3d/material-library.js";
import { createVariantStore } from "../core/workshop3d/variant-store.js";
import { createCodeVideoCore, type CvCore, type CvStepManager } from "../core/codevideo/index.js";
import type { Models3dEngine } from "../core/codevideo/models3d.js";
import { handleCodeVideoRoute } from "./codevideo-routes.js";
import { handleVariantsRoute } from "./variants-routes.js";
import { handleMaterialsRoute } from "./materials-routes.js";
import { handleCliAccountsRoute } from "./routes/cli-accounts.js";
import { buildDesign3dFloors } from "../core/design3d/design3d-outputs.js";
import { loadAppSettings } from "../core/app/app-settings.js";
import { findTailscale, phoneInfo } from "../core/app/phone-access.js";
import { PASS, SKILL_BODY_LIMIT, authMessage, errorMessage, fileNameHeader, isViaTunnel, json, numOpt, readBody, readRawBody, readSkillBody, safeJoin } from "./http-util.js";
import type { ApiContext } from "./api-context.js";
import { parseBuildingParam } from "../core/run/run-building.js";
import { handleQueueApi, queueRunIdSet } from "./routes/queue.js";
import { createSplitApi } from "./routes/idea-split.js";
import { handleWorkshop3dRoutes } from "./routes/workshop3d.js";
import { handleSkillRoutes } from "./routes/skills.js";
import { handleMcpRoutes } from "./routes/mcp.js";
import { handleReleaseRoutes } from "./routes/release.js";
import { handleAutopilotRoutes } from "./routes/autopilot.js";
import { handleRunRoutes } from "./routes/runs.js";
import { handleSettingsRoutes } from "./routes/settings.js";
import { handleLibraryRoutes } from "./routes/library.js";
import { handleGrantRoutes } from "./routes/grants.js";
import { handleEnvironmentRoutes } from "./routes/environments.js";

export { isViaTunnel } from "./http-util.js";

export interface ServerOptions {
  manager: RunManager;
  policy: AuthPolicy;
  /** Directory with built UI (index.html). Optional. */
  staticDir?: string | undefined;
  /** Test hooks for the release pipeline (command runner, fetch, path existence, env). */
  releaseDeps?: ReleaseDeps | undefined;
  /** Test hook: replaces the usage log scanner. */
  usageScan?: typeof scanUsage | undefined;
  /** 3D workshop engine; defaults to the real one (tests inject a fake). null = unavailable: its routes answer 503. */
  workshop3d?: Workshop3DEngine | null | undefined;
  /** Why the engine is unavailable (shown in the 503 message) when `workshop3d` is null. */
  workshop3dError?: string | null | undefined;
  /** Test hook: builds the engine instead of createWorkshop3D (a throw makes it unavailable, never stops the server). */
  workshop3dFactory?: (() => Workshop3DEngine) | undefined;
  /** "Tạo hàng loạt" library (tests inject one with a fake python runner); null = its routes answer 503. */
  materialLibrary?: MaterialLibrary | null | undefined;
  /** Code-driven Video Studio (tower 5); defaults to the real one. null = unavailable: its routes answer 503. */
  codeVideo?: CvCore | null | undefined;
  /** Test hook: builds the studio instead of createCodeVideoCore (a throw makes it unavailable). */
  codeVideoFactory?: (() => CvCore) | undefined;
}

export interface ReleaseDeps {
  runner?: CommandRunner;
  fetch?: FetchLike;
  exists?: (p: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
};


export function createServer(opts: ServerOptions): http.Server {
  const { manager, policy } = opts;
  // Origins saved from Settings > Điện thoại are accepted again after a restart.
  for (const o of loadAppSettings(manager.config.dataDir).allowedOrigins ?? []) if (!(policy.extraOrigins ??= []).includes(o)) policy.extraOrigins.push(o);
  const currentPhoneInfo = () => phoneInfo({ port: policy.port, token: policy.token, origins: policy.extraOrigins ?? [], exe: findTailscale() });
  const store = manager.store;
  const skillStore = createSkillStore(manager.config.dataDir);
  // A broken 3D workshop (e.g. a bad config/roles-design3d.json) must not stop the whole app: its routes answer 503 instead.
  const w3d = opts.workshop3d !== undefined
    ? { engine: opts.workshop3d, error: opts.workshop3dError ?? null }
    : tryCreateWorkshop3D(opts.workshop3dFactory ?? (() => createWorkshop3D({ manager, dataDir: manager.config.dataDir, config: manager.config })));
  const workshop3d = w3d.engine;
  // A broken video studio must not stop the app either: its routes answer 503.
  let codeVideo: CvCore | null = null;
  if (opts.codeVideo !== undefined) codeVideo = opts.codeVideo;
  else {
    try {
      codeVideo = (opts.codeVideoFactory ?? (() => createCodeVideoCore({ manager: manager as unknown as CvStepManager, dataDir: manager.config.dataDir, models3d: workshop3d as unknown as Models3dEngine | null, log: (m) => console.warn(`[codevideo] ${m}`) })))();
    } catch (e) {
      console.warn(`[codevideo] không khởi tạo được: ${e instanceof Error ? e.message : String(e)}`);
      codeVideo = null;
    }
  }
  codeVideo?.recover();
  const materials = opts.materialLibrary !== undefined ? opts.materialLibrary : createMaterialLibrary({ dataDir: manager.config.dataDir, python: () => findCadPython(process.env, manager.config.tools?.cad?.python ?? null) });
  const variants = createVariantStore({ lib: materials });
  const stepAdapter = createManagerRunStep(manager as unknown as StepManager);
  const skillTrainer = createSkillTrainer({
    store: skillStore,
    runStep: stepAdapter.runStep,
    cancelActive: stepAdapter.cancelActive,
    saveRunReport: makeSaveRunReport(manager.store),
    now: () => new Date().toISOString()
  });
  const skillsGen = createSkillsGen({
    store: skillStore,
    dataDir: manager.config.dataDir,
    runStep: stepAdapter.runStep,
    cadPython: manager.config.tools?.cad?.python ?? null,
    readBody: (r) => readSkillBody(r, SKILL_BODY_LIMIT),
    listRoles: () => {
      const seen = new Map<string, MatchRole>();
      for (const file of [manager.config.defaults.coding.agentsFile, manager.config.defaults.research.agentsFile]) {
        let roles: Record<string, Record<string, unknown>> = {};
        try {
          roles = readRoles(file);
        } catch {
          continue;
        }
        for (const [id, def] of Object.entries(roles)) {
          const description = def?.["description"];
          if (typeof description !== "string" || seen.has(id)) continue;
          const prompt = def?.["prompt"];
          const tools = def?.["tools"];
          seen.set(id, {
            id,
            description,
            ...(typeof prompt === "string" ? { prompt } : {}),
            ...(Array.isArray(tools) && tools.every((t) => typeof t === "string") ? { tools: tools as string[] } : {})
          });
        }
      }
      return [...seen.values()];
    },
    finder: async (prompt) => {
      // Own adapter: the finder needs web tools (the trainer steps get none) and a budget ceiling.
      try {
        const started = await manager.startRun({ prompt, project: SKILL_WORKSHOP_PROJECT, kind: "research", roles: false, allowedTools: ["WebSearch", "WebFetch"], maxBudgetUsd: 1 } as Parameters<typeof manager.startRun>[0]);
        const done = await manager.waitFor(started.id);
        return { ok: done?.status === "done", text: done?.result_text ?? "" };
      } catch {
        return { ok: false, text: "" };
      }
    },
  });
  const wss = new WebSocketServer({
    noServer: true,
    // Echo the `tnf-token.<token>` subprotocol so browsers accept the handshake.
    handleProtocols: (protocols) => {
      for (const pr of protocols) if (pr.startsWith("tnf-token.")) return pr;
      return false;
    },
  });
  const runSubs = new Map<string, Set<WebSocket>>();
  const overview = new Set<WebSocket>();

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  manager.on("event", ({ run_id, stored }: { run_id: string; stored: StoredEvent }) => {
    const subs = runSubs.get(run_id);
    if (subs) for (const ws of subs) send(ws, { type: "event", run_id, stored });
  });
  manager.on("run.updated", (run: RunRecord) => {
    for (const ws of overview) send(ws, { type: "run", run });
    const subs = runSubs.get(run.id);
    if (subs) for (const ws of subs) send(ws, { type: "run", run });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) {
        const fail = authorize(req, policy, { originRequired: false });
        if (fail) return json(res, fail === "bad_token" ? 401 : 403, { error: fail, message: authMessage(fail) });
        return await handleApi(req, res, url);
      }
      return serveStatic(req, res, p);
    } catch (e) {
      const st = (e as { status?: unknown } | null)?.status;
      if (st === 400 || st === 413) {
        return json(res, st, { error: st === 400 ? "bad_request" : "payload_too_large", message: (e as Error).message });
      }
      return json(res, 500, { error: "internal", ...errorMessage(e) });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const fail = authorize(req, policy, { originRequired: true });
    if (fail) {
      socket.write(`HTTP/1.1 ${fail === "bad_token" ? 401 : 403} Forbidden\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const m = /^\/ws\/runs\/([^/]+)$/.exec(url.pathname);
    const isOverview = url.pathname === "/ws/overview";
    if (!m && !isOverview) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Echo the token subprotocol back so browsers accept the handshake.
      ws.on("message", () => {
        /* read-only channel: ignore client messages */
      });
      if (isOverview) {
        overview.add(ws);
        ws.on("close", () => overview.delete(ws));
        send(ws, { type: "runs", runs: store.listRuns({ limit: 50 }) });
      } else {
        const runId = decodeURIComponent(m![1]!);
        const after = numOpt(url.searchParams.get("after")) ?? 0;
        let set = runSubs.get(runId);
        if (!set) runSubs.set(runId, (set = new Set()));
        set.add(ws);
        ws.on("close", () => {
          set!.delete(ws);
          if (set!.size === 0) runSubs.delete(runId);
        });
        const run = store.getRun(runId);
        if (run) send(ws, { type: "run", run });
        for (const stored of store.getEvents(runId, after)) send(ws, { type: "event", run_id: runId, stored });
        send(ws, { type: "synced" });
      }
    });
  });

  // What the route modules under ./routes need from this server instance.
  const ctx: ApiContext = { manager, store, opts, w3d, workshop3d, skillStore, skillTrainer, skillsGen };
  const { handleSplitApi } = createSplitApi(ctx);

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (p === "/api/cad/status" && method === "GET") {
      return json(res, 200, await cadStatus({ configuredPython: (manager.config.tools?.cad?.python ?? null) }));
    }
    if (p === "/api/cad/inspect" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const stageId = body["stageId"];
      const fname = body["name"];
      if (typeof stageId !== "string" || typeof fname !== "string") return json(res, 400, { error: "bad_request", message: "Cần stageId và name của tệp đã đính kèm." });
      const bad = validateInboxName(stageId) ?? validateInboxName(fname);
      if (bad) return json(res, 400, { error: "bad_request", message: bad });
      const r = await inspectCad(path.join(manager.stageDir(stageId), "inbox", fname), { configuredPython: (manager.config.tools?.cad?.python ?? null) });
      return r.ok ? json(res, 200, { kind: r.kind, summary: r.summary }) : json(res, 422, { error: "cad_failed", message: r.error });
    }

    if (p === "/api/status" && method === "GET") {
      const cfg = manager.config;
      let auth: unknown = null;
      let authError: string | null = null;
      try {
        auth = await manager.authStatus();
      } catch (e) {
        authError = errorMessage(e).message;
      }
      // Phase 5.6: tell the UI whether the Claude Code CLI itself is present (installer does not bundle it).
      let claudePath: string | null = null;
      let claudeVersion: string | null = null;
      let claudeError: string | null = null;
      try {
        claudePath = manager.resolveClaude();
        claudeVersion = manager.claudeVersion();
      } catch (e) {
        claudeError = errorMessage(e).message;
      }
      let gitVersion: string | null = null;
      let gitError: string | null = null;
      try {
        gitVersion = locateGit(manager.env);
      } catch (e) {
        gitError = errorMessage(e).message;
      }
      return json(res, 200, {
        auth,
        auth_error: authError,
        claude_path: claudePath,
        claude_version: claudeVersion,
        claude_error: claudeError,
        git_version: gitVersion,
        git_error: gitError,
        rate_limit: manager.lastRateLimit,
        models: cfg.models,
        role_models: roleDefaultModels(cfg.defaults.agentsFile),
        defaults: cfg.defaults,
        limits: cfg.limits,
        towers: cfg.ui?.towers ?? DEFAULT_TOWERS,
        ui: { dailyCostWarnUsd: cfg.ui?.dailyCostWarnUsd ?? null },
        idea_agents: ideaAgentsOf(cfg),
        workspace_dir: cfg.workspaceDir,
        worktrees_dir: cfg.worktreesDir,
        queue: { splitter: { webSearch: cfg.queue?.splitter?.webSearch ?? true, maxWebCalls: cfg.queue?.splitter?.maxWebCalls ?? 20 } },
        role_models_coding: roleDefaultModels(cfg.defaults.coding.agentsFile),
        release: { viaTunnel: isViaTunnel(req), allowed: !isViaTunnel(req) || cfg.release?.allowRemote === true },
        quota_resumes: manager.listQuotaResumes(),
        quota_max_attempts: cfg.autoResume?.maxAttempts ?? 3,
        cli_accounts: manager.cliAccounts.list(),
        role_accounts: manager.getRoleAccounts(),
        note: "Chi phí hiển thị là ước tính phía client, không phải hóa đơn.",
      });
    }
    if (p === "/api/billing/status" && method === "GET") {
      try {
        const auth = await manager.authStatus();
        return json(res, 200, { ok: true, auth, mode: manager.config.defaults.authMode });
      } catch (e) {
        return json(res, 200, { ok: false, ...errorMessage(e), mode: manager.config.defaults.authMode });
      }
    }
    if (p === "/api/runs" && method === "GET") {
      const filter: Parameters<typeof store.listRuns>[0] = {};
      const q = url.searchParams.get("q");
      if (q) filter.q = q;
      const status = url.searchParams.get("status");
      if (status) filter.status = status as RunStatus;
      const project = url.searchParams.get("project");
      if (project) filter.project = project;
      const from = numOpt(url.searchParams.get("from"));
      if (from) filter.from = from;
      const to = numOpt(url.searchParams.get("to"));
      if (to) filter.to = to;
      const limit = numOpt(url.searchParams.get("limit"));
      if (limit) filter.limit = limit;
      const offset = numOpt(url.searchParams.get("offset"));
      if (offset && offset > 0) filter.offset = offset;
      if (url.searchParams.get("scout") === "1") filter.scout = true;
      const building = parseBuildingParam(url.searchParams.get("building"));
      if (building) filter.building = building;
      // threads=1: paginate by thread (root run + its follow-ups); `total` then counts threads. Default stays flat.
      const list = (f: typeof filter) => (url.searchParams.get("threads") === "1" ? store.listRunThreads(f) : { runs: store.listRuns(f), total: store.countRuns(f) });
      const queueMode = url.searchParams.get("queue");
      if (queueMode === "only" || queueMode === "exclude") {
        // Queue runs are the runs (and follow-up chains) of queue commands; they live in their own list.
        // Filter in SQL (ids / notIds) so only the requested page is read and parsed.
        const ids = [...queueRunIdSet(manager)];
        const scoped = queueMode === "only" ? { ...filter, ids } : { ...filter, notIds: ids };
        return json(res, 200, list(scoped));
      }
      return json(res, 200, list(filter));
    }
    if (p === "/api/runs" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const input: StartRunInput = { prompt: typeof body["prompt"] === "string" ? body["prompt"] : "" };
      if (body["mode"] === "subscription" || body["mode"] === "api") input.mode = body["mode"];
      if (typeof body["model"] === "string" && body["model"]) input.model = body["model"];
      if (typeof body["account_id"] === "string" && body["account_id"].trim()) input.accountId = body["account_id"].trim();
      if (body["provider"] === "claude") input.provider = body["provider"];
      const mt = numOpt(body["max_turns"]);
      if (mt !== undefined) input.maxTurns = mt;
      const mb = numOpt(body["budget_usd"]);
      if (mb !== undefined) input.maxBudgetUsd = mb;
      // Raw value goes to run-manager for validation (NaN for non-numeric text -> Vietnamese 400 via start_failed); coding runs only.
      const mrc = body["max_role_calls"];
      if (mrc !== undefined && mrc !== null && mrc !== "") input.maxRoleCalls = typeof mrc === "number" ? mrc : Number(mrc);
      if (typeof body["roles"] === "boolean") input.roles = body["roles"];
      if (typeof body["project"] === "string") input.project = body["project"];
      if (body["kind"] === "coding" || body["kind"] === "research") input.kind = body["kind"];
      const sc = body["scout"];
      if (sc !== undefined && sc !== null) {
        if (typeof sc !== "boolean") return json(res, 400, { error: "bad_request", message: "scout phải là true/false." });
        if (sc) input.scout = true;
      }
      if (typeof body["inbox_stage"] === "string" && body["inbox_stage"]) {
        if (validateInboxName(body["inbox_stage"])) return json(res, 400, { error: "bad_request", message: "Mã đính kèm không hợp lệ." });
        input.inboxStage = body["inbox_stage"];
      }
      // Extra agents (object name → definition) and skills (string[]) for this run; validated in run-manager (extras.ts).
      const ag = body["agents"];
      if (ag !== undefined && ag !== null) {
        if (typeof ag !== "object" || Array.isArray(ag)) return json(res, 400, { error: "bad_request", message: "agents phải là một đối tượng {tên: định nghĩa}." });
        if (Object.keys(ag).length) input.extraAgents = ag as NonNullable<StartRunInput["extraAgents"]>;
      }
      const sk = body["skills"];
      if (sk !== undefined && sk !== null) {
        if (!Array.isArray(sk) || sk.some((s) => typeof s !== "string")) return json(res, 400, { error: "bad_request", message: "skills phải là mảng chuỗi." });
        if (sk.length) input.skills = sk as string[];
      }
      const li = body["libraryItemIds"];
      if (li !== undefined && li !== null) {
        if (!Array.isArray(li) || li.some((s) => typeof s !== "string")) return json(res, 400, { error: "bad_request", message: "libraryItemIds phải là mảng chuỗi." });
        if (li.length) input.libraryItemIds = li as string[];
      }
      const rm = body["role_models"];
      if (rm && typeof rm === "object" && !Array.isArray(rm)) {
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(rm as Record<string, unknown>)) if (typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v)) clean[k] = v;
        input.roleModels = clean;
      }
      try {
        const run = await manager.startRun(input);
        return json(res, 201, { run });
      } catch (e) {
        return json(res, 400, { error: "start_failed", ...errorMessage(e) });
      }
    }
    if ((await handleSettingsRoutes(ctx, req, res, url)) !== PASS) return;
    if (p === "/api/costs/by-day" && method === "GET") return json(res, 200, { days: store.costByDay() });
    if (p === "/api/costs/coding-stats" && method === "GET") return json(res, 200, store.codingCostStats());
    if (p === "/api/inbox" && method === "POST") {
      // Attachment staged before the run exists: `?stage=<id>` reuses a staging dir, otherwise a new id is minted.
      const name = fileNameHeader(req);
      const bad = validateInboxName(name);
      if (bad) return json(res, 400, { error: "bad_request", message: bad });
      const given = url.searchParams.get("stage");
      if (given && validateInboxName(given)) return json(res, 400, { error: "bad_request", message: "Mã đính kèm không hợp lệ." });
      const stageId = given || `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const data = await readRawBody(req, INBOX_MAX_BYTES);
        const file = saveInboxFile(manager.stageDir(stageId), name, data);
        return json(res, 201, { ok: true, stage_id: stageId, file, files: listInbox(manager.stageDir(stageId)) });
      } catch (e) {
        return json(res, 400, { error: "inbox_failed", ...errorMessage(e) });
      }
    }
    if ((await handleLibraryRoutes(ctx, req, res, url)) !== PASS) return;
    if (await handleMaterialsRoute(req, res, p, method, materials, { viaTunnel: isViaTunnel(req) })) return;
    if (await handleCodeVideoRoute(req, res, p, method, { core: codeVideo, viaTunnel: isViaTunnel(req), log: (m) => console.warn(m) })) return;
    if (await handleCliAccountsRoute(req, res, p, method, manager, { json, readBody: (r) => readBody(r) as Promise<Record<string, unknown>>, isViaTunnel })) return;
    if (await handleVariantsRoute(req, res, p, method, { store: workshop3d ? workshop3d.store : null, variants })) return;
    if ((await handleWorkshop3dRoutes(ctx, req, res, url)) !== PASS) return;
    if ((await handleSkillRoutes(ctx, req, res, url)) !== PASS) return;
    if ((await handleMcpRoutes(ctx, req, res, url)) !== PASS) return;
    if ((await handleGrantRoutes(ctx, req, res, url)) !== PASS) return;
    if ((await handleEnvironmentRoutes(ctx, req, res, url)) !== PASS) return;
    if ((await handleReleaseRoutes(ctx, req, res, url)) !== PASS) return;
    if ((await handleAutopilotRoutes(ctx, req, res, url)) !== PASS) return;
    const sm = /^\/api\/projects\/([^/]+)\/queue\/split(?:\/([^/]+)(?:\/(answers))?)?$/.exec(p);
    if (sm && ((!sm[2] && method === "POST") || (sm[2] && !sm[3] && method === "GET") || (sm[2] && sm[3] && method === "POST"))) {
      return handleSplitApi(req, res, method, decodeURIComponent(sm[1]!), sm[2] ? decodeURIComponent(sm[2]) : undefined, sm[3]);
    }
    const qm = /^\/api\/projects\/([^/]+)\/queue(?:\/([^/]+)(?:\/(approve-run|skip|confirm-done|mark-failed|confirm-merged|retry|unskip|stop))?)?$/.exec(p);
    if (qm) {
      const isRunParallel = qm[2] === "run-parallel" && !qm[3];
      const isRunAll = qm[2] === "run-all" && (!qm[3] || qm[3] === "stop");
      const isApproveAll = qm[2] === "approve-all" && !qm[3];
      const isDeleteIdea = qm[2] === "delete-idea" && !qm[3];
      const ok =
        (isDeleteIdea && method === "POST") ||
        (!qm[2] && method === "GET") ||
        (isRunParallel && method === "POST") ||
        (isRunAll && method === "POST") ||
        (isApproveAll && method === "POST") ||
        (qm[2] && !isRunParallel && !isRunAll && !isApproveAll && !qm[3] && method === "PATCH") ||
        (qm[3] !== undefined && qm[3] !== "stop" && method === "POST") ||
        (qm[3] !== undefined && method === "POST");
      if (ok) return handleQueueApi(manager, req, res, method, decodeURIComponent(qm[1]!), qm[2] ? decodeURIComponent(qm[2]) : undefined, qm[3]);
    }
    const pm = /^\/api\/projects\/([^/]+)$/.exec(p);
    if (pm && pm[1] !== "validate" && method === "DELETE") {
      try {
        manager.removeProject(decodeURIComponent(pm[1]!));
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: "invalid_project", ...errorMessage(e) });
      }
    }
    if (p === "/api/projects/validate" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const repoPath = typeof body["repo_path"] === "string" ? body["repo_path"].trim() : "";
      const base = typeof body["base_branch"] === "string" && body["base_branch"].trim() ? body["base_branch"].trim() : "main";
      if (!repoPath) return json(res, 200, { ok: false, head_sha: null, dirty: false, branches: [], error: "Thiếu đường dẫn repo." });
      return json(res, 200, manager.validateProject(repoPath, base));
    }
    if (p === "/api/design3d" && method === "GET") {
      let kit;
      try {
        kit = loadKit(manager.config.repoRoot);
      } catch (e) {
        return json(res, 500, { error: "kit_invalid", ...errorMessage(e) });
      }
      const entries = store.listRuns({ limit: 200 }).map((r) => ({ run: r, artifacts: store.getArtifacts(r.id) }));
      return json(res, 200, { kit, floors: buildDesign3dFloors(entries) });
    }

    return handleRunRoutes(ctx, req, res, url);
  }

  // connect-src must also name each tunnel origin (and its ws/wss form), or the browser blocks fetch/WebSocket there.
  const extra = policy.extraOrigins ?? [];
  const csp = `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: ws://127.0.0.1:* ws://localhost:*${extra.map((o) => ` ${o} ${o.replace(/^http/, "ws")}`).join("")}`;

  function serveStatic(req: IncomingMessage, res: ServerResponse, p: string): void {
    const dir = opts.staticDir;
    if (!dir || !fs.existsSync(dir)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp });
      res.end("<!doctype html><meta charset=utf-8><p>Giao diện chưa được build. Chạy <code>npm run build:ui</code>.</p>");
      return;
    }
    let rel = p === "/" ? "/index.html" : p;
    let file = safeJoin(dir, "." + rel);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      rel = "/index.html";
      file = path.join(dir, "index.html");
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": rel === "/index.html" ? "no-store" : "public, max-age=3600",
      "x-frame-options": "DENY",
      "content-security-policy": csp,
    });
    fs.createReadStream(file).pipe(res);
  }

  return server;
}
