import type { CliRunner } from "./providers/types.js";
import type { NormalizedEvent, StoredEvent } from "./events.js";
import { applyRateLimit, pickBaseline, resetsMs, type BaseResets } from "../usage/quota-baseline.js";
import type { RunRecord } from "./run-store.js";
import { saveRoleNote } from "./run-artifacts.js";
import type { RunHost } from "./run-host.js";

export type EventSinkHost = Pick<RunHost, "store" | "lastRateLimit" | "emit" | "emitUpdated" | "notifyWebhook" | "noteQuotaReset">;

/** Applies one normalized stream event to the store and broadcasts it ("event", "run.updated", "rate.limit"). */
export class RunEventSink {
  /** Reset times of the quota baseline picked when a run started (V14), kept until the run ends. */
  private baseResets = new Map<string, BaseResets>();

  constructor(private readonly host: EventSinkHost) {}

  onEvent(runId: string, runner: CliRunner, ev: NormalizedEvent, coding: { runDir: string; notesWritten: Map<string, number> } | null): void {
    const stored: StoredEvent = this.host.store.appendEvent(runId, ev);
    if (ev.type === "run.result" || ev.type === "run.error" || ev.type === "run.cancelled") this.baseResets.delete(runId);
    switch (ev.type) {
      case "run.started": {
        const patch: Partial<RunRecord> = {};
        if (ev.session_id) patch.session_id = ev.session_id;
        if (ev.model) patch.model = ev.model;
        if (ev.claude_version) patch.claude_version = ev.claude_version;
        const curRun = this.host.store.getRun(runId);
        if (curRun && curRun.quota_start == null && curRun.quota7_start == null) {
          const base = pickBaseline(this.host.lastRateLimit, Date.now());
          Object.assign(patch, base.patch);
          if (Object.keys(base.resets).length > 0) this.baseResets.set(runId, base.resets);
        }
        this.host.store.updateRun(runId, patch);
        break;
      }
      case "usage.update":
        this.host.store.updateRun(runId, { usage: runner.parser.totalUsage, agents: [...runner.parser.agents.values()] });
        break;
      case "agent.started":
        this.host.store.updateRun(runId, { agents: [...runner.parser.agents.values()] });
        break;
      case "agent.finished": {
        // SPEC §3.1: save each role's full reply to notes/<role>.md as soon as it finishes (planner/critic need it mid-run).
        if (coding) {
          const a = runner.parser.agents.get(ev.agent_id);
          if (a?.reply) saveRoleNote(coding.runDir, a, coding.notesWritten);
        }
        this.host.store.updateRun(runId, { agents: [...runner.parser.agents.values()] });
        break;
      }
      case "agent.verdict": {
        const cur = this.host.store.getRun(runId);
        const verdicts = [...(cur?.verdicts ?? []), { agent_id: ev.agent_id, role: ev.role, verdict: ev.verdict, ...(ev.note ? { note: ev.note } : {}), at: Date.now() }];
        this.host.store.updateRun(runId, { verdicts });
        break;
      }
      case "run.result": {
        const patch: Partial<RunRecord> = {
          status: ev.ok ? "done" : "error",
          result_text: ev.text,
          cost_usd_est: ev.cost_usd_est,
          usage: ev.usage,
          num_turns: ev.num_turns,
          duration_ms: ev.duration_ms,
        };
        if (ev.session_id) patch.session_id = ev.session_id;
        this.host.store.updateRun(runId, patch);
        this.host.notifyWebhook(runId);
        break;
      }
      case "run.error":
        this.host.store.updateRun(runId, { status: "error", error: `${ev.kind}: ${ev.message}` });
        this.host.notifyWebhook(runId);
        break;
      case "run.cancelled":
        this.host.store.updateRun(runId, { status: "cancelled" });
        break;
      case "rate.limit":
        {
          const cur = this.host.store.getRun(runId);
          const qp = applyRateLimit(cur ?? {}, ev, this.baseResets.get(runId));
          if (Object.keys(qp).length > 0) this.host.store.updateRun(runId, qp);
          if (ev.status === "rejected" && ev.five_hour_resets_at != null) this.host.noteQuotaReset(runId, resetsMs(ev.five_hour_resets_at));
        }
        this.host.lastRateLimit = { ...ev, observed_at: Date.now() };
        this.host.emit("rate.limit", this.host.lastRateLimit);
        break;
      default:
        break;
    }
    this.host.emit("event", { run_id: runId, stored });
    if (["run.started", "run.result", "run.error", "run.cancelled", "agent.started", "agent.finished", "agent.verdict", "vcs.commit"].includes(ev.type)) this.host.emitUpdated(runId);
  }
}
