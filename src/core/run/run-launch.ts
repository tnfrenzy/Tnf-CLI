import fs from "node:fs";
import path from "node:path";
import { BillingGuardError, runBillingGuard } from "./billing-guard.js";
import { getCliProvider } from "./providers/registry.js";
import { resolveModelForProvider } from "./providers/model-distribution.js";
import type { CliProvider, CliRunner, ProviderRunnerOptions } from "./providers/types.js";
import { ideaAgentsOf, type AuthMode, type KindDefaults, type RunKind } from "../app/config.js";
import type { NormalizedEvent } from "./events.js";
import { AGENT_GIT_ENV, collectPostRun, createWorktreeAsync, describeUnmergedDeps, mergeDependencyBranchesLenient, removeWorktree, runBranchName, runGit, runWorktreePath, validateRepo } from "../git/git.js";
import { buildContextBlock, projectMemoryPath, type ContextBlock } from "./context-scan.js";
import { grantsToDisallowedTools, planMcp } from "./grants.js";
import { mcpRunArgs, readCliSnapshot } from "../mcp/mcp-cli.js";
import { cliItemsToServers, loadMcpServers } from "../mcp/mcp-registry.js";
import { featuresPath } from "../app/feature-registry.js";
import { DEFAULT_NODE_MODULES, describeNodeModules, provisionNodeModules } from "../git/node-modules.js";
import { applySetupCommand, applySetupCopy, finishWorktreeSetup } from "../git/worktree-setup-apply.js";
import type { SetupCommandResult, SetupCopyResult } from "../git/worktree-setup.js";
import { adoptStagedInbox, inboxPromptNote } from "./inbox.js";
import { addCadSummaries } from "../design3d/cad-tools.js";
import { applyUxSkill, stripUxSkill } from "../roles/ux-skill.js";
import { MAX_EXTRA_AGENTS, describeExtraAgents, validateExtraAgents, validateSkills } from "./extras.js";
import type { LibraryItem } from "../roles/role-library.js";
import { foldPrompt } from "./prompt-file.js";
import { SANDBOX_DISALLOWED_TOOLS, SPLITTER_DISALLOWED_TOOLS, assertReadOnlyTools, assertSandboxTools,buildCodingAllowedTools, buildScoutWebTools, buildResearchAllowedTools } from "./permissions.js";
import type { CliAccountPublic } from "../shared-types.js";
import type { ProjectRecord, RunRecord } from "./run-store.js";
import { normalizeProject, planLibraryAppend, readRoles, renderRolePlaceholders, renderSystemPrompt, resolveMaxRoleCalls, type LibraryAppendPlan, type ReadOnlySpec, type StartRunInput } from "./run-input.js";
import { makeRunId } from "./run-support.js";
import { salvageSubagentOutputs, saveFinalAnswerAsReport } from "./run-artifacts.js";
import type { LaunchOptions, RunHost } from "./run-host.js";

export type LaunchHost = Pick<
  RunHost,
  | "config" | "store" | "env" | "skipBillingGuard" | "active" | "cliAccounts" | "library" | "setLastAuth" | "emitUpdated"
  | "isAccountCoolingDown" | "resolveBinaryForAccount" | "modelsForAccount" | "stageDir" | "getGrants" | "precheckMerge"
  | "onEvent" | "recordQuotaCooldownIfNeeded" | "maybeImmediateQuotaFailover" | "tryQuotaResume" | "maybeAutoResume"
  | "syncQueueOnExit" | "syncOutputs" | "forgetScope" | "drainWaiting" | "queueRunAllIfStarted"
>;

/** Per-run git context for coding runs (worktree of the target repo). */
interface CodingContext {
  project: ProjectRecord;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  repoStatusBefore: string;
  repoHeadBefore: string;
  /** True only for a freshly created worktree (not follow-up / reuseWorktreeOf): setup copy and command run there. */
  setupEligible?: boolean;
  /** Result of copying the project's gitignored setup files into the new worktree. */
  setupCopy?: SetupCopyResult | null;
  /** Dependency branches that conflicted when preparing a fresh worktree; the agent merges them itself. */
  unmergedDeps?: { branch: string; files: string[]; error: string }[];
}

type ExtraAgents = ReturnType<typeof validateExtraAgents>;

/** Per-run extras after validation: extra agents (incl. library roles), skills and the library append plan. */
interface RunExtras {
  extraAgents: ExtraAgents;
  requestedSkills: string[];
  skills: string[];
  libItems: LibraryItem[];
  lib: LibraryAppendPlan | null;
}

/** CLI account chosen for the run, with its binary, child environment and effective model. */
interface CliSelection {
  account: CliAccountPublic;
  provider: CliProvider;
  binaryPath: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  model: string;
}

/** Run id, directories and the prompt as stored/sent (long app-generated prompts are folded into a guidance file). */
interface RunWorkspace {
  runId: string;
  runDir: string;
  streamFile: string;
  /** Earlier run whose session a read-only role call continues (same run dir), or null. */
  resumeSrc: RunRecord | null;
  displayPrompt: string;
  prompt: string;
  guidanceRead: string | null;
}

interface ToolPlan {
  allowedTools: string[];
  disallowedTools: string[];
  mcpExtraArgs: string[];
}

/** What the exit handler of a started run needs. */
interface ExitContext {
  runId: string;
  runDir: string;
  streamFile: string;
  projectName: string;
  coding: CodingContext | null;
  readOnly: boolean;
}

const NO_CONTEXT: ContextBlock = { text: "", loaded: [] };

/** A follow-up keeps its parent's kind; a project with a repo always runs coding. */
export function resolveRunKind(input: StartRunInput, parent: RunRecord | null, project: ProjectRecord | null): RunKind {
  if (parent) return parent.kind;
  // A project with a repo always runs coding; the client's kind is only honoured for the legacy "coding without repo" error.
  if (project?.repo_path) return "coding";
  return input.kind === "coding" ? "coding" : "research";
}

/**
 * Starts one run: validate input → pick the CLI account (billing guard) → run dir → (coding: worktree) → per-run
 * roles/system prompt → store row → runner. Each phase is one method; `launchNow` only orders them.
 */
export class RunLauncher {
  constructor(private readonly host: LaunchHost) {}

  async launchNow(input: StartRunInput, parent: RunRecord | null, opts: LaunchOptions = {}): Promise<RunRecord> {
    const cfg = this.host.config;
    const d = cfg.defaults;
    // Scout runs ("Đề xuất") use the strongest model unless the caller chose one; coding runs keep the default.
    const sessionModel = input.model ?? (input.scout === true ? ideaAgentsOf(cfg).scoutModel : d.model);
    const mode = input.mode ?? d.authMode;
    const maxTurns = Math.min(input.maxTurns ?? d.maxTurns, cfg.limits.maxTurnsCeiling);
    const maxBudgetUsd = Math.min(input.maxBudgetUsd ?? (input.scout === true ? ideaAgentsOf(cfg).scoutBudgetUsd : d.maxBudgetUsd), cfg.limits.maxBudgetUsdCeiling);
    if (!input.prompt.trim()) throw new Error("Lệnh trống.");
    if (maxTurns < 1 || maxBudgetUsd <= 0) throw new Error("Trần lượt/ngân sách không hợp lệ.");

    const projectName = input.project !== undefined ? normalizeProject(input.project) : (parent?.project ?? "default");
    let project = this.host.store.getProject(projectName);
    const readOnly = input.readOnly ?? null;
    if (readOnly) {
      if (readOnly.writeDirs?.length) assertSandboxTools(readOnly.allowedTools, readOnly.writeDirs);
      else assertReadOnlyTools(readOnly.allowedTools);
    }
    const kind: RunKind = readOnly ? "research" : resolveRunKind(input, parent, project);
    const baseRoleCalls = resolveMaxRoleCalls(input, cfg, kind); // validate user input first (Vietnamese 400)
    if (kind === "coding" && !project?.repo_path) {
      throw new Error(project ? `Project "${projectName}" chưa gắn repo; dùng \`tnf projects add ${projectName} --repo <đường dẫn>\`.` : `Không tìm thấy project "${projectName}" (chưa gắn repo). Dùng \`tnf projects add\`.`);
    }
    // Research runs may name a brand-new label: record it as a repo-less project.
    if (!project) project = this.host.store.upsertProject({ name: projectName, repo_path: null, base_branch: null, allowed_commands: [] });
    const kd: KindDefaults = kind === "coding" ? d.coding : d.research;
    const useRoles = readOnly ? false : (input.roles ?? true);
    const extras = this.resolveExtras(input, kd, useRoles);
    const maxRoleCalls = baseRoleCalls + Object.keys(extras.extraAgents).length;

    const cli = await this.selectCli(input, parent, project, mode);
    const ws = await this.prepareWorkspace(input, parent, readOnly, projectName, opts.adoptRunId);
    const { runId, runDir, streamFile } = ws;
    // Coding: worktree of the target repo (SPEC §3.1–3.2). Errors here create an `error` run and never spawn.
    const coding = kind === "coding" ? await this.prepareCoding({ input, parent, project, projectName, kd, runId, runDir, mode, sessionModel }) : null;
    const ctx = coding ? this.scanContext(coding, kd, projectName, runDir) : NO_CONTEXT;
    // Per-run roles file (keeps config/roles*.json untouched): role model overrides and the context block for the analyst.
    const agentsFile = useRoles ? this.writeRolesFile({ input, kd, kind, extras, ctx, runId, runDir }) : undefined;
    const { lib, libItems } = extras;
    if (lib) {
      const lines = libItems.map((i) => `${i.id}\t${i.type}\t${Buffer.byteLength(i.content, "utf8")} bytes\troles: ${i.roleIds.join(",") || "(coordinator)"}`);
      fs.writeFileSync(path.join(runDir, "library-items.txt"), `Mục thư viện đã dùng (tổng ${lib.totalBytes} byte nối vào prompt):\n${lines.join("\n")}\n`, "utf8");
    }

    // Coordinator prompt: substitute {{maxRoleCalls}}/{{contextBlock}} into a per-run copy (config/ stays untouched).
    const systemPromptFile = useRoles
      ? renderSystemPrompt(kd.systemPromptFile, path.join(cfg.dataDir, "runs", runId, "system-prompt.md"), { maxRoleCalls: String(maxRoleCalls), contextBlock: ctx.text, baseSha: coding?.baseSha || project.base_branch || "main", extraAgents: [describeExtraAgents(extras.extraAgents), ...(lib?.coordinator ?? [])].filter(Boolean).join("\n\n") })
      : undefined;
    let systemPromptPath = systemPromptFile;
    if (readOnly) {
      systemPromptPath = path.join(cfg.dataDir, "runs", runId, "system-prompt.md");
      fs.mkdirSync(path.dirname(systemPromptPath), { recursive: true });
      fs.writeFileSync(systemPromptPath, readOnly.systemPrompt, "utf8");
    }

    const record = this.host.store.createRun({
      id: runId,
      status: "running",
      prompt: ws.displayPrompt,
      mode: `${mode}${readOnly ? "+queue-split" : kind === "coding" ? "+coding" : useRoles ? "+roles" : "+single"}`,
      model: cli.model,
      session_id: parent?.session_id ?? null,
      parent_run_id: parent?.id ?? null,
      project: projectName,
      claude_version: null,
      run_dir: runDir,
      kind,
      worktree_path: coding?.worktreePath ?? null,
      branch: coding?.branch ?? null,
      base_sha: coding?.baseSha ?? null,
      forked_from_run_id: input.resumeFrom?.runId ?? input.threadWith ?? null,
      provider: cli.account.provider,
      account_id: cli.account.id,
    });
    this.host.store.updateRun(runId, {
      limits: { maxTurns, maxBudgetUsd, maxRoleCalls: kind === "coding" ? maxRoleCalls : null, callTimeoutMinutes: kind === "coding" ? (kd.callTimeoutMinutes ?? null) : null },
    });

    // Setup command (fresh worktree only): runs after the run row exists and before the agent starts; never throws.
    let setupNotice: { key: string; text: string } | null = null;
    if (coding?.setupEligible) {
      let cmdRes: SetupCommandResult | null = null;
      try {
        const setupCfg = this.host.store.getProjectWorktreeSetup(projectName);
        cmdRes = await applySetupCommand({ worktreePath: coding.worktreePath, command: setupCfg.command, timeoutSec: setupCfg.timeoutSec, allowedCommands: coding.project.allowed_commands, env: { ...cli.env, ...AGENT_GIT_ENV } });
      } catch (e) {
        cmdRes = { ran: false, ok: false, exitCode: null, timedOut: false, tail: "", ms: 0, reason: e instanceof Error ? e.message : String(e) };
      }
      setupNotice = finishWorktreeSetup(runDir, coding.setupCopy ?? null, cmdRes);
    }

    const tools = this.planTools({ input, kd, coding, readOnly, skills: extras.skills, runDir, streamFile, guidanceRead: ws.guidanceRead });
    const options: ProviderRunnerOptions = {
      runId,
      claudePath: cli.binaryPath,
      cwd: coding ? coding.worktreePath : runDir,
      env: coding ? { ...cli.env, ...AGENT_GIT_ENV } : cli.env,
      authMode: mode,
      prompt: ws.prompt + describeUnmergedDeps(coding?.unmergedDeps ?? []),
      model: cli.model,
      maxTurns,
      maxBudgetUsd,
      timeoutMs: input.timeoutMs ?? d.timeoutMs,
      allowedTools: tools.allowedTools,
      disallowedTools: readOnly ? [...(readOnly.writeDirs?.length ? SANDBOX_DISALLOWED_TOOLS : SPLITTER_DISALLOWED_TOOLS)] : tools.disallowedTools.length ? tools.disallowedTools : undefined,
      settingsFile: readOnly ? d.coding.settingsFile : kd.settingsFile,
      agentsFile,
      systemPromptFile: systemPromptPath,
      resumeSessionId: parent?.session_id ?? ws.resumeSrc?.session_id ?? undefined,
      streamFile,
      maxConcurrentSubagents: d.maxConcurrentSubagents,
      maxSubagentSpawnDepth: d.maxSubagentSpawnDepth,
      extraArgs: readOnly ? ["--setting-sources", "project", ...readOnly.addDirs.flatMap((x) => ["--add-dir", x])] : [...tools.mcpExtraArgs, ...kd.extraArgs],
      addDirs: readOnly ? [...readOnly.addDirs] : [],
      runMetaDir: path.dirname(streamFile),
      readOnlyMode: !!readOnly,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    };
    if (kind === "coding" && kd.callTimeoutMinutes) options.callTimeoutMinutes = kd.callTimeoutMinutes;
    if (kind === "coding" && !readOnly && kd.permissionMode) options.permissionMode = kd.permissionMode;
    if (cli.argsPrefix.length) options.claudeArgsPrefix = cli.argsPrefix;

    const runner: CliRunner = cli.provider.createRunner(options);
    this.attachRunner(runner, { runId, runDir, streamFile, projectName, coding, readOnly: !!readOnly });
    if (coding?.unmergedDeps?.length) {
      const names = coding.unmergedDeps.map((f) => f.branch).join(", ");
      this.host.onEvent(runId, runner, { type: "notice", key: "deps_unmerged", text: `Chưa gộp tự động ${coding.unmergedDeps.length} nhánh phụ thuộc (xung đột), vai debug sẽ gỡ: ${names}` }, null);
    }
    if (setupNotice) this.host.onEvent(runId, runner, { type: "notice", key: setupNotice.key, text: setupNotice.text }, null);
    try {
      runner.start();
    } catch (e) {
      this.host.active.delete(runId);
      const msg = e instanceof BillingGuardError ? e.message : String(e);
      this.host.store.updateRun(runId, { status: "error", error: msg });
      this.host.emitUpdated(runId);
      throw e;
    }
    return record;
  }

  /** Per-run extras, validated before anything is created (Vietnamese errors surface as HTTP 400). */
  private resolveExtras(input: StartRunInput, kd: KindDefaults, useRoles: boolean): RunExtras {
    const extraAgents = validateExtraAgents(input.extraAgents, Object.keys(readRoles(kd.agentsFile)));
    const requestedSkills = validateSkills(input.skills);
    // ui-ux-pro-max is injected as a prompt block (applyUxSkill), never as a Skill(<name>) permission.
    const skills = stripUxSkill(requestedSkills);
    if (!useRoles && Object.keys(extraAgents).length) throw new Error("Chế độ single không hỗ trợ agent thêm; hãy bật chế độ vai hoặc bỏ agent thêm.");
    // Library items (text appended to the prompts of the ticked roles); resolved and size-checked before anything is created.
    const libItems = input.libraryItemIds?.length ? this.host.library.getItems(input.libraryItemIds) : [];
    if (!useRoles && libItems.length) throw new Error("Chế độ single không hỗ trợ mục thư viện; hãy bật chế độ vai hoặc bỏ mục thư viện.");
    const lib = libItems.length ? planLibraryAppend(libItems, [...Object.keys(readRoles(kd.agentsFile)), ...Object.keys(extraAgents)], this.host.library) : null;
    if (lib) {
      for (const name of Object.keys(lib.extraAgents)) if (!(name in extraAgents)) extraAgents[name] = lib.extraAgents[name]!;
      if (Object.keys(extraAgents).length > MAX_EXTRA_AGENTS) throw new Error(`Tối đa ${MAX_EXTRA_AGENTS} agent thêm cho mỗi run (kể cả vai từ thư viện).`);
    }
    return { extraAgents, requestedSkills, skills, libItems, lib };
  }

  /** Pick the CLI account (follow-ups stay on the parent's), pass the billing guard and resolve the model. */
  private async selectCli(input: StartRunInput, parent: RunRecord | null, project: ProjectRecord, mode: AuthMode): Promise<CliSelection> {
    const cfg = this.host.config;
    const account = this.host.cliAccounts.resolveAccount({
      requestedId: parent?.account_id ?? input.accountId,
      projectAccountId: project.account_id ?? null,
      preferredProvider: parent?.provider ?? input.provider,
      isCoolingDown: (id) => this.host.isAccountCoolingDown(id),
    });
    const provider = getCliProvider(account.provider);
    const { binaryPath, argsPrefix } = this.host.resolveBinaryForAccount(account);
    const accountBaseEnv = this.host.cliAccounts.envForAccount(account, this.host.env);
    let env: NodeJS.ProcessEnv;
    if (this.host.skipBillingGuard) {
      env = provider.sanitizeEnv(accountBaseEnv);
    } else if (account.provider === "claude") {
      const guard = await runBillingGuard(binaryPath, mode, accountBaseEnv, argsPrefix);
      this.host.setLastAuth(guard.status);
      env = guard.env;
    } else {
      const guard = await provider.checkAuth(binaryPath, accountBaseEnv, argsPrefix);
      env = guard.env;
    }
    const model = resolveModelForProvider({
      provider: account.provider,
      requestedModel: input.model ?? (input.scout === true ? ideaAgentsOf(cfg).scoutModel : undefined),
      accountDefaultModel: account.defaultModel ?? (account.provider === "claude" ? cfg.defaults.model : null),
      available: this.host.modelsForAccount(account, false),
    });
    if (account.provider === "claude") {
      // Background subagents/bash die when the coordinator ends its turn: force every call to be synchronous.
      env = { ...env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };
    }
    return { account, provider, binaryPath, argsPrefix, env, model };
  }

  /** Run id + run dir (a follow-up reuses its parent's), adopted attachments, and the prompt as stored/sent. */
  private async prepareWorkspace(input: StartRunInput, parent: RunRecord | null, readOnly: ReadOnlySpec | null, projectName: string, adoptRunId: string | undefined): Promise<RunWorkspace> {
    const cfg = this.host.config;
    const runId = adoptRunId ?? makeRunId();
    if (adoptRunId) this.host.store.deleteRun(adoptRunId);
    // A role call may continue an earlier run's session; Claude keeps sessions per cwd, so it must reuse that run's dir.
    const sessionSrc = !parent && readOnly && input.resumeSessionOf ? this.host.store.getRun(input.resumeSessionOf) : null;
    const resumeSrc = sessionSrc && sessionSrc.session_id && sessionSrc.run_dir && sessionSrc.project === projectName && fs.existsSync(sessionSrc.run_dir) ? sessionSrc : null;
    const runDir = parent ? parent.run_dir : resumeSrc ? resumeSrc.run_dir : path.join(cfg.workspaceDir, "runs", runId);
    fs.mkdirSync(path.join(runDir, "notes"), { recursive: true });
    // Attachments (5.5): adopt files staged before the run existed, then tell the coordinator where the inbox is.
    if (input.inboxStage) {
      adoptStagedInbox(this.host.stageDir(input.inboxStage), runDir);
      // DXF/STEP files get a readable <name>.cad.json next to them (best effort; needs the CAD Python, see docs/CAD-TOOLS.md).
      await addCadSummaries(path.join(runDir, "inbox"), { configuredPython: cfg.tools?.cad?.python ?? null }).catch(() => []);
    }
    // App-generated prompts (read-only agents such as the splitter / workshop3d roles, and scout) are long: keep the first
    // lines as the visible task and put the whole text in a file the agent reads (stored prompt = the short one).
    let displayPrompt = input.prompt;
    let guidanceRead: string | null = null;
    if (!parent && (readOnly || input.scout === true)) {
      const guidanceFile = path.join(runDir, `instructions-${runId}.md`);
      const guidancePosix = guidanceFile.split(path.sep).join("/");
      const folded = foldPrompt(input.prompt, guidancePosix);
      if (folded.file !== null) {
        fs.writeFileSync(guidanceFile, ["# Chỉ dẫn chi tiết của lệnh", "", folded.file, ""].join("\n"), "utf8");
        displayPrompt = folded.prompt;
        guidanceRead = `Read(${guidancePosix})`;
      }
    }
    const prompt = displayPrompt + inboxPromptNote(runDir);
    const streamFile = path.join(cfg.dataDir, "runs", runId, "stream.jsonl");
    return { runId, runDir, streamFile, resumeSrc, displayPrompt, prompt, guidanceRead };
  }

  /**
   * Worktree of a coding run: the parent's (follow-up), an earlier run's (`reuseWorktreeOf`) or a new one. A failure
   * removes the half-made worktree, records an `error` run and rethrows.
   */
  private async prepareCoding(a: {
    input: StartRunInput;
    parent: RunRecord | null;
    project: ProjectRecord;
    projectName: string;
    kd: KindDefaults;
    runId: string;
    runDir: string;
    mode: AuthMode;
    sessionModel: string;
  }): Promise<CodingContext> {
    const { input, parent, project, projectName, kd, runId, runDir } = a;
    const cfg = this.host.config;
    const repoPath = project.repo_path!;
    const baseBranch = input.baseRef || project.base_branch || "main";
    let created: { worktreePath: string; branch: string } | null = null;
    try {
      let coding: CodingContext;
      if (parent?.worktree_path && parent.branch && parent.base_sha) {
        if (!fs.existsSync(parent.worktree_path)) throw new Error(`Worktree của lần chạy gốc không còn: ${parent.worktree_path}`);
        coding = { project, repoPath, worktreePath: parent.worktree_path, branch: parent.branch, baseSha: parent.base_sha, repoStatusBefore: "", repoHeadBefore: "" };
      } else if (!parent && input.reuseWorktreeOf) {
        // Sequential idea task: continue on the previous task's worktree/branch; diff evidence starts at its current HEAD.
        const prev = this.host.store.getRun(input.reuseWorktreeOf);
        if (!prev || prev.kind !== "coding") throw new Error(`Không tìm thấy run lập trình "${input.reuseWorktreeOf}" để dùng lại worktree.`);
        if (!prev.worktree_path || !prev.branch || !fs.existsSync(prev.worktree_path)) {
          throw new Error(`Worktree của run "${prev.id}" không còn để dùng lại.`);
        }
        const wt = path.resolve(prev.worktree_path).toLowerCase();
        for (const id of this.host.active.keys()) {
          const r = this.host.store.getRun(id);
          if (r?.worktree_path && path.resolve(r.worktree_path).toLowerCase() === wt) {
            throw new Error(`Worktree ${prev.worktree_path} đang được run "${id}" dùng.`);
          }
        }
        const head = runGit(prev.worktree_path, ["rev-parse", "HEAD"]);
        const baseSha = head.code === 0 ? head.stdout.trim() : "";
        if (!baseSha) throw new Error(`Không đọc được HEAD của worktree ${prev.worktree_path}.`);
        coding = { project, repoPath, worktreePath: prev.worktree_path, branch: prev.branch, baseSha, repoStatusBefore: "", repoHeadBefore: "" };
      } else {
        const v = validateRepo(repoPath, baseBranch);
        if (!v.ok) throw new Error(v.error ?? "Repo đích không hợp lệ.");
        const worktreePath = runWorktreePath(cfg.worktreesDir, projectName, runId);
        const branch = runBranchName(projectName, runId);
        const baseSha = await createWorktreeAsync({ repoPath, baseBranch, worktreePath, branch, ...(input.resumeFrom ? { startSha: input.resumeFrom.sha } : {}) });
        created = { worktreePath, branch };
        // Real copy of the repo's node_modules (a junction is unreadable from the agent's sandbox); junction only over the cap.
        const depMerge = mergeDependencyBranchesLenient(worktreePath, input.mergeBranches ?? []);
        const nm = await provisionNodeModules(repoPath, worktreePath, kd.nodeModules ?? DEFAULT_NODE_MODULES, { cacheRoot: path.join(cfg.workspaceDir, "nm-cache") });
        fs.writeFileSync(path.join(runDir, "node-modules.txt"), describeNodeModules(nm), "utf8");
        coding = { project, repoPath, worktreePath, branch, baseSha, repoStatusBefore: "", repoHeadBefore: "", setupEligible: true, setupCopy: null, unmergedDeps: depMerge.failed };
        // Gitignored files (.env, ...) the project asked for; never throws, failures live in setupCopy.error.
        try {
          const setupCfg = this.host.store.getProjectWorktreeSetup(projectName);
          coding.setupCopy = await applySetupCopy({ repoPath, worktreePath, files: setupCfg.files });
        } catch (e) {
          coding.setupCopy = { copied: [], skipped: [], ms: 0, error: e instanceof Error ? e.message : String(e) };
        }
      }
      coding.repoStatusBefore = runGit(repoPath, ["status", "--porcelain"]).stdout;
      coding.repoHeadBefore = runGit(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
      return coding;
    } catch (e) {
      if (created) {
        // Best effort: do not leave a half-prepared worktree and branch behind (run-all would otherwise pile them up).
        try { removeWorktree({ repoPath, worktreePath: created.worktreePath, branch: created.branch }); } catch { /* ignore */ }
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.host.store.createRun({
        id: runId, status: "error", prompt: input.prompt, mode: `${a.mode}+coding`, model: a.sessionModel, session_id: parent?.session_id ?? null,
        parent_run_id: parent?.id ?? null, project: projectName, claude_version: null, run_dir: runDir, kind: "coding",
        forked_from_run_id: input.resumeFrom?.runId ?? input.threadWith ?? null,
      });
      this.host.store.updateRun(runId, { error: `Không chuẩn bị được worktree: ${msg}` });
      this.host.emitUpdated(runId);
      throw new Error(`Không chuẩn bị được worktree: ${msg}`);
    }
  }

  /** Context block (coding only): project memory + bounded repo summaries, for the coordinator and the analyst. */
  private scanContext(coding: CodingContext, kd: KindDefaults, projectName: string, runDir: string): ContextBlock {
    if (!kd.contextScan) return NO_CONTEXT;
    const cfg = this.host.config;
    const ctx = buildContextBlock({
      worktree: coding.worktreePath,
      memoryPath: projectMemoryPath(cfg.dataDir, projectName),
      featuresPath: featuresPath(cfg.dataDir, projectName),
      memoryRoot: path.join(cfg.dataDir, "projects"),
      cfg: kd.contextScan,
      ...(coding.setupCopy?.copied.length ? { exclude: coding.setupCopy.copied } : {}),
    });
    const lines = ctx.loaded.map((f) => `${f.name}\t${f.bytes} bytes`);
    fs.writeFileSync(path.join(runDir, "context-scan.txt"), ctx.loaded.length ? `Khối ngữ cảnh đã nạp (giới hạn ${kd.contextScan.maxBytes} byte):\n${lines.join("\n")}\n` : "Khối ngữ cảnh: không nạp file nào (tắt hoặc không có file).\n", "utf8");
    return ctx;
  }

  /** Write `<dataDir>/runs/<id>/roles.json` (base roles + model overrides + extras + context/library text) and return its path. */
  private writeRolesFile(a: { input: StartRunInput; kd: KindDefaults; kind: RunKind; extras: RunExtras; ctx: ContextBlock; runId: string; runDir: string }): string {
    const { input, kd, kind, extras, ctx, runId, runDir } = a;
    const cfg = this.host.config;
    const overrides = Object.entries(input.roleModels ?? {}).filter(([, m]) => typeof m === "string" && m.trim());
    const roles: Record<string, Record<string, unknown>> = readRoles(kd.agentsFile);
    // Render placeholders of the base role prompts first; user-supplied text (ctx, library, extras) is appended afterwards
    // so `{{...}}` inside a target repo's CLAUDE.md never counts as a leftover placeholder.
    const known = (kd.knownEnvFailures ?? []).map((s) => `- ${s}`).join("\n");
    renderRolePlaceholders(roles, { knownEnvFailures: known });
    // A scout run thinks with the strongest model in every role; explicit per-role choices still win.
    if (input.scout === true) for (const role of Object.keys(roles)) roles[role] = { ...roles[role], model: ideaAgentsOf(cfg).scoutModel };
    for (const [role, model] of overrides) if (roles[role]) roles[role] = { ...roles[role], model: model.trim() };
    for (const [name, def] of Object.entries(extras.extraAgents)) roles[name] = { ...def };
    const analyst = roles["analyst"];
    if (ctx.text && analyst && typeof analyst["prompt"] === "string") roles["analyst"] = { ...analyst, prompt: `${analyst["prompt"]}\n\n${ctx.text}` };
    if (extras.lib) {
      for (const [role, texts] of Object.entries(extras.lib.byRole)) {
        const def = roles[role];
        if (def && typeof def["prompt"] === "string") roles[role] = { ...def, prompt: `${def["prompt"]}\n\n${texts.join("\n\n")}` };
      }
    }
    const ux = applyUxSkill({ roles, prompt: input.prompt, skills: extras.requestedSkills, kind, repoRoot: cfg.repoRoot, runDir });
    if (ux.applied) {
      roles["implementer"] = ux.roles["implementer"]!;
      fs.mkdirSync(path.join(runDir, "notes"), { recursive: true });
      fs.writeFileSync(path.join(runDir, "ux-skill.txt"), `${ux.skillDir}\n`, "utf8");
    }
    const agentsFile = path.join(cfg.dataDir, "runs", runId, "roles.json");
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    fs.writeFileSync(agentsFile, JSON.stringify(roles, null, 2), "utf8");
    return agentsFile;
  }

  /** Allowed/disallowed tools and MCP arguments: grants + project commands for coding, the fixed list for read-only runs. */
  private planTools(a: { input: StartRunInput; kd: KindDefaults; coding: CodingContext | null; readOnly: ReadOnlySpec | null; skills: string[]; runDir: string; streamFile: string; guidanceRead: string | null }): ToolPlan {
    const { input, kd, coding, readOnly, skills, runDir, streamFile } = a;
    let allowedTools = input.allowedTools ?? kd.allowedTools;
    let mcpExtraArgs: string[] = [];
    let grantDisallowed: string[] = [];
    if (coding) {
      const { grants } = this.host.getGrants(coding.project.name);
      allowedTools = buildCodingAllowedTools({ base: allowedTools, projectCommands: coding.project.allowed_commands, worktreePath: coding.worktreePath, runDir, skills, grants });
      const dataDir = this.host.config.dataDir ?? "";
      const cli = readCliSnapshot(dataDir)?.items ?? [];
      const plan = planMcp(grants, [...loadMcpServers(dataDir), ...cliItemsToServers(cli)]);
      const m = mcpRunArgs(plan, grants, path.dirname(streamFile));
      mcpExtraArgs = m.extraArgs;
      grantDisallowed = [...grantsToDisallowedTools(grants, coding.worktreePath), ...m.disallowed];
      for (const t of m.allowed) if (!allowedTools.includes(t)) allowedTools.push(t);
      if (input.scout === true) {
        for (const t of buildScoutWebTools()) if (!allowedTools.includes(t)) allowedTools.push(t);
      }
    } else if (readOnly) {
      allowedTools = [...readOnly.allowedTools];
      if (a.guidanceRead) allowedTools.push(a.guidanceRead);
    } else {
      allowedTools = buildResearchAllowedTools(allowedTools, skills);
    }
    return { allowedTools, disallowedTools: [...new Set([...kd.disallowedTools, ...grantDisallowed])], mcpExtraArgs };
  }

  /** Register the runner as active and wire its stream events and exit to the store. */
  private attachRunner(runner: CliRunner, x: ExitContext): void {
    const { runId, runDir, coding } = x;
    this.host.active.set(runId, runner);
    let stderrTail = "";
    runner.on("stderr", (s: string) => {
      stderrTail = (stderrTail + s).slice(-2000);
    });
    const notesWritten = new Map<string, number>();
    runner.on("event", (ev: NormalizedEvent) => {
      try {
        this.host.onEvent(runId, runner, ev, coding ? { runDir, notesWritten } : null);
      } catch (e) {
        // The DB is closed (server shutting down) while a child still streams: drop the event instead of crashing the process.
        if ((e as { code?: string })?.code === "ERR_INVALID_STATE") return;
        throw e;
      }
    });
    runner.on("exit", () => {
      this.host.active.delete(runId);
      try {
        this.handleExit(runner, x, stderrTail);
      } catch (e) {
        // DB already closed (server shutting down): nothing left to record.
        if ((e as { code?: string })?.code === "ERR_INVALID_STATE") return;
        throw e;
      }
    });
  }

  /** Close the run row, collect evidence, then let quota failover/resume, the queue and the wait list react. */
  private handleExit(runner: CliRunner, x: ExitContext, stderrTail: string): void {
    const { runId, runDir, streamFile, projectName, coding, readOnly } = x;
    const cur = this.host.store.getRun(runId);
    if (cur && cur.status === "running") {
      this.host.store.updateRun(runId, { status: "error", error: stderrTail.trim() || "Tiến trình kết thúc không rõ lý do." });
    } else if (cur && cur.status === "error" && !cur.error && stderrTail.trim()) {
      this.host.store.updateRun(runId, { error: stderrTail.trim() });
    }
    // Always persist account cooldown on quota errors (even without session_id or when quota auto-resume is off).
    const hitQuota = this.host.recordQuotaCooldownIfNeeded(runId);
    // A run stopped by the usage limit either fails over immediately to a backup CLI account or waits for the reset.
    let held = false;
    if (coding) {
      this.finishCoding(runId, runDir, coding, runner);
      held = (hitQuota && this.host.maybeImmediateQuotaFailover(runId, false)) || this.host.tryQuotaResume(runId);
      if (!held) this.host.syncQueueOnExit(runId, projectName);
    } else {
      salvageSubagentOutputs(runDir, [...runner.parser.agents.values()]);
      saveFinalAnswerAsReport(runDir, this.host.store.getRun(runId)?.result_text ?? null);
      held = (hitQuota && this.host.maybeImmediateQuotaFailover(runId, readOnly)) || this.host.tryQuotaResume(runId);
      // Queue commands of kind "research" run read-only; most read-only runs (splitter, scout...) match no command.
      if (!held && readOnly && projectName !== "default") this.host.syncQueueOnExit(runId, projectName);
    }
    try { fs.rmSync(path.join(path.dirname(streamFile), "mcp.json"), { force: true }); } catch { /* best effort: holds plaintext connector secrets */ }
    this.host.store.scanArtifacts(runId, runDir);
    // Read-only runs are internal helpers (workshop3d roles, idea splitter, scope guard...): their logs would flood the output folder.
    // "Mo tep" (openOutput) still mirrors on demand.
    if (!readOnly) this.host.syncOutputs(runId);
    this.host.store.updateRun(runId, { agents: [...runner.parser.agents.values()] });
    this.host.emitUpdated(runId);
    if (!held) this.host.maybeAutoResume(runId);
    this.host.forgetScope(runId);
    if (coding) void this.host.drainWaiting();
    // Any coding run ending frees a slot / may unlock a command: let the run-all orchestrator continue.
    if (coding) void this.host.queueRunAllIfStarted()?.tickAll();
  }

  /** SPEC §3.2 step 4: controller-side evidence after a coding run (independent of what the agents claimed). */
  private finishCoding(runId: string, runDir: string, c: CodingContext, runner: CliRunner): void {
    try {
      const vcs = collectPostRun({ worktreePath: c.worktreePath, baseSha: c.baseSha, repoPath: c.repoPath, repoStatusBefore: c.repoStatusBefore, repoHeadBefore: c.repoHeadBefore, outDir: runDir });
      this.host.store.updateRun(runId, { commits: vcs.commits, changed_files: vcs.changed_files });
      if (vcs.repo_root_changed) {
        const cur = this.host.store.getRun(runId);
        const warn = "CẢNH BÁO: repo gốc thay đổi trong lúc run (xem repo-check.txt).";
        this.host.store.updateRun(runId, { error: cur?.error ? `${cur.error} · ${warn}` : warn });
      }
    } catch (e) {
      fs.writeFileSync(path.join(runDir, "repo-check.txt"), `Không thu được bằng chứng git: ${e instanceof Error ? e.message : String(e)}\n`, "utf8");
    }
    try {
      this.host.precheckMerge(runId);
    } catch (e) {
      console.warn(`[precheck] không kiểm tra gộp được cho run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const t = runner.parser.lastTestOutput;
    const body = t
      ? `# Lần chạy test cuối (${t.ok ? "thành công" : "thất bại / bị từ chối"})\n$ ${t.command}\n\n${t.text}\n`
      : "Không tìm thấy lần chạy test nào trong stream (không có lệnh Bash npm test / vitest / node --test được chạy).\n";
    fs.writeFileSync(path.join(runDir, "test-result.txt"), body, "utf8");
  }
}
