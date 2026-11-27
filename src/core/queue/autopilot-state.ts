// In-memory autopilot state: enabled flag, schedule and webhook list. Pure: no timers, never starts runs.
import { AUTOMATION_PRUNE_MAX_KEEP_DAYS, parsePruneDone, validateWebhookUrls, type ControllerConfig, type PruneDoneConfig } from "../app/config.js";
import { parseSchedule, type ScheduleSpec } from "./schedule-spec.js";

export const AUTOPILOT_SCHEDULE_MAX_LEN = 120;

export interface AutopilotSnapshot {
  enabled: boolean;
  schedule: string | null;
  scheduleSpec: ScheduleSpec | null;
  webhooks: string[];
  pruneDone: PruneDoneConfig;
  /** Branches the last prune kept on purpose (newest last, at most PRUNE_KEPT_MAX), for the user to decide. */
  pruneKept: PruneKeptEntry[];
  updatedAt: string;
}

export interface PruneKeptEntry {
  project: string;
  branch: string;
  reason: string;
}

export const PRUNE_KEPT_MAX = 50;

type Now = () => number;

export class AutopilotState {
  private enabled: boolean;
  private schedule: string | null = null;
  private spec: ScheduleSpec | null = null;
  private webhooks: string[];
  private pruneDone: PruneDoneConfig;
  private pruneKept: PruneKeptEntry[] = [];
  private updatedAtMs: number;

  constructor(automation?: ControllerConfig["automation"] | null, private readonly now: Now = Date.now) {
    this.enabled = automation?.enabled === true;
    this.webhooks = [...(automation?.webhooks ?? [])];
    this.pruneDone = { ...parsePruneDone(automation?.pruneDone) };
    this.updatedAtMs = this.now();
    const sc = automation?.schedule;
    if (typeof sc === "string" && sc.trim() !== "" && sc.length <= AUTOPILOT_SCHEDULE_MAX_LEN) {
      // A 5-field cron from config does not parse as a schedule-spec: leave the schedule unset, never throw.
      const r = parseSchedule(sc);
      if (r.ok) {
        this.schedule = normalize(sc);
        this.spec = r.spec;
      }
    }
  }

  snapshot(): AutopilotSnapshot {
    return {
      enabled: this.enabled,
      schedule: this.schedule,
      scheduleSpec: this.spec ? structuredClone(this.spec) : null,
      webhooks: [...this.webhooks],
      pruneDone: { ...this.pruneDone },
      pruneKept: this.pruneKept.map((k) => ({ ...k })),
      updatedAt: new Date(this.updatedAtMs).toISOString(),
    };
  }

  enable(): void {
    if (!this.enabled) this.touch();
    this.enabled = true;
  }

  disable(): void {
    if (this.enabled) this.touch();
    this.enabled = false;
  }

  /** null or an empty string clears the schedule; otherwise throws on length or syntax errors. */
  setSchedule(input: string | null): void {
    if (input === null || (typeof input === "string" && input.trim() === "")) {
      this.schedule = null;
      this.spec = null;
      this.touch();
      return;
    }
    if (typeof input !== "string") throw new Error("Lịch phải là một chuỗi văn bản hoặc null.");
    if (input.length > AUTOPILOT_SCHEDULE_MAX_LEN) {
      throw new Error(`Lịch tối đa ${AUTOPILOT_SCHEDULE_MAX_LEN} ký tự.`);
    }
    const r = parseSchedule(input);
    if (!r.ok) throw new Error(r.error);
    this.schedule = normalize(input);
    this.spec = r.spec;
    this.touch();
  }

  setWebhooks(urls: unknown): void {
    this.webhooks = validateWebhookUrls(urls);
    this.touch();
  }

  /** Throws a Vietnamese Error on a non-boolean `enabled` or a `keepDays` outside 1..365. */
  setPruneDone(enabled: unknown, keepDays: unknown, branches: unknown = this.pruneDone.branches): void {
    if (typeof branches !== "boolean") throw new Error("branches phải là true hoặc false.");
    if (typeof enabled !== "boolean") throw new Error("enabled phải là true hoặc false.");
    if (typeof keepDays !== "number" || !Number.isInteger(keepDays) || keepDays < 1 || keepDays > AUTOMATION_PRUNE_MAX_KEEP_DAYS) {
      throw new Error(`keepDays phải là số nguyên từ 1 đến ${AUTOMATION_PRUNE_MAX_KEEP_DAYS}.`);
    }
    this.pruneDone = { enabled, keepDays, branches };
    this.touch();
  }

  /** Remember branches a prune kept (deduplicated by project + branch, bounded). */
  recordPruneKept(project: string, kept: { branch: string; reason: string }[]): void {
    for (const k of kept) {
      this.pruneKept = this.pruneKept.filter((e) => !(e.project === project && e.branch === k.branch));
      this.pruneKept.push({ project, branch: k.branch, reason: k.reason });
    }
    if (this.pruneKept.length > PRUNE_KEPT_MAX) this.pruneKept = this.pruneKept.slice(-PRUNE_KEPT_MAX);
  }

  private touch(): void {
    this.updatedAtMs = this.now();
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
