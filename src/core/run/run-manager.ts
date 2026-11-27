import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { runBillingGuard, sanitizeEnv, type AuthStatus } from "./billing-guard.js";
import { readClaudeVersion } from "../app/version.js";
import { prepareCommentsFollowup } from "./diff-comments.js";
import { locateClaude } from "./claude-locator.js";
import { CliAccountStore } from "./cli-accounts.js";
import { AccountRuntime } from "./account-runtime.js";
import type { CliRunner } from "./providers/types.js";
import { QUEUE_MAX_PARALLEL_CEILING, type AuthMode, type ControllerConfig } from "../app/config.js";
import type { NormalizedEvent } from "./events.js";
import { isCommitOnBranch, isFullCommitSha, validateRepo, type RepoValidation } from "../git/git.js";
import { applyTuning, clampMaxRuns, currentTuning, loadAppSettings, sanitizeRoleAccounts, saveAppSettings, validateTuning, type FullTuning } from "../app/app-settings.js";
import { sanitizeGrants, type Grants } from "./grants.js";
import type { PreviewConfig } from "../preview/preview-config.js";
import type { PreviewDeps } from "../preview/preview.js";
import { ConnectionStore } from "../app/api-connections.js";
import type { CliAccountPublic, CliAccountRuntimeStatus, CliModelChoice, CliProviderId, QuotaResumeRecord, RoleAccountMap } from "../shared-types.js";
import { validateInboxName } from "./inbox.js";
import { WebhookNotifier } from "../queue/webhook.js";
import { AutopilotState } from "../queue/autopilot-state.js";
import { RoleLibrary } from "../roles/role-library.js";
import { QueueStore } from "../queue/queue-store.js";
import { QueueRunAll } from "../queue/queue-runner.js";
import { PROMPT_TEMPLATES } from "../roles/prompt-templates.js";
import { validateAllowedCommand } from "./permissions.js";
import { RunStore, type MergePrecheck, type ProjectRecord, type RunRecord } from "./run-store.js";
import { normalizeProject, readRoles, type StartRunInput } from "./run-input.js";
import { CommentsError, type OpenDirTarget, type PreviewState } from "./run-support.js";
import type { LaunchOptions, QueueCommandRef, RateLimitSnapshot, RunHost } from "./run-host.js";
import { RunWaitList } from "./run-wait-list.js";
import { RunLauncher } from "./run-launch.js";
import { QueueRuns } from "./queue-runs.js";
import { ResumeScheduler } from "./resume-scheduler.js";
import { RunPreviews } from "./run-previews.js";
import { RunOutputs } from "./run-outputs.js";
import { RunRelease } from "./run-release.js";
import { RunEventSink } from "./run-event-sink.js";

export * from "./run-input.js";
export * from "./run-support.js";
export { AUTO_RESUME_MARK } from "./resume-scheduler.js";

export interface ManagerOptions {
  config: ControllerConfig;
  store: RunStore;
  /** Test hook: spawn this executable instead of the located claude. */
  claudePath?: string;
  claudeArgsPrefix?: string[];
  /** Test hook: skip `claude auth status`. */
  skipBillingGuard?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Test hook: how "open in Explorer" opens a directory (default: spawn explorer.exe without a shell). */
  openDirectory?: (dir: string) => void;
  /** Test hook: fetch used for webhook notifications. */
  webhookFetch?: typeof fetch;
  /** Test hook: how output files/folders are opened (default: Explorer, optionally selecting a file). */
  openPath?: (a: { dir: string; select?: string }) => void;
  /** Test hook: replaces the real process/browser dependencies of "Xem trước". */
  previewDeps?: PreviewDeps;
}

/**
 * Orchestrates runs: billing guard → (coding: worktree) → run dir → ClaudeRunner → store + broadcast.
 * Events: "event" ({run_id, stored: StoredEvent}), "run.updated" (RunRecord), "rate.limit", "quota.resume".
 *
 * This class is the public facade (server routes, CLI and tests call it) and owns the shared state: the active
 * runners, the lazily created stores and the settings. The work itself lives in the collaborators below, which reach
 * back only through `RunHost`.
 */
export class RunManager extends EventEmitter {
  private readonly active = new Map<string, CliRunner>();
  private claudePathCache: string | null = null;
  private claudeVersionCache: string | null | undefined = undefined;
  private cliAccountStoreCache: CliAccountStore | null = null;
  lastAuth: AuthStatus | null = null;
  /** Latest subscription rate-limit snapshot seen in any run's stream (V14). Kept in RAM; restored from the newest stored rate.limit event at startup. */
  lastRateLimit: RateLimitSnapshot | null = null;

  private readonly host: RunHost = this.buildHost();
  private readonly waitList = new RunWaitList(this.host);
  private readonly launcher = new RunLauncher(this.host);
  private readonly queueRuns = new QueueRuns(this.host);
  private readonly resumes = new ResumeScheduler(this.host);
  private readonly previewer = new RunPreviews(this.host);
  private readonly outputs = new RunOutputs(this.host);
  private readonly release = new RunRelease(this.host);
  private readonly eventSink = new RunEventSink(this.host);

  constructor(private readonly opts: ManagerOptions) {
    super();
    // App-wide cap on coding runs (Settings): the saved value overrides controller.json's queue.maxParallel.
    const savedSettings = loadAppSettings(opts.config.dataDir ?? "");
    const saved = savedSettings.maxRuns;
    if (saved !== undefined && opts.config.queue) opts.config.queue.maxParallel = saved;
    // Same for the "Điều chỉnh" tab: saved values override controller.json (costs, models, idea agents).
    if (savedSettings.tuning) applyTuning(opts.config, savedSettings.tuning);
    // The waiting list lives in memory: rows left "queued" by a previous server process can never start.
    try {
      for (const r of this.store.listRuns({ status: "queued", limit: 500 })) {
        this.store.updateRun(r.id, { status: "cancelled", error: "Máy chủ khởi động lại khi lệnh đang chờ chỗ chạy; hãy chạy lại." });
      }
    } catch {
      /* best-effort */
    }
    try {
      this.lastRateLimit = this.store.latestRateLimitEvent();
    } catch {
      /* best-effort */
    }
    try {
      this.restoreQuotaResumes();
    } catch {
      /* best-effort */
    }
    try {
      this.reconcileOrphanRuns();
    } catch {
      /* best-effort */
    }
  }

  /**
   * Startup reconciliation: a process that was killed leaves runs "running" in SQLite and queue commands "đang chạy"
   * with no live run behind them (nothing is active yet in a fresh process). Close those runs as errors and let the
   * queue sync move each command to "đã commit" (it has commits) or "lỗi" (with the reason), so run-all can go on.
   * Runs waiting for a quota resume are left alone. Returns the closed run ids.
   */
  reconcileOrphanRuns(): string[] {
    const held = new Set(this.store.listQuotaResumes("pending").map((r) => r.run_id));
    const closed: { id: string; project: string }[] = [];
    for (const r of this.store.listRuns({ status: "running", limit: 1000 })) {
      if (this.active.has(r.id) || held.has(r.id)) continue;
      this.store.updateRun(r.id, { status: "error", error: "Máy chủ khởi động lại khi run đang chạy; run không còn tiến trình." });
      closed.push({ id: r.id, project: r.project });
    }
    for (const c of closed) this.syncQueueOnExit(c.id, c.project);
    return closed.map((c) => c.id);
  }

  /** See RunHost: every member is looked up on the manager when it is used, never captured at construction. */
  private buildHost(): RunHost {
    const self = this;
    return {
      get config() { return self.opts.config; },
      get store() { return self.opts.store; },
      get env() { return self.opts.env ?? process.env; },
      get skipBillingGuard() { return self.opts.skipBillingGuard === true; },
      get previewDeps() { return self.opts.previewDeps; },
      get openDirectory() { return self.opts.openDirectory; },
      get openPath() { return self.opts.openPath; },
      get active() { return self.active; },
      get queue() { return self.queue; },
      get queueRunAll() { return self.queueRunAll; },
      queueRunAllIfStarted: () => self.queueRunAllCache,
      get cliAccounts() { return self.cliAccounts; },
      get library() { return self.library; },
      get lastRateLimit() { return self.lastRateLimit; },
      set lastRateLimit(v) { self.lastRateLimit = v; },
      setLastAuth: (status) => { self.lastAuth = status; },
      emit: (event, payload) => self.emit(event, payload),
      emitUpdated: (runId) => self.emitUpdated(runId),
      notifyWebhook: (runId) => self.notifyWebhook(runId),
      startRun: (input) => self.startRun(input),
      followup: (parentRunId, prompt, overrides) => (overrides === undefined ? self.followup(parentRunId, prompt) : self.followup(parentRunId, prompt, overrides)),
      waitFor: (runId) => self.waitFor(runId),
      launch: (input, parent, opts) => self.launch(input, parent, opts),
      launchNow: (input, parent, opts) => self.launcher.launchNow(input, parent, opts),
      startQueuedCommand: (project, commandId) => self.startQueuedCommand(project, commandId),
      drainWaiting: () => self.drainWaiting(),
      forgetScope: (runId) => self.waitList.forgetScope(runId),
      codingActiveCount: () => self.codingActiveCount(),
      maxRuns: () => self.maxRuns(),
      getGrants: (project) => self.getGrants(project),
      outputDir: () => self.outputDir(),
      syncOutputs: (runId) => self.syncOutputs(runId),
      stageDir: (stageId) => self.stageDir(stageId),
      worktreeExists: (run) => self.worktreeExists(run),
      precheckMerge: (runId) => self.precheckMerge(runId),
      isAccountCoolingDown: (accountId) => self.isAccountCoolingDown(accountId),
      markAccountCooldown: (accountId, untilMs) => self.markAccountCooldown(accountId, untilMs),
      resolveBinaryForAccount: (account) => self.resolveBinaryForAccount(account),
      modelsForAccount: (account, refresh) => self.modelsForAccount(account, refresh),
      queueRunIndex: (project) => self.queueRunIndex(project),
      queueChainRunIds: (cmd, index) => self.queueChainRunIds(cmd, index),
      syncQueueOnExit: (runId, project) => self.syncQueueOnExit(runId, project),
      onEvent: (runId, runner, ev, coding) => self.onEvent(runId, runner, ev, coding),
      noteQuotaReset: (runId, resetAtMs) => { self.resumes.quotaResetAt.set(runId, resetAtMs); },
      recordQuotaCooldownIfNeeded: (runId) => self.recordQuotaCooldownIfNeeded(runId),
      maybeImmediateQuotaFailover: (runId, isReadOnly) => self.maybeImmediateQuotaFailover(runId, isReadOnly),
      tryQuotaResume: (runId) => self.tryQuotaResume(runId),
      maybeAutoResume: (runId) => self.resumes.maybeAutoResume(runId),
    };
  }

  /** Most coding runs allowed at once in the whole app (Settings -> "Lệnh run tối đa"). */
  maxRuns(): number {
    return clampMaxRuns(this.opts.config.queue?.maxParallel) ?? 2;
  }

  /** Change and persist the cap; waiting runs start right away when it was raised. */
  setMaxRuns(n: number): number {
    const v = clampMaxRuns(n);
    if (v === null) throw new Error("Số lệnh run tối đa phải là số từ 1 đến " + QUEUE_MAX_PARALLEL_CEILING + ".");
    saveAppSettings(this.opts.config.dataDir, { maxRuns: v });
    this.opts.config.queue.maxParallel = v;
    void this.drainWaiting();
    return v;
  }

  /** Effective grants for an environment (project ticks, else the app default profile, else the built-in default). */
  getGrants(project: string | null): { grants: Grants; source: "project" | "default" | "builtin" } {
    const own = project ? this.store.getProjectGrants(project) : null;
    if (own) return { grants: own, source: "project" };
    const def = loadAppSettings(this.opts.config.dataDir).defaultGrants;
    return def ? { grants: def, source: "default" } : { grants: sanitizeGrants({}), source: "builtin" };
  }

  /** Save ticks for one environment, or the default profile when `project` is "__default__". Extra dirs must exist. */
  setGrants(project: string, raw: unknown): Grants {
    const g = sanitizeGrants(raw);
    for (const d of g.extraDirs) {
      if (!fs.existsSync(d.path) || !fs.statSync(d.path).isDirectory()) throw new Error(`Thư mục không tồn tại: ${d.path}`);
    }
    if (project === "__default__") saveAppSettings(this.opts.config.dataDir, { defaultGrants: g });
    else {
      if (!this.store.getProject(project)) throw new Error("Không tìm thấy môi trường.");
      this.store.setProjectGrants(project, g);
    }
    return g;
  }

  // ---- "Xem trước" (RunPreviews)

  getPreviewConfig(project: string): PreviewConfig {
    return this.previewer.getPreviewConfig(project);
  }

  setPreviewConfig(project: string, raw: unknown): PreviewConfig {
    return this.previewer.setPreviewConfig(project, raw);
  }

  /** Start a background capture of the run's worktree (web) or desktop app; throws PreviewError when it cannot start. */
  startPreview(runId: string, opts: { viaTunnel: boolean }): PreviewState {
    return this.previewer.startPreview(runId, opts);
  }

  getPreviewState(runId: string): PreviewState {
    return this.previewer.getPreviewState(runId);
  }

  /** Absolute path of a captured PNG of this run, or null (name must be a plain *.png file name inside the preview folder). */
  previewFile(runId: string, file: string): string | null {
    return this.previewer.previewFile(runId, file);
  }

  /** Values of the "Điều chỉnh" settings tab in force right now. */
  tuning(): FullTuning {
    return currentTuning(this.opts.config);
  }

  /** Unified list of models for Tuning / Settings UI (Claude Code CLI). */
  allAvailableModels(): { id: string; label: string; provider?: CliProviderId }[] {
    const out: { id: string; label: string; provider?: CliProviderId }[] = [];
    const seen = new Set<string>();
    const add = (id: string, label: string, provider: CliProviderId) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, label, provider });
    };
    for (const m of this.opts.config.models) add(m.id, m.label, "claude");
    for (const acc of this.cliAccounts.list()) {
      for (const m of this.modelsForAccount(acc, false)) add(m.id, m.label, acc.provider);
    }
    return out;
  }

  /** Validate, apply live and persist a partial change; throws Error(Vietnamese message) when invalid. */
  setTuning(body: unknown): FullTuning {
    const check = validateTuning(body, this.opts.config, this.allAvailableModels().map((m) => m.id));
    if (!check.ok) throw new Error(check.message);
    saveAppSettings(this.opts.config.dataDir, { tuning: check.patch });
    applyTuning(this.opts.config, check.patch);
    return this.tuning();
  }

  // ---- Wait list and slot admission (RunWaitList)

  /** Runs/commands waiting for a free slot, oldest first (for the UI). */
  waitingList(): { kind: "run" | "queue"; id: string; project: string; reason?: string }[] {
    return this.waitList.waitingList();
  }

  /** Why a queued run is held back (scope guard), or undefined (just waiting for a free slot). */
  waitReason(runId: string): string | undefined {
    return this.waitList.waitReason(runId);
  }

  /** Queue command approved while every slot is busy: it starts by itself, in order, when a slot frees. */
  enqueueQueuedCommand(project: string, id: string): void {
    this.waitList.enqueueQueuedCommand(project, id);
  }

  /** Start waiting items, oldest first, while slots are free. Called whenever a coding run ends or the cap grows. */
  drainWaiting(): Promise<void> {
    return this.waitList.drainWaiting();
  }

  /** Entry point of every run: a new coding run with no free slot becomes a "queued" row and starts later. */
  private launch(input: StartRunInput, parent: RunRecord | null, opts: LaunchOptions = {}): Promise<RunRecord> {
    return this.waitList.launch(input, parent, opts);
  }

  get config(): ControllerConfig {
    return this.opts.config;
  }
  private autopilotCache: AutopilotState | null = null;
  /** In-memory autopilot state, initialised lazily from `config.automation`. */
  get autopilot(): AutopilotState {
    if (!this.autopilotCache) {
      const saved = loadAppSettings(this.opts.config.dataDir ?? "").autopilotPruneDone;
      const cfg = this.opts.config.automation;
      this.autopilotCache = new AutopilotState(saved && cfg ? { ...cfg, pruneDone: saved } : cfg);
    }
    return this.autopilotCache;
  }
  /** Replace the webhook list; drops the cached notifier so the new URLs apply immediately. */
  /** Validates, applies and persists (app-settings.json) the auto-delete-merged-commands setting. */
  setPruneDone(enabled: unknown, keepDays: unknown, branches?: unknown): void {
    this.autopilot.setPruneDone(enabled, keepDays, branches);
    saveAppSettings(this.opts.config.dataDir, { autopilotPruneDone: this.autopilot.snapshot().pruneDone });
  }

  setWebhooks(urls: unknown): void {
    this.autopilot.setWebhooks(urls);
    this.webhookCache = null;
  }
  private webhookCache: WebhookNotifier | null = null;
  /** Lazy notifier over the autopilot webhook list (empty list = no-op; does not depend on `enabled`). */
  get webhooks(): WebhookNotifier {
    if (!this.webhookCache) {
      this.webhookCache = new WebhookNotifier({
        urls: this.autopilot.snapshot().webhooks,
        ...(this.opts.webhookFetch ? { fetchImpl: this.opts.webhookFetch } : {}),
      });
    }
    return this.webhookCache;
  }
  private notifyWebhook(runId: string): void {
    try {
      if (!this.autopilot.snapshot().webhooks.length) return;
      const r =this.store.getRun(runId);
      if (!r || (r.status !== "done" && r.status !== "error")) return;
      void this.webhooks
        .runFinished({ id: r.id, status: r.status, prompt: r.prompt, project: r.project, duration_ms: r.duration_ms, error: r.error })
        .catch(() => undefined);
    } catch {
      /* webhook problems must never affect a run */
    }
  }
  private libraryCache: RoleLibrary | null = null;
  /** Global role/skill/prompt library (`<dataDir>/library`). Built-in role names are read lazily from the roles files. */
  private connectionStoreCache: ConnectionStore | null = null;
  /** API connections of the third tower (one floor each). */
  get connections(): ConnectionStore {
    if (!this.connectionStoreCache) this.connectionStoreCache = new ConnectionStore(this.opts.config.dataDir);
    return this.connectionStoreCache;
  }

  get library(): RoleLibrary {
    if (!this.libraryCache) {
      const d = this.opts.config.defaults;
      this.libraryCache = new RoleLibrary(path.join(this.opts.config.dataDir, "library"), () =>
        [...new Set([d.coding.agentsFile, d.research.agentsFile, d.agentsFile].flatMap((f) => Object.keys(readRoles(f))))]);
      try {
        this.libraryCache.seedTemplates(PROMPT_TEMPLATES);
      } catch {
        /* seeding must never break a run */
      }
    }
    return this.libraryCache;
  }
  get store(): RunStore {
    return this.opts.store;
  }
  /** Environment used for child processes (tests inject a restricted one). */
  get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  /** Path of the claude executable for helper commands (`claude mcp list`); same locator and cache as runs. */
  claudePathForTools(): string {
    return this.resolveClaude();
  }

  resolveClaude(): string {
    if (this.opts.claudePath) return this.opts.claudePath;
    if (!this.claudePathCache) this.claudePathCache = locateClaude(this.opts.config.claudePath, this.opts.env ?? process.env);
    return this.claudePathCache;
  }

  /** `claude --version` of the resolved CLI (cached; null when it cannot be read). Throws when the CLI is not found. */
  claudeVersion(): string | null {
    if (this.claudeVersionCache === undefined) {
      const env = sanitizeEnv(this.opts.env ?? process.env, this.opts.config.defaults.authMode);
      this.claudeVersionCache = readClaudeVersion(this.resolveClaude(), env, this.opts.claudeArgsPrefix ?? []);
    }
    return this.claudeVersionCache;
  }

  async authStatus(mode: AuthMode = this.opts.config.defaults.authMode): Promise<AuthStatus> {
    const { status } = await runBillingGuard(this.resolveClaude(), mode, this.opts.env ?? process.env, this.opts.claudeArgsPrefix ?? []);
    this.lastAuth = status;
    return status;
  }

  /** Persistent store for CLI accounts (`<dataDir>/cli-accounts.json`). */
  get cliAccounts(): CliAccountStore {
    if (!this.cliAccountStoreCache) this.cliAccountStoreCache = new CliAccountStore(this.opts.config.dataDir);
    return this.cliAccountStoreCache;
  }

  private accountRuntimeCache: AccountRuntime | null = null;
  private get accountRuntime(): AccountRuntime {
    return (this.accountRuntimeCache ??= new AccountRuntime(this.opts, () => this.cliAccounts));
  }

  isAccountCoolingDown(accountId: string, now = Date.now()): boolean {
    return this.accountRuntime.isAccountCoolingDown(accountId, now);
  }

  getAccountCooldownUntil(accountId: string, now = Date.now()): number | null {
    return this.accountRuntime.getAccountCooldownUntil(accountId, now);
  }

  markAccountCooldown(accountId: string, untilMs: number): void {
    this.accountRuntime.markAccountCooldown(accountId, untilMs);
  }

  clearAccountCooldown(accountId: string): boolean {
    return this.accountRuntime.clearAccountCooldown(accountId);
  }

  resolveBinaryForAccount(account: CliAccountPublic): { binaryPath: string; argsPrefix: string[] } {
    return this.accountRuntime.resolveBinaryForAccount(account);
  }

  modelsForAccount(account: CliAccountPublic, refresh = false): CliModelChoice[] {
    return this.accountRuntime.modelsForAccount(account, refresh);
  }

  checkAccountStatus(accountId: string, refreshModels = true): Promise<CliAccountRuntimeStatus> {
    return this.accountRuntime.checkAccountStatus(accountId, refreshModels);
  }

  getRoleAccounts(): RoleAccountMap {
    return loadAppSettings(this.opts.config.dataDir).roleAccounts ?? {};
  }

  setRoleAccounts(raw: unknown): RoleAccountMap {
    const clean = sanitizeRoleAccounts(raw);
    for (const [role, entry] of Object.entries(clean)) {
      if (entry.accountId && !this.cliAccounts.get(entry.accountId)) {
        throw new Error(`Vai "${role}" trỏ tới tài khoản CLI không tồn tại: "${entry.accountId}".`);
      }
    }
    saveAppSettings(this.opts.config.dataDir, { roleAccounts: clean });
    return clean;
  }

  /** Resolve account + optional model override for a controller-orchestrated role (Level B / Level D). */
  resolveRoleAssignment(role: string, fallbackAccountId?: string | null): { accountId?: string; model?: string } {
    const map = this.getRoleAccounts();
    const entry = map[role];
    const accountId = entry?.accountId ?? fallbackAccountId ?? undefined;
    const model = entry?.model ?? undefined;
    return { ...(accountId ? { accountId } : {}), ...(model ? { model } : {}) };
  }

  setProjectAccount(project: string, accountId: string | null): string | null {
    if (!this.store.getProject(project)) throw new Error("Không tìm thấy môi trường.");
    if (accountId) {
      const acc = this.cliAccounts.get(accountId);
      if (!acc) throw new Error(`Không tìm thấy tài khoản CLI "${accountId}".`);
    }
    this.store.setProjectAccount(project, accountId);
    return accountId;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** How many runs this server is executing right now (in memory, so a zombie "running" row in the DB is not counted). */
  activeCount(): number {
    return this.active.size;
  }

  /** SPEC §8: check a repo path + base branch without creating anything. */
  validateProject(repoPath: string, baseBranch: string): RepoValidation {
    return validateRepo(repoPath, baseBranch);
  }

  /** Create/update a project after validating repo, branch and allowed_commands. Throws with a Vietnamese message. */
  addProject(input: { name: string; repo_path: string | null; base_branch?: string | null; allowed_commands?: string[] }): ProjectRecord {
    const name = normalizeProject(input.name);
    if (name === "__default__") throw new Error('Tên "__default__" dành riêng cho hồ sơ quyền mặc định; hãy đặt tên khác.');
    if (name === "default" && input.repo_path) throw new Error('Tên project "default" dành cho nhãn mặc định; hãy đặt tên khác.');
    const cmds = (input.allowed_commands ?? []).map((c) => c.trim()).filter(Boolean);
    for (const c of cmds) {
      const err = validateAllowedCommand(c);
      if (err) throw new Error(`allowed_commands không hợp lệ: ${err}`);
    }
    let repoPath: string | null = null;
    let base: string | null = null;
    if (input.repo_path) {
      repoPath = path.resolve(input.repo_path);
      base = (input.base_branch ?? "main").trim() || "main";
      const v = validateRepo(repoPath, base);
      if (!v.ok) throw new Error(v.error ?? "Repo không hợp lệ.");
      const dataDir = path.resolve(this.opts.config.dataDir) + path.sep;
      if ((repoPath + path.sep).startsWith(dataDir)) throw new Error("Repo đích không được nằm trong thư mục data/ của controller.");
    }
    return this.store.upsertProject({ name, repo_path: repoPath, base_branch: base, allowed_commands: cmds });
  }

  async startRun(input: StartRunInput): Promise<RunRecord> {
    return this.launch(input, null);
  }

  private queueStoreCache: QueueStore | null = null;
  /** Planner queue store (`<dataDir>/projects/<name>/queue.json`); created lazily so plain runs never touch it. */
  get queue(): QueueStore {
    if (!this.queueStoreCache) this.queueStoreCache = new QueueStore(this.opts.config.dataDir);
    return this.queueStoreCache;
  }
  private queueRunAllCache: QueueRunAll | null = null;
  /** "Run all" orchestrator (in-memory state, lost on restart). */
  get queueRunAll(): QueueRunAll {
    if (!this.queueRunAllCache) {
      this.queueRunAllCache = new QueueRunAll({
        list: (p) => this.queue.list(p),
        codingRunningTotal: () => this.codingActiveCount(),
        start: (p, id, ref) => this.startQueuedCommand(p, id, { unlockMode: "runAll", ...(ref ? { ideaRef: ref } : {}) }),
        hotspots: () => this.opts.config.queue.hotspots,
        maxParallel: () => this.opts.config.queue.maxParallel,
        requeue: (p, id) => void this.queue.transition(p, id, "đã duyệt"),
        maxRetries: this.opts.config.automation?.maxRetries ?? 2,
        onFinish: (p, s) => {
          if (!this.autopilot.snapshot().webhooks.length) return;
          return this.webhooks.queueCompleted(p, s);
        },
      });
    }
    return this.queueRunAllCache;
  }

  /** Coding runs really running (in `active`) plus queued commands being launched; DB rows left "running" by a crash are not counted. */
  codingActiveCount(): number {
    let n = 0;
    for (const id of this.active.keys()) if (this.store.getRun(id)?.kind === "coding") n++;
    return n + this.queueRuns.startingCount + this.waitList.reservedSlots.size;
  }

  // ---- Runs of the planner queue (QueueRuns)

  /** parent -> children map of a project's runs (one light query); pass it to queueChainRunIds / isQueueRunLive when describing many commands. */
  queueRunIndex(project: string): Map<string, string[]> {
    return this.queueRuns.queueRunIndex(project);
  }

  /** Run ids of a command's chain: its own run plus follow-up descendants (via parent_run_id) in the same project. */
  queueChainRunIds(cmd: QueueCommandRef, index?: Map<string, string[]>): string[] {
    return this.queueRuns.queueChainRunIds(cmd, index);
  }

  /** True when any run in the command's chain is really running in this process. */
  isQueueRunLive(cmd: QueueCommandRef, index?: Map<string, string[]>): boolean {
    return this.queueRuns.isQueueRunLive(cmd, index);
  }

  /** Manual confirmation: close chain runs left "running" in the DB (not live) as error. Returns closed run ids. */
  closeOrphanQueueRuns(cmd: QueueCommandRef): string[] {
    return this.queueRuns.closeOrphanQueueRuns(cmd);
  }

  /** Start an approved queue command as a run; throws Vietnamese errors when it is missing, not approved, locked, or no slot is free. */
  startQueuedCommand(
    project: string,
    commandId: string,
    opts: { baseRef?: string; parallelCap?: number; unlockMode?: "runAll"; ideaRef?: string } = {},
  ): Promise<RunRecord> {
    return this.queueRuns.startQueuedCommand(project, commandId, opts);
  }

  /** Lesson line in lessons.md for a failed queue command (queue.lessons on). Never throws. */
  recordQueueLesson(project: string, cmd: { id: string; title: string; ideaTitle?: string; files?: string[]; verify?: string }, reason: string): void {
    this.queueRuns.recordQueueLesson(project, cmd, reason);
  }

  /** After a queue command's run ends: move it to "đã commit"/"đã gộp" or "lỗi". Never throws. */
  private syncQueueOnExit(runId: string, project: string): void {
    this.queueRuns.syncQueueOnExit(runId, project);
  }

  // ---- Quota appointments and automatic continuation (ResumeScheduler)

  // The private members of this section are not called inside the class: the scheduler reaches them through RunHost,
  // and the quota tests drive them directly on the manager.

  /** Appointments by run id (scheduler state). */
  private get quotaResumes(): Map<string, QuotaResumeRecord> {
    return this.resumes.quotaResumes;
  }

  /** 5h reset time (epoch ms) seen per run while rate-limited. */
  private get quotaResetAt(): Map<string, number> {
    return this.resumes.quotaResetAt;
  }

  private recordQuotaCooldownIfNeeded(runId: string): boolean {
    return this.resumes.recordQuotaCooldownIfNeeded(runId);
  }

  private maybeImmediateQuotaFailover(runId: string, isReadOnly: boolean): boolean {
    return this.resumes.maybeImmediateQuotaFailover(runId, isReadOnly);
  }

  private tryQuotaResume(runId: string): boolean {
    return this.resumes.tryQuotaResume(runId);
  }

  private maybeQuotaResume(runId: string): boolean {
    return this.resumes.maybeQuotaResume(runId);
  }

  private fireQuotaResume(runId: string): Promise<void> {
    return this.resumes.fireQuotaResume(runId);
  }

  /** Appointments after a server restart: re-arm the pending rows of the store. Returns how many were re-armed. */
  restoreQuotaResumes(): number {
    return this.resumes.restoreQuotaResumes();
  }

  getQuotaResume(runId: string): QuotaResumeRecord | null {
    return this.resumes.getQuotaResume(runId);
  }

  /** Only appointments still waiting. */
  listQuotaResumes(): QuotaResumeRecord[] {
    return this.resumes.listQuotaResumes();
  }

  /** Cancel a pending appointment; a held queue command is marked failed and run-all is stopped. */
  cancelQuotaResume(runId: string): boolean {
    return this.resumes.cancelQuotaResume(runId);
  }

  /** Follow-up built from line comments on the parent's diff; comments go only into the prompt (stdin). */
  async followupWithComments(parentRunId: string, comments: unknown, overrides: Omit<StartRunInput, "prompt"> = {}): Promise<RunRecord> {
    const parent = this.store.getRun(parentRunId);
    if (!parent) throw new Error("Không tìm thấy lần chạy gốc.");
    const prep = prepareCommentsFollowup(parent.run_dir, parent.kind, comments);
    if (!prep.ok) throw new CommentsError(prep.message);
    return this.followup(parentRunId, prep.prompt, overrides);
  }

  /** Follow-up question on the same session (`--resume`), in the same run directory (and worktree for coding). */
  async followup(parentRunId: string, prompt: string, overrides: Omit<StartRunInput, "prompt"> = {}): Promise<RunRecord> {
    const parent = this.store.getRun(parentRunId);
    if (!parent) throw new Error("Không tìm thấy lần chạy gốc.");
    if (!parent.session_id) throw new Error("Lần chạy gốc không có session_id nên không thể hỏi tiếp.");
    if (this.active.has(parentRunId)) throw new Error("Lần chạy gốc vẫn đang chạy; hãy chờ xong hoặc hủy trước.");
    return this.launch({ prompt, ...overrides }, parent);
  }

  /** New coding run (fresh session, new worktree/branch) starting at commit `sha` of an earlier coding run's branch. */
  async resumeFrom(
    sourceRunId: string,
    sha: string,
    prompt: string,
    overrides: Omit<StartRunInput, "prompt" | "resumeFrom" | "reuseWorktreeOf" | "project" | "kind"> = {},
  ): Promise<RunRecord> {
    const src = this.store.getRun(sourceRunId);
    if (!src) throw new Error("Không tìm thấy lần chạy gốc.");
    if (src.kind !== "coding") throw new Error("Lần chạy gốc không phải run lập trình nên không thể tiếp tục từ commit.");
    if (!src.branch) throw new Error("Lần chạy gốc không có nhánh nên không thể tiếp tục từ commit.");
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Lệnh trống.");
    if (!isFullCommitSha(sha)) throw new Error("Mã commit không hợp lệ: cần đúng 40 ký tự hex thường.");
    const project = this.store.getProject(src.project);
    if (!project?.repo_path) throw new Error(`Project "${src.project}" của lần chạy gốc không còn repo nên không thể tiếp tục từ commit.`);
    if (!isCommitOnBranch(project.repo_path, sha, src.branch)) throw new Error("Commit không nằm trên nhánh của run gốc.");
    return this.launch({ ...overrides, prompt, project: src.project, kind: "coding", resumeFrom: { runId: src.id, sha } }, null);
  }

  cancel(runId: string): boolean {
    this.cancelQuotaResume(runId); // also for finished runs; for a queue command this stops the project's run-all (intended)
    if (this.waitList.cancelWaiting(runId)) return true;
    const runner = this.active.get(runId);
    if (!runner) return false;
    runner.cancel();
    return true;
  }

  /** Does the run's worktree still exist on disk (null when the run has none)? */
  worktreeExists(run: RunRecord): boolean | null {
    return run.worktree_path ? fs.existsSync(run.worktree_path) : null;
  }

  // ---- Output folder and "open in Explorer" (RunOutputs)

  /** UI "Mở trong Explorer": only the two directories recorded in the DB for this run are ever opened. Returns the opened path. */
  openDir(runId: string, target: OpenDirTarget): string {
    return this.outputs.openDir(runId, target);
  }

  /** Where AI-made (non-code) files are collected: Settings value, else <workspace>/outputs. */
  outputDir(): string {
    return this.outputs.outputDir();
  }

  setOutputDir(p: string): string {
    return this.outputs.setOutputDir(p);
  }

  /** Mirror a run's artifacts into the output folder (best-effort, never throws). */
  syncOutputs(runId: string): number {
    return this.outputs.syncOutputs(runId);
  }

  /** UI "Mở tệp": the path comes from the DB + a checked relative path, never from the request. */
  openOutput(runId: string, rel?: string): string {
    return this.outputs.openOutput(runId, rel);
  }

  /** Save a file made outside a run (skill training exports) under `<outputDir>/<group>/<name>` and highlight it. */
  saveOutputFile(group: string, name: string, data: Buffer): string {
    return this.outputs.saveOutputFile(group, name, data);
  }

  // ---- Merge pre-check, release, version bump, cleanup (RunRelease)

  /** UI "Dọn worktree": remove the run's worktree and branch; refused while a run still uses the worktree. */
  cleanupWorktree(runId: string): { worktree_path: string; branch: string; worktree_removed: boolean; branch_deleted: boolean; messages: string[] } {
    return this.release.cleanupWorktree(runId);
  }

  /** Manual "release" of a finished coding run: commit leftovers, then `merge --no-ff` into the base branch. No push, no tag. */
  releaseRun(runId: string): { committed: boolean; merged: boolean; base: string; branch: string; commit: string | null } {
    return this.release.releaseRun(runId);
  }

  /** Computed on the fly (not stored): is `tnf/<id>` already merged into the project's base? undefined for non-coding/no repo. */
  mergedFlag(run: RunRecord): boolean | undefined {
    return this.release.mergedFlag(run);
  }

  /** Dry-run merge of the run's branch into the project's base; stores `merge_precheck` and emits `run.updated`. */
  precheckMerge(runId: string): MergePrecheck | undefined {
    return this.release.precheckMerge(runId);
  }

  /** "Phát hành": bump the patch version in the target repo and commit `chore(release): <version>`. No tag, no push. */
  publishRun(runId: string): { ok: true; version: string; previous: string; commit: string } {
    return this.release.publishRun(runId);
  }

  /**
   * Delete a project (floor): only the project row; run history stays. Refused for `default`, unknown names,
   * projects with a running run, and projects whose coding runs still have a worktree on disk
   * (cleanup/release need the project row to find the target repo).
   */
  removeProject(name: string): void {
    const n = normalizeProject(name);
    if (n === "default") throw new Error('Không thể xóa project "default".');
    if (!this.store.getProject(n)) throw new Error(`Không tìm thấy project "${n}".`);
    for (const id of this.active.keys()) {
      if (this.store.getRun(id)?.project === n) throw new Error(`Project "${n}" đang có lần chạy hoạt động; hãy chờ xong hoặc hủy trước khi xóa.`);
    }
    const pending = this.store.listRuns({ project: n, limit: 100000 }).filter((r) => r.status === "running" || (r.kind === "coding" && r.worktree_path && fs.existsSync(r.worktree_path)));
    if (pending.length) {
      throw new Error(`Project "${n}" còn ${pending.length} lần chạy chưa xong hoặc còn worktree chưa dọn; hãy dọn worktree (hoặc phát hành) trước khi xóa.`);
    }
    this.store.deleteProject(n);
  }

  /** `<workspace>/inbox-staging/<id>`; the id is validated like a file name so it can never leave that directory. */
  stageDir(stageId: string): string {
    if (validateInboxName(stageId)) throw new Error("Mã đính kèm không hợp lệ.");
    return path.join(this.opts.config.workspaceDir, "inbox-staging", stageId);
  }

  /** @internal exposed for tests */
  onEvent(runId: string, runner: CliRunner, ev: NormalizedEvent, coding: { runDir: string; notesWritten: Map<string, number> } | null): void {
    this.eventSink.onEvent(runId, runner, ev, coding);
  }

  private emitUpdated(runId: string): void {
    const rec = this.store.getRun(runId);
    if (rec) this.emit("run.updated", rec);
  }

  /** Wait until a run leaves the active set. */
  waitFor(runId: string): Promise<RunRecord | null> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.active.has(runId)) {
          this.off("run.updated", onUpd);
          resolve(this.store.getRun(runId));
        }
      };
      const onUpd = (r: RunRecord) => {
        if (r.id === runId) check();
      };
      this.on("run.updated", onUpd);
      check();
    });
  }
}
