import { type IncomingMessage, type ServerResponse } from "node:http";
import { type RunManager } from "../../core/run/run-manager.js";
import type { RunRecord } from "../../core/run/run-store.js";
import { QUEUE_TRANSITIONS, QueueError, type QueueCommand as QueueCmd } from "../../core/queue/queue-store.js";
import { checkBodySafety, checkIndependence, computeWaves, type QueueCommand as PlanCommand, type WaveEntry } from "../../core/queue/queue-plan.js";
import { canRunParallel, clampMaxParallel, isUnlocked } from "../../core/queue/queue-engine.js";
import { listPendingInterviews } from "../../core/ideas/idea-interview-store.js";
import { replanCosts, replanDir } from "../../core/queue/queue-replan.js";
import { ESTIMATE_NOTE, budgetState, estimateCommandCost, estimateGroupCost, queueSpent } from "../../core/queue/queue-budget.js";
import { errorMessage, json, readBody } from "../http-util.js";

// ---- Planner queue helpers (docs/PLANNER-QUEUE.md section 8) ----

export function toPlanCommand(c: QueueCmd): PlanCommand {
  return { id: c.id, title: c.title, body: c.body, dependsOn: c.dependsOn, files: c.files, verify: "", size: 1 };
}

/** Waves for the whole queue; a cycle or unknown id never throws (waves are then omitted, `error` says why). */
export function safeWaves(commands: QueueCmd[], hotspots: string[]): { waves: Map<string, WaveEntry>; error: string | null } {
  const waves = new Map<string, WaveEntry>();
  try {
    const ids = new Set(commands.map((c) => c.id));
    for (const c of commands) {
      for (const d of c.dependsOn) if (!ids.has(d)) throw new Error(`Lệnh "${c.id}" phụ thuộc lệnh không tồn tại "${d}".`);
    }
    for (const w of computeWaves(commands.map(toPlanCommand), { hotspots })) waves.set(w.id, w);
    return { waves, error: null };
  } catch (e) {
    return { waves: new Map(), error: e instanceof Error ? e.message : String(e) };
  }
}

export function queueErrorStatus(e: QueueError): number {
  if (e.conflict) return 409;
  if (e.code === "not_found") return 404;
  return 400;
}

export function codingRunningCount(manager: RunManager): number {
  return manager.codingActiveCount();
}

export function queueRunCheck(manager: RunManager, project: string, cmd: QueueCmd, all: QueueCmd[]): { ok: boolean; reasons: string[]; waiting?: boolean } {
  const q = manager.config.queue;
  const reasons: string[] = [];
  const budget = budgetState(queueSpent(all, replanCosts(replanDir(manager.config.dataDir, project))), q.maxBudgetUsd);
  if (!budget.canOpenNew) reasons.push(budget.message);
  const running = all.filter((c) => c.status === "đang chạy");
  const chk = canRunParallel({ ...cmd, status: "đã duyệt" }, running, q.maxParallel, codingRunningCount(manager), all, q.hotspots);
  if (!chk.ok) reasons.push(...chk.reasons);
  void project;
  return { ok: reasons.length === 0, reasons, waiting: reasons.length > 0 && chk.waiting === true && reasons.length === chk.reasons.length };
}

/** Ids of every run that belongs to a queue command (its own run plus follow-up chain), across all projects. */
export function queueRunIdSet(manager: RunManager): Set<string> {
  const ids = new Set<string>();
  for (const p of manager.store.listProjects()) {
    const cmds = manager.queue.list(p.name).filter((c) => c.runId);
    if (cmds.length === 0) continue;
    const index = manager.queueRunIndex(p.name);
    for (const c of cmds) for (const id of manager.queueChainRunIds(c, index)) ids.add(id);
  }
  return ids;
}

export function describeQueueCommand(manager: RunManager, cmd: QueueCmd, all: QueueCmd[], waves: Map<string, WaveEntry>, history: number[], index?: Map<string, string[]>) {
  const w = waves.get(cmd.id);
  const est = estimateCommandCost({ size: 1 }, history, manager.config.defaults);
  const editable = cmd.status === "chờ duyệt" || cmd.status === "đã duyệt";
  const canRun = cmd.status === "chờ duyệt" || cmd.status === "đã duyệt";
  const runReasons = canRun ? queueRunCheck(manager, cmd.project, cmd, all).reasons : [`Lệnh đang "${cmd.status}" nên không chạy được.`];
  const skippable = QUEUE_TRANSITIONS[cmd.status].includes("bỏ qua");
  return {
    ...cmd,
    wave: w ? w.wave : null,
    waveReasons: w ? w.reasons : [],
    locks: {
      edit: { locked: !editable, reasons: editable ? [] : [`Lệnh đã chạy hoặc đang "${cmd.status}" nên không sửa được.`] },
      approveRun: { locked: runReasons.length > 0, reasons: runReasons },
      skip: { locked: !skippable, reasons: skippable ? [] : [`Không thể bỏ qua lệnh đang "${cmd.status}".`] },
    },
    estimatedCostUsd: est.estimateUsd,
    runLive: manager.isQueueRunLive(cmd, index),
    runCommitCount: cmd.runId ? (manager.store.getRun(cmd.runId)?.commits.length ?? 0) : 0,
    runIds: manager.queueChainRunIds(cmd, index),
    mergePrecheck: cmd.runId ? (manager.store.getRun(cmd.runId)?.merge_precheck ?? null) : null,
  };
}

export async function handleQueueApi(
  manager: RunManager,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  name: string,
  target: string | undefined,
  action: string | undefined,
): Promise<void> {
  const store = manager.store;
  const project = store.getProject(name);
  if (!project) return json(res, 404, { error: "project_not_found", message: `Không tìm thấy môi trường "${name}".` });
  if (name === "default" || !project.repo_path) {
    return json(res, 400, { error: "no_repo", message: `Môi trường "${name}" chưa gắn repo nên không có hàng đợi lệnh.` });
  }
  const q = manager.config.queue;
  const notFound = (id: string) =>
    json(res, 404, { error: "not_found", message: `Không tìm thấy lệnh "${id}" trong hàng đợi của "${name}".` });
  try {
    if (target === undefined && method === "GET") {
      const all = manager.queue.list(name);
      const { waves, error } = safeWaves(all, q.hotspots);
      const history = store.listRuns({ kind: "coding", limit: 20 }).map((r) => r.cost_usd_est);
      const runIndex = manager.queueRunIndex(name);
      const commands = all.map((c) => describeQueueCommand(manager, c, all, waves, history, runIndex));
      const total = estimateGroupCost(
        all
          .filter((c) => c.status === "chờ duyệt" || c.status === "đã duyệt")
          .map((c) => estimateCommandCost({ size: 1 }, history, manager.config.defaults)),
      );
      return json(res, 200, {
        commands,
        waveError: error,
        totalEstimatedCostUsd: total.totalEstimateUsd,
        costNote: ESTIMATE_NOTE,
        budget: budgetState(queueSpent(all, replanCosts(replanDir(manager.config.dataDir, name))), q.maxBudgetUsd),
        maxParallel: clampMaxParallel(q.maxParallel),
        codingRunning: codingRunningCount(manager),
        runAll: manager.queueRunAll.status(name),
        // Per-idea blueprint / critic issues / interview, and ideas still waiting for interview answers.
        ideas: manager.queue.listIdeaMeta(name),
        interviews: listPendingInterviews(manager.config.dataDir, name).map((i) => ({
          id: i.id, idea: i.idea, questions: i.questions, createdAt: i.createdAt, ...(i.lastError ? { lastError: i.lastError } : {}),
        })),
      });
    }

    // Must be handled before manager.queue.get(name, target): "run-all" is not a command id.
    if (target === "run-all" && method === "POST" && (action === undefined || action === "stop")) {
      if (action === "stop") {
        manager.queueRunAll.stop(name);
        return json(res, 200, { runAll: manager.queueRunAll.status(name) });
      }
      const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
      const sourceRef = body["sourceRef"];
      if (sourceRef !== undefined && (typeof sourceRef !== "string" || !sourceRef)) {
        return json(res, 400, { error: "bad_request", message: "sourceRef phải là chuỗi không rỗng (mã ý tưởng)." });
      }
      try {
        await manager.queueRunAll.start(name, sourceRef);
      } catch (e) {
        if ((e as { code?: string }).code === "conflict") return json(res, 409, { error: "conflict", message: (e as Error).message });
        throw e;
      }
      return json(res, 200, { runAll: manager.queueRunAll.status(name) });
    }

    // Approve every pending command of one idea (sourceRef); does not start any run.
    if (target === "approve-all" && action === undefined && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const sourceRef = body["sourceRef"];
      if (typeof sourceRef !== "string" || !sourceRef) {
        return json(res, 400, { error: "bad_request", message: "sourceRef phải là chuỗi không rỗng (mã ý tưởng)." });
      }
      const approved: string[] = [];
      for (const c of manager.queue.list(name)) {
        if (c.sourceRef !== sourceRef || c.status !== "chờ duyệt") continue;
        manager.queue.transition(name, c.id, "đã duyệt");
        approved.push(c.id);
      }
      return json(res, 200, { approved });
    }

    // Delete a whole idea (all its commands); refused while one of them is running.
    if (target === "delete-idea" && action === undefined && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const sourceRef = body["sourceRef"];
      if (typeof sourceRef !== "string" || !sourceRef) {
        return json(res, 400, { error: "bad_request", message: "sourceRef phải là chuỗi không rỗng (mã ý tưởng)." });
      }
      return json(res, 200, { deleted: manager.queue.deleteIdea(name, sourceRef) });
    }

    if (target === "run-parallel" && action === undefined && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const rawIds = body["ids"];
      if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some((x) => typeof x !== "string" || !x)) {
        return json(res, 400, { error: "bad_request", message: "ids phải là mảng id lệnh (chuỗi) không rỗng." });
      }
      const ids = [...new Set(rawIds as string[])];
      const all = manager.queue.list(name);
      const picked: QueueCmd[] = [];
      for (const id of ids) {
        const c = all.find((x) => x.id === id);
        if (!c) return notFound(id);
        picked.push(c);
      }
      const reasons = new Map<string, string[]>(ids.map((id) => [id, []]));
      const add = (id: string, r: string) => reasons.get(id)!.push(r);
      const plans = all.map(toPlanCommand);
      for (const c of picked) {
        if (c.status !== "chờ duyệt" && c.status !== "đã duyệt") add(c.id, `Lệnh đang "${c.status}" nên không chạy được.`);
        const u = isUnlocked(c, all);
        if (!u.runnable) for (const r of u.reasons) add(c.id, r);
      }
      for (let i = 0; i < picked.length; i++) {
        for (let j = i + 1; j < picked.length; j++) {
          const ind = checkIndependence(toPlanCommand(picked[i]!), toPlanCommand(picked[j]!), q.hotspots, plans);
          if (!ind.independent && ind.reason) {
            add(picked[i]!.id, ind.reason);
            add(picked[j]!.id, ind.reason);
          }
        }
      }
      const free = clampMaxParallel(q.maxParallel) - codingRunningCount(manager);
      if (picked.length > free) {
        const msg = `Không đủ chỗ: cần ${picked.length}, còn ${Math.max(0, free)} (tối đa ${clampMaxParallel(q.maxParallel)} run lập trình song song).`;
        for (const c of picked) add(c.id, msg);
      }
      const budget = budgetState(queueSpent(all, replanCosts(replanDir(manager.config.dataDir, name))), q.maxBudgetUsd);
      if (!budget.canOpenNew) for (const c of picked) add(c.id, budget.message);
      const rejected: { id: string; reasons: string[] }[] = [];
      for (const [id, rs] of reasons) if (rs.length) rejected.push({ id, reasons: rs });
      if (rejected.length) return json(res, 200, { started: [], rejected });
      const started: { id: string; run: RunRecord }[] = [];
      for (const c of picked) {
        try {
          if (c.status === "chờ duyệt") manager.queue.transition(name, c.id, "đã duyệt");
          started.push({ id: c.id, run: await manager.startQueuedCommand(name, c.id) });
        } catch (e) {
          rejected.push({ id: c.id, reasons: [errorMessage(e).message] });
        }
      }
      return json(res, 200, { started, rejected });
    }

    if (target === undefined || target === "delete-idea" || target === "run-parallel" || target === "run-all" || target === "approve-all") return json(res, 404, { error: "not_found", message: "Đường dẫn không tồn tại." });
    const cmd = manager.queue.get(name, target);
    if (!cmd) return notFound(target);

    if (action === undefined && method === "PATCH") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const patch: { title?: string; body?: string; files?: string[]; dependsOn?: string[] } = {};
      const bad = (message: string) => json(res, 400, { error: "invalid", message });
      const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
      if (body["title"] !== undefined) {
        if (typeof body["title"] !== "string" || !body["title"].trim()) return bad("title phải là chuỗi không rỗng.");
        patch.title = body["title"];
      }
      if (body["body"] !== undefined) {
        if (typeof body["body"] !== "string" || !body["body"].trim()) return bad("body phải là chuỗi không rỗng.");
        const safety = checkBodySafety(body["body"]);
        if (safety.errors.length) return bad(`Lệnh "${cmd.id}": ${safety.errors.join(" ")}`);
        patch.body = body["body"];
      }
      if (body["files"] !== undefined) {
        if (!strArr(body["files"])) return bad("files phải là mảng chuỗi.");
        patch.files = body["files"];
      }
      if (body["dependsOn"] !== undefined) {
        if (!strArr(body["dependsOn"])) return bad("dependsOn phải là mảng chuỗi.");
        patch.dependsOn = body["dependsOn"];
      }
      if (Object.keys(patch).length === 0) return bad("Cần ít nhất một trường trong title, body, files, dependsOn.");
      if (cmd.status !== "chờ duyệt" && cmd.status !== "đã duyệt") {
        return json(res, 409, { error: "already_ran", message: "Lệnh đã chạy, hãy chạy lại để sửa." });
      }
      const all = manager.queue.list(name);
      if (patch.dependsOn) {
        const ids = new Set(all.map((c) => c.id));
        for (const d of patch.dependsOn) {
          if (d === cmd.id) return bad(`Lệnh "${cmd.id}" không thể phụ thuộc chính nó.`);
          if (!ids.has(d)) return bad(`dependsOn trỏ tới lệnh không tồn tại "${d}".`);
        }
      }
      const hypo = all.map((c) =>
        c.id === cmd.id ? { ...c, ...(patch.files ? { files: patch.files } : {}), ...(patch.dependsOn ? { dependsOn: patch.dependsOn } : {}) } : c,
      );
      const check = safeWaves(hypo, q.hotspots);
      if (check.error) return bad(check.error);
      const edited = manager.queue.editCommand(name, cmd.id, patch);
      const after = manager.queue.list(name);
      const { waves, error } = safeWaves(after, q.hotspots);
      const history = store.listRuns({ kind: "coding", limit: 20 }).map((r) => r.cost_usd_est);
      const updated = after.find((c) => c.id === edited.id) ?? edited;
      return json(res, 200, { command: describeQueueCommand(manager, updated, after, waves, history), waveError: error });
    }

    if (action === "skip" && method === "POST") {
      const command = manager.queue.transition(name, cmd.id, "bỏ qua");
      return json(res, 200, { command });
    }

    if (action === "confirm-done" && method === "POST") {
      if (cmd.status !== "đang chạy" && cmd.status !== "lỗi") {
        throw new QueueError("bad_transition", `Không thể xác nhận xong lệnh "${cmd.id}" đang "${cmd.status}".`, true);
      }
      if (manager.isQueueRunLive(cmd)) throw new QueueError("bad_transition", "Run còn đang chạy, hãy hủy run trước.", true);
      const command = manager.queue.transition(name, cmd.id, "đã commit");
      manager.closeOrphanQueueRuns(cmd);
      return json(res, 200, { command });
    }

    if (action === "mark-failed" && method === "POST") {
      if (cmd.status !== "đang chạy") {
        throw new QueueError("bad_transition", `Không thể đánh dấu lỗi lệnh "${cmd.id}" đang "${cmd.status}".`, true);
      }
      if (manager.isQueueRunLive(cmd)) throw new QueueError("bad_transition", "Run còn đang chạy, hãy hủy run trước.", true);
      const command = manager.queue.transition(name, cmd.id, "lỗi");
      manager.closeOrphanQueueRuns(cmd);
      manager.recordQueueLesson(name, cmd, "người dùng đánh dấu lỗi bằng tay");
      return json(res, 200, { command });
    }

    if (action === "confirm-merged" && method === "POST") {
      return json(res, 200, { command: manager.queue.transition(name, cmd.id, "đã gộp") });
    }

    if (action === "retry" && method === "POST") {
      if (cmd.status !== "lỗi") throw new QueueError("bad_transition", `Không thể chạy lại lệnh "${cmd.id}" đang "${cmd.status}".`, true);
      return json(res, 200, { command: manager.queue.transition(name, cmd.id, "đã duyệt") });
    }

    if (action === "unskip" && method === "POST") {
      if (cmd.status !== "bỏ qua") throw new QueueError("bad_transition", `Không thể hoàn tác bỏ qua lệnh "${cmd.id}" đang "${cmd.status}".`, true);
      return json(res, 200, { command: manager.queue.transition(name, cmd.id, "chờ duyệt") });
    }

    if (action === "approve-run" && method === "POST") {
      if (cmd.status === "chờ duyệt") manager.queue.transition(name, cmd.id, "đã duyệt");
      else if (cmd.status !== "đã duyệt") {
        // "lỗi" → "đã duyệt" is allowed in the table (retry), but approve-run only accepts pending/approved commands.
        throw new QueueError("bad_transition", `Không thể duyệt và chạy lệnh "${cmd.id}" đang "${cmd.status}".`, true);
      }
      const all = manager.queue.list(name);
      const approved = all.find((c) => c.id === cmd.id)!;
      const chk = queueRunCheck(manager, name, approved, all);
      if (!chk.ok && chk.waiting) {
        // Only the slot limit is in the way: keep the command approved and start it automatically, in order.
        manager.enqueueQueuedCommand(name, cmd.id);
        return json(res, 200, { started: false, waiting: true, command: approved, reasons: chk.reasons });
      }
      if (!chk.ok) return json(res, 200, { started: false, command: approved, reasons: chk.reasons });
      try {
        const run = await manager.startQueuedCommand(name, cmd.id);
        return json(res, 200, { started: true, run, command: manager.queue.get(name, cmd.id) });
      } catch (e) {
        return json(res, 200, { started: false, command: manager.queue.get(name, cmd.id), reasons: [errorMessage(e).message] });
      }
    }
    return json(res, 404, { error: "not_found", message: "Đường dẫn không tồn tại." });
  } catch (e) {
    if (e instanceof QueueError) return json(res, queueErrorStatus(e), { error: e.code, message: e.message });
    throw e;
  }
}
