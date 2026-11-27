import path from "node:path";
import { ideaAgentsOf, type AuthMode, type RunKind } from "../app/config.js";
import { analyzeScope, scopeConflict, type ScopeInfo } from "./scope-guard.js";
import { SCOUT_PROMPT_PREFIXES, type RunRecord } from "./run-store.js";
import { normalizeProject, type StartRunInput } from "./run-input.js";
import { resolveRunKind } from "./run-launch.js";
import { makeRunId } from "./run-support.js";
import type { LaunchOptions, RunHost } from "./run-host.js";

export type WaitListHost = Pick<
  RunHost,
  "config" | "store" | "active" | "codingActiveCount" | "maxRuns" | "emitUpdated" | "launchNow" | "startQueuedCommand" | "startRun" | "waitFor"
>;

type WaitItem = { kind: "run"; runId: string; project: string; input: StartRunInput; guarded?: boolean } | { kind: "queue"; project: string; id: string };

/**
 * Admission of coding runs: the app-wide slot cap, the in-memory wait list (lost on restart) and the scope guard that
 * holds back a run whose files overlap with a running or earlier-waiting run of the same project.
 */
export class RunWaitList {
  private readonly waiting: WaitItem[] = [];
  private draining = false;
  private drainAgain = false;
  private readonly holdReasons = new Map<string, string>();
  private readonly scopeCache = new Map<string, Promise<ScopeInfo>>();
  /** Slots reserved by coding runs that passed the cap check but are not in `active` yet (closes the double-click race). */
  readonly reservedSlots = new Set<{ id: string; project: string; prompt: string }>();
  private startingSeq = 0;

  constructor(private readonly host: WaitListHost) {}

  /** Runs/commands waiting for a free slot, oldest first (for the UI). */
  waitingList(): { kind: "run" | "queue"; id: string; project: string; reason?: string }[] {
    return this.waiting.map((w) => {
      if (w.kind !== "run") return { kind: "queue" as const, id: w.id, project: w.project };
      const reason = this.holdReasons.get(w.runId);
      return { kind: "run" as const, id: w.runId, project: w.project, ...(reason ? { reason } : {}) };
    });
  }

  /** Why a queued run is held back (scope guard), or undefined (just waiting for a free slot). */
  waitReason(runId: string): string | undefined {
    return this.holdReasons.get(runId);
  }

  private scopeGuardOn(): boolean {
    return this.host.config.queue?.scopeGuard?.enabled === true;
  }

  /** Scope of a run, analysed once (read-only run) and cached by run id. */
  private scopeOf(runId: string, project: string, prompt: string): Promise<ScopeInfo> {
    let p = this.scopeCache.get(runId);
    if (!p) {
      p = analyzeScope({ config: this.host.config, getProject: (n) => this.host.store.getProject(n), manager: this.host }, project, prompt);
      this.scopeCache.set(runId, p);
    }
    return p;
  }

  /** Coding runs of `project` that are running now (their prompt is read from the store). */
  private runningPeers(project: string): { id: string; prompt: string }[] {
    const out: { id: string; prompt: string }[] = [];
    const scoutPrefix = (t: string) => SCOUT_PROMPT_PREFIXES.some((x) => t.startsWith(x));
    for (const id of this.host.active.keys()) {
      const r = this.host.store.getRun(id);
      if (r && r.kind === "coding" && r.project === project && !scoutPrefix(r.prompt)) out.push({ id, prompt: r.prompt });
    }
    // Runs that took a slot but are not in `active` yet (the process is being started).
    for (const t of this.reservedSlots) {
      if (t.project === project && !out.some((o) => o.id === t.id) && !scoutPrefix(t.prompt)) out.push({ id: t.id, prompt: t.prompt });
    }
    return out;
  }

  /**
   * May the waiting run at `index` start next to its peers? Peers are the running coding runs of the same project and
   * the runs of that project still held ahead of it. Never pauses anything that runs. Unsure scope = conflict.
   */
  private async guardVerdict(item: Extract<WaitItem, { kind: "run" }>, index: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const peers = [
      ...this.runningPeers(item.project),
      ...this.waiting.slice(0, index).flatMap((w) => (w.kind === "run" && w.project === item.project ? [{ id: w.runId, prompt: w.input.prompt }] : [])),
    ];
    if (peers.length === 0) return { ok: true };
    const hotspots = this.host.config.queue?.hotspots ?? [];
    const mine = await this.scopeOf(item.runId, item.project, item.input.prompt);
    for (const peer of peers) {
      const theirs = await this.scopeOf(peer.id, item.project, peer.prompt);
      const c = scopeConflict({ id: item.runId, scope: mine }, { id: peer.id, scope: theirs }, hotspots);
      if (c.conflict) return { ok: false, reason: `chờ run ${peer.id}: ${c.reason}` };
    }
    return { ok: true };
  }

  /** Queue command approved while every slot is busy: it starts by itself, in order, when a slot frees. */
  enqueueQueuedCommand(project: string, id: string): void {
    if (this.waiting.some((w) => w.kind === "queue" && w.project === project && w.id === id)) return;
    this.waiting.push({ kind: "queue", project, id });
  }

  /** Start waiting items, oldest first, while slots are free. Called whenever a coding run ends or the cap grows. */
  async drainWaiting(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        let started = true;
        while (started && this.waiting.length && this.host.codingActiveCount() < this.host.maxRuns()) {
          started = false;
          // Oldest first; a run held by the scope guard does not block later runs that do not conflict with anything ahead of them.
          for (let i = 0; i < this.waiting.length; i++) {
            const item = this.waiting[i]!;
            if (item.kind === "run" && this.scopeGuardOn() && item.guarded) {
              const verdict = await this.guardVerdict(item, i);
              if (this.waiting[i] !== item) { started = true; break; } // cancelled or reordered while analysing: rescan
              if (!verdict.ok) {
                if (this.holdReasons.get(item.runId) !== verdict.reason) {
                  this.holdReasons.set(item.runId, verdict.reason);
                  this.host.emitUpdated(item.runId);
                }
                continue;
              }
            }
            this.waiting.splice(i, 1);
            if (item.kind === "run") this.holdReasons.delete(item.runId);
            try {
              if (item.kind === "run") await this.launch(item.input, null, { adoptRunId: item.runId });
              else await this.host.startQueuedCommand(item.project, item.id);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn(`[wait] không khởi động được ${item.kind === "run" ? item.runId : item.id}: ${msg}`);
              if (item.kind === "run") this.host.store.updateRun(item.runId, { status: "error", error: msg });
            }
            started = true;
            break;
          }
        }
      } while (this.drainAgain);
    } finally {
      this.draining = false;
    }
  }

  /** Create a "queued" run row for a coding run that has no free slot; it launches later under the same id. */
  private deferRun(input: StartRunInput, project: string, model: string, mode: AuthMode, guarded = false): RunRecord {
    const id = makeRunId();
    const rec = this.host.store.createRun({
      id,
      status: "queued",
      prompt: input.prompt,
      mode: `${mode}+coding+queued`,
      model,
      session_id: null,
      parent_run_id: null,
      project,
      claude_version: null,
      run_dir: path.join(this.host.config.workspaceDir, "runs", id),
      kind: "coding",
      forked_from_run_id: input.resumeFrom?.runId ?? input.threadWith ?? null,
    });
    this.waiting.push({ kind: "run", runId: id, project, input, guarded });
    this.host.emitUpdated(id);
    return rec;
  }

  /** Drop a run that is still waiting for a slot; false when it is not in the list. */
  cancelWaiting(runId: string): boolean {
    const w = this.waiting.findIndex((x) => x.kind === "run" && x.runId === runId);
    if (w < 0) return false;
    this.waiting.splice(w, 1);
    this.holdReasons.delete(runId);
    this.scopeCache.delete(runId);
    this.host.store.updateRun(runId, { status: "cancelled", error: "Đã hủy khi đang chờ chỗ chạy." });
    this.host.emitUpdated(runId);
    return true;
  }

  /** Forget the cached scope analysis of a finished run. */
  forgetScope(runId: string): void {
    this.scopeCache.delete(runId);
  }

  /**
   * Entry point of every run. A new coding run with no free slot becomes a "queued" row (see deferRun); otherwise it
   * reserves a slot while it starts so two simultaneous requests cannot both take the last one.
   */
  async launch(input: StartRunInput, parent: RunRecord | null, opts: LaunchOptions = {}): Promise<RunRecord> {
    if (opts.noDefer || parent || input.readOnly) return this.host.launchNow(input, parent, opts);
    const projectName = input.project !== undefined ? normalizeProject(input.project) : "default";
    const project = this.host.store.getProject(projectName);
    let kind: RunKind;
    try {
      kind = resolveRunKind(input, parent, project);
    } catch {
      return this.host.launchNow(input, parent, opts);
    }
    if (kind !== "coding" || !project?.repo_path) return this.host.launchNow(input, parent, opts);
    if (!opts.adoptRunId) {
      if (!input.prompt.trim()) throw new Error("Lệnh trống.");
      const guarded = this.scopeGuardOn() && input.scout !== true && (this.runningPeers(projectName).length > 0 || this.waiting.some((w) => w.kind === "run" && w.project === projectName));
      if (guarded || this.host.codingActiveCount() >= this.host.maxRuns()) {
        const rec = this.deferRun(input, projectName, input.model ?? (input.scout === true ? ideaAgentsOf(this.host.config).scoutModel : this.host.config.defaults.model), input.mode ?? this.host.config.defaults.authMode, guarded);
        // Free slot + peers: the guard decides in the drain loop (analysis runs in the background, this call returns the queued row).
        if (guarded) void this.drainWaiting();
        return rec;
      }
    }
    const token = { id: opts.adoptRunId ?? `starting-${++this.startingSeq}`, project: projectName, prompt: input.prompt };
    this.reservedSlots.add(token);
    try {
      return await this.host.launchNow(input, parent, opts);
    } finally {
      this.reservedSlots.delete(token);
    }
  }
}
