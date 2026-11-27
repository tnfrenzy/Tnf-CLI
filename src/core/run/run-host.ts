import type { AuthStatus } from "./billing-guard.js";
import type { CliAccountStore } from "./cli-accounts.js";
import type { CliRunner } from "./providers/types.js";
import type { ControllerConfig } from "../app/config.js";
import type { NormalizedEvent } from "./events.js";
import type { Grants } from "./grants.js";
import type { PreviewDeps } from "../preview/preview.js";
import type { CliAccountPublic, CliModelChoice } from "../shared-types.js";
import type { RoleLibrary } from "../roles/role-library.js";
import type { QueueStore } from "../queue/queue-store.js";
import type { QueueRunAll } from "../queue/queue-runner.js";
import type { MergePrecheck, RunRecord, RunStore } from "./run-store.js";
import type { StartRunInput } from "./run-input.js";

export type RateLimitSnapshot = Extract<NormalizedEvent, { type: "rate.limit" }> & { observed_at: number };
export type LaunchOptions = { adoptRunId?: string; noDefer?: boolean };
export type QueueCommandRef = { runId: string | null; project: string };

/**
 * Internal surface of RunManager used by its collaborators (wait list, launcher, queue runs, resume scheduler,
 * previews, outputs, release, event sink). RunManager builds one object of this shape; every member is resolved on
 * the manager at call time, so tests that spy on a manager method also see the calls made by collaborators.
 * Each collaborator narrows it with `Pick<RunHost, ...>` to the members it really needs.
 */
export interface RunHost {
  readonly config: ControllerConfig;
  readonly store: RunStore;
  /** Environment for child processes (tests inject a restricted one). */
  readonly env: NodeJS.ProcessEnv;
  readonly skipBillingGuard: boolean;
  readonly previewDeps: PreviewDeps | undefined;
  readonly openDirectory: ((dir: string) => void) | undefined;
  readonly openPath: ((a: { dir: string; select?: string }) => void) | undefined;
  /** Runs executing in this process right now. */
  readonly active: Map<string, CliRunner>;
  readonly queue: QueueStore;
  readonly queueRunAll: QueueRunAll;
  /** The run-all orchestrator only when something already created it (never creates it). */
  queueRunAllIfStarted(): QueueRunAll | null;
  readonly cliAccounts: CliAccountStore;
  readonly library: RoleLibrary;
  lastRateLimit: RateLimitSnapshot | null;
  setLastAuth(status: AuthStatus): void;

  emit(event: string, payload: unknown): boolean;
  emitUpdated(runId: string): void;
  notifyWebhook(runId: string): void;

  startRun(input: StartRunInput): Promise<RunRecord>;
  followup(parentRunId: string, prompt: string, overrides?: Omit<StartRunInput, "prompt">): Promise<RunRecord>;
  waitFor(runId: string): Promise<RunRecord | null>;
  /** Slot-gated entry point of every run (may defer a coding run to the wait list). */
  launch(input: StartRunInput, parent: RunRecord | null, opts?: LaunchOptions): Promise<RunRecord>;
  /** Start right now, bypassing the wait list. */
  launchNow(input: StartRunInput, parent: RunRecord | null, opts?: LaunchOptions): Promise<RunRecord>;
  startQueuedCommand(project: string, commandId: string): Promise<RunRecord>;
  drainWaiting(): Promise<void>;
  forgetScope(runId: string): void;
  codingActiveCount(): number;
  maxRuns(): number;

  getGrants(project: string | null): { grants: Grants; source: "project" | "default" | "builtin" };
  outputDir(): string;
  syncOutputs(runId: string): number;
  stageDir(stageId: string): string;
  worktreeExists(run: RunRecord): boolean | null;
  precheckMerge(runId: string): MergePrecheck | undefined;

  isAccountCoolingDown(accountId: string): boolean;
  markAccountCooldown(accountId: string, untilMs: number): void;
  resolveBinaryForAccount(account: CliAccountPublic): { binaryPath: string; argsPrefix: string[] };
  modelsForAccount(account: CliAccountPublic, refresh?: boolean): CliModelChoice[];

  queueRunIndex(project: string): Map<string, string[]>;
  queueChainRunIds(cmd: QueueCommandRef, index?: Map<string, string[]>): string[];
  syncQueueOnExit(runId: string, project: string): void;

  onEvent(runId: string, runner: CliRunner, ev: NormalizedEvent, coding: { runDir: string; notesWritten: Map<string, number> } | null): void;
  noteQuotaReset(runId: string, resetAtMs: number): void;
  recordQuotaCooldownIfNeeded(runId: string): boolean;
  maybeImmediateQuotaFailover(runId: string, isReadOnly: boolean): boolean;
  tryQuotaResume(runId: string): boolean;
  maybeAutoResume(runId: string): void;
}
