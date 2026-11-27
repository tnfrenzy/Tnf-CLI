import { parseAutoResume, type AutoResumeConfig } from "../app/config.js";
import { computeResumeAt, isQuotaStopError, isResumePrompt, quotaResumePrompt } from "./quota-resume.js";
import type { QuotaResumeRecord } from "../shared-types.js";
import type { RunRecord } from "./run-store.js";
import type { RunHost } from "./run-host.js";

export type ResumeHost = Pick<
  RunHost,
  | "config" | "store" | "active" | "cliAccounts" | "queue" | "queueRunAll" | "queueRunAllIfStarted" | "emit" | "startRun" | "followup"
  | "isAccountCoolingDown" | "markAccountCooldown" | "queueRunIndex" | "queueChainRunIds" | "syncQueueOnExit"
>;

const AUTO_RESUME_ERRORS = /^(timeout|subagent_interrupted)(?![A-Za-z_])/;
export const AUTO_RESUME_MARK = "[Tự động tiếp tục lần";

/**
 * Continues runs without the user: quota appointments (wait for the subscription reset, or fail over to a backup
 * account right away) and the automatic follow-up after a timeout / interrupted subagent.
 */
export class ResumeScheduler {
  /** Quota resume appointments (RAM, mirrored into the store), their timers, and the 5h reset time (epoch ms) seen per run while rate-limited. */
  readonly quotaResumes = new Map<string, QuotaResumeRecord>();
  private readonly quotaResumeTimers = new Map<string, NodeJS.Timeout>();
  readonly quotaResetAt = new Map<string, number>();

  constructor(private readonly host: ResumeHost) {}

  /** Single place where an appointment changes state: keep it, mirror it into the store (restart-safe), then announce `quota.resume`. */
  private setQuotaResumeState(rec: QuotaResumeRecord, scope: string | null = null): void {
    this.quotaResumes.set(rec.runId, rec);
    try {
      this.host.store.upsertQuotaResume({
        run_id: rec.runId,
        project: rec.project ?? "",
        kind: rec.kind,
        scope,
        resume_at: Date.parse(rec.resumeAt),
        attempt: rec.attempt ?? 1,
        status: rec.status === "error" ? "failed" : rec.status,
        reason: rec.error ?? rec.reason,
      });
    } catch (e) {
      console.warn(`[quota] không lưu được hẹn của run ${rec.runId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.host.emit("quota.resume", { ...rec });
  }

  private quotaResumeConfig(): AutoResumeConfig {
    return this.host.config.autoResume ?? parseAutoResume(undefined);
  }

  private hasChildRun(runId: string, project: string): boolean {
    return this.host.store.runLinks(project).some((r) => r.parent_run_id === runId);
  }

  private armQuotaResumeTimer(runId: string, delayMs: number): void {
    const old = this.quotaResumeTimers.get(runId);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => void this.fireQuotaResume(runId), Math.min(Math.max(delayMs, 0), 2 ** 31 - 1)); // clamp only to avoid timer overflow
    timer.unref?.();
    this.quotaResumeTimers.set(runId, timer);
  }

  /**
   * Immediately persist account cooldown whenever a run stops due to a usage/quota limit,
   * even if the run has no session_id or quota auto-resume is disabled.
   * Returns true if this run hit a quota limit.
   */
  recordQuotaCooldownIfNeeded(runId: string): boolean {
    const run = this.host.store.getRun(runId);
    if (!run || run.status !== "error") return false;
    const eventResetsAt = this.quotaResetAt.get(runId) ?? null;
    if (!isQuotaStopError(run.error) && !isQuotaStopError(run.result_text) && eventResetsAt == null) return false;
    const cfg = this.quotaResumeConfig();
    const { resumeAt } = computeResumeAt({
      eventResetsAt,
      snapshot: null,
      now: Date.now(),
      marginSec: cfg.quotaMarginSec,
      fallbackMin: cfg.quotaFallbackMin,
    });
    if (run.account_id) this.host.markAccountCooldown(run.account_id, resumeAt);
    return true;
  }

  /**
   * When autoFailover is enabled and a fresh run (<= 1 turn, no commits) hits a quota limit,
   * immediately launch a fallback run on a ready backup account (e.g. another Claude account)
   * instead of failing or waiting hours for the quota reset.
   */
  maybeImmediateQuotaFailover(runId: string, isReadOnly: boolean): boolean {
    if (isReadOnly) return false;
    const settings = this.host.cliAccounts.getSettings();
    if (!settings.autoFailover) return false;
    const run = this.host.store.getRun(runId);
    if (!run || run.status !== "error" || !run.account_id) return false;
    if (run.num_turns > 1 || run.commits.length > 0 || run.parent_run_id) return false;
    if (this.hasChildRun(runId, run.project)) return false;
    const fallback = this.host.cliAccounts.resolveAccount({
      requestedId: run.account_id,
      isCoolingDown: (id) => this.host.isAccountCoolingDown(id),
    });
    if (!fallback || fallback.id === run.account_id) return false;
    const nextPrompt = run.prompt;
    void this.host.startRun({
      prompt: nextPrompt,
      project: run.project,
      kind: run.kind,
      accountId: fallback.id,
      ...(run.model ? { model: run.model } : {}),
    }).catch((e) => {
      console.warn(`[failover] không thể tự chuyển run ${runId} sang ${fallback.id}: ${e instanceof Error ? e.message : String(e)}`);
    });
    return true;
  }

  tryQuotaResume(runId: string): boolean {
    try {
      return this.host.store.getRun(runId)?.status === "error" && this.maybeQuotaResume(runId);
    } catch (e) {
      console.warn(`[quota] không đặt được hẹn tiếp tục cho run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * Schedule "continue after the quota resets" for a run that ended in error because of the usage limit. Called by
   * handleExit BEFORE syncQueueOnExit/maybeAutoResume: when it returns true the caller skips both, so a queue command
   * stays "đang chạy" (not "lỗi", no requeue, no autoRetry) until fireQuotaResume continues its session.
   * Returns false (no record) when auto-resume is off, the run is active or has no session, the attempt cap of the
   * chain is used up, or the stop was not caused by the quota.
   */
  maybeQuotaResume(runId: string): boolean {
    if (this.host.active.has(runId)) return false;
    const cfg = this.quotaResumeConfig();
    if (!cfg.enabled || !cfg.quotaEnabled) return false;
    const run = this.host.store.getRun(runId);
    if (!run || run.status !== "error" || !run.session_id) return false;
    const eventResetsAt = this.quotaResetAt.get(runId) ?? null;
    if (!isQuotaStopError(run.error) && eventResetsAt == null) return false;
    // Attempts are counted over the whole chain of follow-ups, not per run.
    let attempt = 1;
    const seen = new Set<string>();
    for (let p: RunRecord | null = run; p && !seen.has(p.id) && isResumePrompt(p.prompt); p = p.parent_run_id ? this.host.store.getRun(p.parent_run_id) : null) {
      seen.add(p.id);
      attempt++;
    }
    if (attempt > cfg.maxAttempts) return false;
    const now = Date.now();
    const { resumeAt, source } = computeResumeAt({ eventResetsAt, snapshot: null, now, marginSec: cfg.quotaMarginSec, fallbackMin: cfg.quotaFallbackMin });
    if (run.account_id) this.host.markAccountCooldown(run.account_id, resumeAt);
    const project = run.project;
    const index = this.host.queueRunIndex(project);
    const cmd = this.host.queue.list(project).find((c) => c.status === "đang chạy" && this.host.queueChainRunIds(c, index).includes(runId));
    const reason = `Hết hạn mức đăng ký; hẹn tiếp tục lúc ${new Date(resumeAt).toISOString()} (nguồn: ${source}).`;
    // A queue command only counts as "queue" while run-all is active: otherwise nothing would pause it.
    const isQueue = !!cmd && this.host.queueRunAll.pauseUntil(project, resumeAt, reason, runId);
    this.armQuotaResumeTimer(runId, resumeAt - now);
    this.setQuotaResumeState(
      { runId, kind: isQueue ? "queue" : "run", project, status: "pending", resumeAt: new Date(resumeAt).toISOString(), reason, attempt },
      isQueue ? (cmd?.sourceRef ?? null) : null,
    );
    return true;
  }

  /** Appointments after a server restart: re-arm the pending rows of the store (never fired/cancelled/failed ones). Returns how many were re-armed. */
  restoreQuotaResumes(): number {
    let restored = 0;
    const cfg = this.quotaResumeConfig();
    for (const row of this.host.store.listQuotaResumes("pending")) {
      try {
        const run = this.host.store.getRun(row.run_id);
        if (!run || run.status === "cancelled" || this.hasChildRun(row.run_id, row.project)) {
          this.host.store.setQuotaResumeStatus(row.run_id, "cancelled", !run ? "run không còn" : run.status === "cancelled" ? "run đã bị hủy" : "đã có run con");
          continue;
        }
        const now = Date.now();
        const delay = row.resume_at <= now ? cfg.delaySec * 1000 : row.resume_at - now;
        this.quotaResumes.set(row.run_id, {
          runId: row.run_id,
          kind: row.kind,
          project: row.project || null,
          status: "pending",
          resumeAt: new Date(row.resume_at).toISOString(),
          reason: row.reason,
          attempt: row.attempt,
        });
        this.armQuotaResumeTimer(row.run_id, delay);
        if (row.kind === "queue" && row.project) {
          // Keep run-all paused until the appointment so it does not run other commands first; a conflict just means it is already active.
          const pause = { until: now + delay, reason: row.reason, runId: row.run_id };
          this.host.queueRunAll.start(row.project, row.scope ?? undefined, pause).catch(() => {
            this.host.queueRunAll.pauseUntil(row.project, pause.until, pause.reason, pause.runId);
          });
        }
        restored++;
      } catch (e) {
        console.warn(`[quota] không khôi phục được hẹn của run ${row.run_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return restored;
  }

  getQuotaResume(runId: string): QuotaResumeRecord | null {
    const rec = this.quotaResumes.get(runId);
    return rec ? { ...rec } : null;
  }

  /** Only appointments still waiting. */
  listQuotaResumes(): QuotaResumeRecord[] {
    return [...this.quotaResumes.values()].filter((r) => r.status === "pending").map((r) => ({ ...r }));
  }

  /**
   * Cancel a pending appointment. The quota is still exhausted, so nothing continues: a queue command is marked failed
   * via syncQueueOnExit (it was held as "đang chạy") and run-all is stopped instead of running on.
   */
  cancelQuotaResume(runId: string): boolean {
    const rec = this.quotaResumes.get(runId);
    if (!rec || rec.status !== "pending") return false;
    const timer = this.quotaResumeTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.quotaResumeTimers.delete(runId);
    this.setQuotaResumeState({ ...rec, status: "cancelled" });
    if (rec.project && rec.project !== "default") {
      try { this.host.syncQueueOnExit(runId, rec.project); } catch (e) { console.warn(`[quota] syncQueueOnExit: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (rec.kind === "queue" && rec.project) {
      try { this.host.queueRunAllIfStarted()?.stop(rec.project); } catch (e) { console.warn(`[quota] queueRunAll.stop: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return true;
  }

  async fireQuotaResume(runId: string): Promise<void> {
    const rec = this.quotaResumes.get(runId);
    if (!rec || rec.status !== "pending") return;
    this.quotaResumeTimers.delete(runId);
    const project = rec.project ?? "";
    try {
      const run = this.host.store.getRun(runId);
      const active = this.host.active.has(runId);
      const hasChild = !!project && this.hasChildRun(runId, project);
      if (active || hasChild || !run || run.status !== "error") {
        // The user already moved on (asked a follow-up, cancelled, restarted): never start a second continuation.
        this.setQuotaResumeState({ ...rec, status: "cancelled" });
        if (rec.kind === "queue") {
          this.host.queueRunAll.clearPause(project);
          if (!active && !hasChild) this.host.syncQueueOnExit(runId, project); // nobody else will continue the held command
        }
        return;
      }
      const max = this.quotaResumeConfig().maxAttempts;
      await this.host.followup(runId, quotaResumePrompt(rec.attempt ?? 1, max), {}); // goes through runBillingGuard like any run
      this.setQuotaResumeState({ ...rec, status: "fired" });
      if (rec.kind === "queue") this.host.queueRunAll.clearPause(project);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[quota] không tiếp tục được run ${runId}: ${msg}`);
      this.setQuotaResumeState({ ...rec, status: "error", error: msg.slice(0, 300) });
      if (rec.kind === "queue" && project) {
        try { this.host.syncQueueOnExit(runId, project); } catch { /* best-effort */ }
        try { this.host.queueRunAll.stop(project); } catch { /* best-effort */ }
      }
    }
  }

  /**
   * A run cut by `timeout` / `subagent_interrupted` continues in the same session (and worktree) without the user:
   * a follow-up asks the agents to check git state and finish what is left. At most `autoResume.maxAttempts` per chain.
   * Skipped for read-only runs (their callers wait for the original run) and queue runs (the queue has its own retry).
   */
  maybeAutoResume(runId: string): void {
    try {
      const cfg = this.host.config.autoResume;
      if (!cfg?.enabled || cfg.maxAttempts <= 0) return;
      const run = this.host.store.getRun(runId);
      if (!run || run.status !== "error" || !run.session_id || !run.error || !AUTO_RESUME_ERRORS.test(run.error)) return;
      if (isQuotaStopError(run.error)) return; // the usage limit is handled by maybeQuotaResume
      if (run.mode.includes("queue-split") || this.host.queue.list(run.project).some((c) => c.runId === runId)) return;
      let attempt = 1;
      for (let p: RunRecord | null = run; p && p.prompt.startsWith(AUTO_RESUME_MARK); p = p.parent_run_id ? this.host.store.getRun(p.parent_run_id) : null) attempt++;
      if (attempt > cfg.maxAttempts) return;
      const kind = run.error.split(":")[0];
      const prompt = `${AUTO_RESUME_MARK} ${attempt}/${cfg.maxAttempts}] Lượt trước bị ngắt (${kind}). Hãy chạy git status và git log trong thư mục làm việc để biết phần nào đã commit, rồi làm tiếp phần còn lại của yêu cầu gốc, không làm lại phần đã xong. Giao mỗi lượt cho subagent một việc nhỏ và commit ngay khi xong.`;
      const timer = setTimeout(() => {
        if (this.host.active.has(runId)) return;
        this.host.followup(runId, prompt).catch((e) => console.warn(`[auto-resume] không tiếp tục được run ${runId}: ${e instanceof Error ? e.message : String(e)}`));
      }, cfg.delaySec * 1000);
      timer.unref?.();
    } catch (e) {
      console.warn(`[auto-resume] lỗi: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
