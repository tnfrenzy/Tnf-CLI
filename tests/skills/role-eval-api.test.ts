import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ControllerConfig } from "../../src/core/app/config.js";
import { getRoleEvalService } from "../../src/core/roles/role-eval-runner.js";
import { startServer, type StartedServer } from "../../src/server/index.js";

const FAKE = path.resolve(__dirname, "..", "..", "fixtures", "fake-claude.mjs");
const TOKEN = "e".repeat(48);
const H = { "x-controller-token": TOKEN, "content-type": "application/json" };

interface Ctx {
  started: StartedServer;
  base: string;
  root: string;
}

async function makeServer(extraEnv: Record<string, string>): Promise<Ctx> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-roleeval-"));
  const config: ControllerConfig = {
    repoRoot: root,
    claudePath: null,
    models: [{ id: "haiku", label: "haiku" }, { id: "sonnet", label: "sonnet" }],
    workspaceDir: path.join(root, "ws"),
    worktreesDir: path.join(root, "ws", "worktrees"),
    dataDir: path.join(root, "data"),
    server: { host: "127.0.0.1", port: 0, allowedOrigins: [] },
    defaults: {
      authMode: "subscription",
      model: "sonnet",
      maxTurns: 40,
      maxBudgetUsd: 3,
      timeoutMs: 60_000,
      allowedTools: ["Agent"],
      agentsFile: path.join(root, "roles.json"),
      systemPromptFile: path.join(root, "coord.md"),
      maxConcurrentSubagents: 3,
      maxSubagentSpawnDepth: 1,
      extraArgs: [],
      research: { allowedTools: ["Agent"], agentsFile: path.join(root, "roles.json"), systemPromptFile: path.join(root, "coord.md"), disallowedTools: [], extraArgs: [], maxRoleCalls: 8 },
      coding: {
        allowedTools: ["Agent", "Read", "Grep", "Glob", "Edit", "Write", "Bash(npm test*)"],
        agentsFile: path.join(root, "roles-coding.json"),
        systemPromptFile: path.join(root, "coord-coding.md"),
        settingsFile: path.join(root, "deny.json"),
        disallowedTools: ["Bash(git push*)"],
        extraArgs: ["--setting-sources", "project"],
        maxRoleCalls: 8,
      },
    },
    limits: { maxTurnsCeiling: 100, maxBudgetUsdCeiling: 10 },
  };
  const started = await startServer({
    config,
    port: 0,
    token: TOKEN,
    claudePath: process.execPath,
    claudeArgsPrefix: [FAKE],
    env: { ...process.env, FAKE_CLAUDE_FIXTURE: "hello", ...extraEnv },
  });
  return { started, base: `http://127.0.0.1:${started.policy.port}`, root };
}

async function closeServer(c: Ctx | undefined): Promise<void> {
  if (!c) return;
  await c.started.close();
  fs.rmSync(c.root, { recursive: true, force: true });
}

function call(c: Ctx, method: string, p: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: H };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return fetch(`${c.base}${p}`, init);
}

async function mkRole(c: Ctx, id: string): Promise<void> {
  const r = await call(c, "POST", "/api/library/roles", { id, description: "Vai thử", prompt: "Trả lời ngắn.", tools: ["Read"] });
  expect(r.status).toBe(201);
}

const CASES = [{ id: "c1", title: "Ca 1", prompt: "Xin chào", checks: [{ type: "min-length", min: 0 }] }];

function evalFile(c: Ctx, id: string): string {
  return path.join(c.root, "data", "library", "role-evals", `${id}.json`);
}

describe("role evals API (fake-claude hello)", () => {
  let c: Ctx;
  beforeAll(async () => {
    c = await makeServer({});
  });
  afterAll(async () => {
    await closeServer(c);
  });

  it("PUT valid cases then GET returns them with version", async () => {
    await mkRole(c, "r-basic");
    const put = await call(c, "PUT", "/api/library/roles/r-basic/evals", { cases: CASES });
    expect(put.status).toBe(200);
    const g = (await (await call(c, "GET", "/api/library/roles/r-basic/evals")).json()) as { cases: unknown[]; version: string; results: unknown[]; running: boolean };
    expect(g.cases).toEqual(CASES);
    expect(typeof g.version).toBe("string");
    expect(g.version.length).toBeGreaterThan(0);
    expect(g.results).toEqual([]);
    expect(g.running).toBe(false);
  });

  it("PUT invalid cases gives 400 with a Vietnamese message", async () => {
    await mkRole(c, "r-bad");
    const noPrompt = await call(c, "PUT", "/api/library/roles/r-bad/evals", { cases: [{ id: "a", title: "t", checks: [{ type: "min-length", min: 1 }] }] });
    expect(noPrompt.status).toBe(400);
    expect(((await noPrompt.json()) as { message: string }).message).toMatch(/prompt/);
    const dup = await call(c, "PUT", "/api/library/roles/r-bad/evals", { cases: [CASES[0], CASES[0]] });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { message: string }).message).toMatch(/trùng/);
  });

  it("unknown role gives 404 for GET, PUT, run and cancel", async () => {
    const base = "/api/library/roles/khong-co/evals";
    expect((await call(c, "GET", base)).status).toBe(404);
    expect((await call(c, "PUT", base, { cases: CASES })).status).toBe(404);
    expect((await call(c, "POST", `${base}/run`, {})).status).toBe(404);
    expect((await call(c, "POST", `${base}/cancel`, {})).status).toBe(404);
  });

  it("run validates repeats and missing cases", async () => {
    await mkRole(c, "r-run-bad");
    expect((await call(c, "POST", "/api/library/roles/r-run-bad/evals/run", {})).status).toBe(400);
    await call(c, "PUT", "/api/library/roles/r-run-bad/evals", { cases: CASES });
    expect((await call(c, "POST", "/api/library/roles/r-run-bad/evals/run", { repeats: 4 })).status).toBe(400);
    expect((await call(c, "POST", "/api/library/roles/r-run-bad/evals/run", { repeats: 0 })).status).toBe(400);
  });

  it("valid run returns 202 and produces a result stored in the same file", async () => {
    await mkRole(c, "r-run");
    await call(c, "PUT", "/api/library/roles/r-run/evals", { cases: CASES });
    const file = evalFile(c, "r-run");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("Xin chào");
    const r = await call(c, "POST", "/api/library/roles/r-run/evals/run", { repeats: 1 });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ started: true });
    await getRoleEvalService(c.started.manager).done("r-run");
    const g = (await (await call(c, "GET", "/api/library/roles/r-run/evals")).json()) as { results: unknown[]; running: boolean };
    expect(g.results.length).toBeGreaterThanOrEqual(1);
    expect(g.running).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("costUsd");
  }, 30000);

  it("bodies over 64 KB give 413 for PUT and run", async () => {
    await mkRole(c, "r-big");
    const big = JSON.stringify({ cases: CASES, pad: "x".repeat(70 * 1024) });
    const put = await call(c, "PUT", "/api/library/roles/r-big/evals", big);
    expect(put.status).toBe(413);
    expect(((await put.json()) as { message: string }).message).toContain("quá lớn");
    const run = await call(c, "POST", "/api/library/roles/r-big/evals/run", big);
    expect(run.status).toBe(413);
  });

  it("deleting a role removes its eval file and a recreated role starts empty", async () => {
    await mkRole(c, "r-del");
    await call(c, "PUT", "/api/library/roles/r-del/evals", { cases: CASES });
    expect(fs.existsSync(evalFile(c, "r-del"))).toBe(true);
    expect((await call(c, "DELETE", "/api/library/roles/r-del")).status).toBe(200);
    expect(fs.existsSync(evalFile(c, "r-del"))).toBe(false);
    await mkRole(c, "r-del");
    const g = (await (await call(c, "GET", "/api/library/roles/r-del/evals")).json()) as { cases: unknown[]; results: unknown[] };
    expect(g.cases).toEqual([]);
    expect(g.results).toEqual([]);
  });

  it("legacy library routes still work", async () => {
    expect((await call(c, "GET", "/api/library")).status).toBe(200);
    await mkRole(c, "r-legacy");
    const put = await call(c, "PUT", "/api/library/roles/r-legacy", { description: "Mô tả mới" });
    expect(put.status).toBe(200);
  });
});

describe("role evals API cancel with hanging claude", () => {
  let c: Ctx | undefined;
  afterEach(async () => {
    if (c) {
      getRoleEvalService(c.started.manager).cancel("r-hang");
      const runsDir = path.join(c.root, "data", "runs");
      if (fs.existsSync(runsDir)) for (const d of fs.readdirSync(runsDir)) c.started.manager.cancel(d);
      await Promise.race([getRoleEvalService(c.started.manager).done("r-hang"), new Promise((r) => setTimeout(r, 5000))]);
    }
    await closeServer(c);
    c = undefined;
  });

  it("run, conflict 409, running true, then cancel", async () => {
    c = await makeServer({ FAKE_CLAUDE_HANG: "1" });
    await mkRole(c, "r-hang");
    await call(c, "PUT", "/api/library/roles/r-hang/evals", { cases: CASES });
    const first = await call(c, "POST", "/api/library/roles/r-hang/evals/run", {});
    expect(first.status).toBe(202);
    const runsDir = path.join(c.root, "data", "runs");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(fs.existsSync(runsDir) && fs.readdirSync(runsDir).length >= 1)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fs.existsSync(runsDir) && fs.readdirSync(runsDir).length >= 1).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect((await call(c, "POST", "/api/library/roles/r-hang/evals/run", {})).status).toBe(409);
    const g = (await (await call(c, "GET", "/api/library/roles/r-hang/evals")).json()) as { running: boolean };
    expect(g.running).toBe(true);
    const cancel = await call(c, "POST", "/api/library/roles/r-hang/evals/cancel", {});
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ cancelled: true });
    for (const d of fs.readdirSync(runsDir)) c.started.manager.cancel(d);
    const outcome = await Promise.race([
      getRoleEvalService(c.started.manager).done("r-hang").then(() => "done"),
      new Promise((r) => setTimeout(() => r("timeout"), 10_000)),
    ]);
    expect(outcome).toBe("done");
  }, 30000);
});
