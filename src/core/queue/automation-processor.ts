// App-level automation processor: on each tick, when autopilot is enabled and its schedule is due,
// start "run all" for every project that has approved queue commands. Never approves commands itself.
import fs from "node:fs";
import path from "node:path";
import { isDue, type ScheduleSpec } from "./schedule-spec.js";
import type { PruneOutcome } from "./queue-store.js";

export const AUTOMATION_STATE_FILE = "automation-state.json";
export const AUTOMATION_DEFAULT_INTERVAL_MS = 60_000;

export interface AutomationDeps {
  now(): number;
  utcOffsetMinutes(nowMs: number): number;
  snapshot(): { enabled: boolean; scheduleSpec: ScheduleSpec | null; pruneDone?: { enabled: boolean; keepDays: number; branches?: boolean } };
  /** Delete merged commands older than keepDays in one project (and their branches when asked). */
  pruneMerged?(project: string, keepDays: number, withBranches: boolean): PruneOutcome;
  /** Receives the branches a prune kept on purpose, so the UI can list them. */
  recordPruneKept?(project: string, kept: { branch: string; reason: string }[]): void;
  /** Names of projects that have a repo_path. */
  projects(): string[];
  hasApproved(project: string): boolean;
  isActive(project: string): boolean;
  startRunAll(project: string): Promise<unknown>;
  loadLastRunAt(): number | null;
  saveLastRunAt(ms: number): void;
  log?(msg: string): void;
}

/**
 * - off: autopilot disabled
 * - no_schedule: enabled but no schedule set
 * - seeded: first sight of a schedule without lastRunAt; lastRunAt = now, nothing started
 * - not_due: schedule not due yet
 * - ran: due; lastRunAt saved, eligible projects started
 * - busy: a previous tick is still running (overlapping tick skipped)
 */
export type AutomationTickStatus = "off" | "no_schedule" | "seeded" | "not_due" | "ran" | "busy";

export interface AutomationTickResult {
  status: AutomationTickStatus;
  started: string[];
  errors: { project: string; message: string }[];
  /** Commands auto-deleted this tick (merged and older than the keep window). */
  pruned?: { project: string; ids: string[]; branchesDeleted?: string[]; branchesKept?: { branch: string; reason: string }[] }[];
}

export class AutomationProcessor {
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AutomationDeps) {}

  async tick(): Promise<AutomationTickResult> {
    if (this.busy) return { status: "busy", started: [], errors: [] };
    this.busy = true;
    try {
      return await this.runTick();
    } finally {
      this.busy = false;
    }
  }

  private async runTick(): Promise<AutomationTickResult> {
    const d = this.deps;
    const snap = d.snapshot();
    if (!snap.enabled) return { status: "off", started: [], errors: [] };
    const pruned = this.pruneStep(snap.pruneDone);
    const extra = pruned.length ? { pruned } : {};
    if (!snap.scheduleSpec) return { status: "no_schedule", started: [], errors: [], ...extra };
    const now = d.now();
    const last = d.loadLastRunAt();
    if (last === null) {
      d.saveLastRunAt(now);
      return { status: "seeded", started: [], errors: [], ...extra };
    }
    if (!isDue(snap.scheduleSpec, now, last, d.utcOffsetMinutes(now))) {
      return { status: "not_due", started: [], errors: [], ...extra };
    }
    // Save before starting so a crash mid-start never re-triggers the same slot.
    d.saveLastRunAt(now);
    const started: string[] = [];
    const errors: { project: string; message: string }[] = [];
    for (const p of d.projects()) {
      try {
        if (!d.hasApproved(p) || d.isActive(p)) continue;
        await d.startRunAll(p);
        started.push(p);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ project: p, message });
        d.log?.(`[automation] ${p}: ${message}`);
      }
    }
    return { status: "ran", started, errors, ...extra };
  }

  /** Runs on every tick while autopilot is on; one bad project never breaks the tick. */
  private pruneStep(cfg: { enabled: boolean; keepDays: number; branches?: boolean } | undefined): NonNullable<AutomationTickResult["pruned"]> {
    const d = this.deps;
    if (!cfg?.enabled || !d.pruneMerged) return [];
    const out: NonNullable<AutomationTickResult["pruned"]> = [];
    try {
      for (const p of d.projects()) {
        try {
          const r = d.pruneMerged(p, cfg.keepDays, cfg.branches === true);
          const { ids } = r;
          if (ids.length) {
            const del = r.branchesDeleted.map((b) => b.branch);
            out.push({ project: p, ids, branchesDeleted: del, branchesKept: r.branchesKept });
            d.log?.(`[automation] ${p}: auto-deleted ${ids.length} merged command(s) older than ${cfg.keepDays}d: ${ids.join(", ")}`);
            if (del.length) d.log?.(`[automation] ${p}: deleted ${del.length} merged branch(es) (tip in queue-archive.jsonl): ${r.branchesDeleted.map((b) => `${b.branch}@${b.sha.slice(0, 10)}`).join(", ")}`);
            if (r.branchesKept.length) {
              d.log?.(`[automation] ${p}: kept ${r.branchesKept.length} branch(es): ${r.branchesKept.map((b) => `${b.branch} (${b.reason})`).join("; ")}`);
              d.recordPruneKept?.(p, r.branchesKept);
            }
          }
        } catch (e) {
          d.log?.(`[automation] ${p}: prune failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      d.log?.(`[automation] prune failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
  }

  start(intervalMs = AUTOMATION_DEFAULT_INTERVAL_MS): void {
    if (this.timer || !(intervalMs > 0)) return;
    this.timer = setInterval(() => {
      void this.tick().catch((e) => this.deps.log?.(`[automation] tick: ${e instanceof Error ? e.message : String(e)}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}

export function readLastRunAt(dataDir: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, AUTOMATION_STATE_FILE), "utf8")) as unknown;
    const v = raw && typeof raw === "object" ? (raw as { lastRunAt?: unknown }).lastRunAt : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeLastRunAt(dataDir: string, ms: number): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, AUTOMATION_STATE_FILE), JSON.stringify({ lastRunAt: ms }), "utf8");
}
