import { type IncomingMessage, type ServerResponse } from "node:http";
import { buildCleanupPlan, parseOlderThan } from "../../core/git/cleanup-plan.js";
import { executeCleanup } from "../../core/git/worktree-cleanup.js";
import { scanUsage } from "../../core/usage/usage-blocks.js";
import { TUNING_LIMITS, clampMaxRuns, loadAppSettings, saveAppSettings } from "../../core/app/app-settings.js";
import { validateW3DModels } from "../../core/workshop3d/model-settings.js";
import { QUEUE_MAX_PARALLEL_CEILING } from "../../core/app/config.js";
import { PASS, type RouteResult, errorMessage, json, readBody } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

/** Worktree cleanup, usage blocks and the app-wide settings (`/api/cleanup*`, `/api/usage/blocks`, `/api/settings/{max-runs,workshop3d-models,tuning}`). */
export async function handleSettingsRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<RouteResult> {
  const { manager, store, opts } = ctx;
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (p === "/api/cleanup/preview" && method === "GET") {
    try {
      const days = parseOlderThan(url.searchParams.get("olderThan") ?? undefined);
      if (days === null) return json(res, 400, { error: "bad_request", message: "Giá trị olderThan không hợp lệ: cần số nguyên từ 1 trở lên (số ngày)." });
      const { plan, executeOpts } = await buildCleanupPlan({ config: manager.config, store, days, now: Date.now() });
      const preview = await executeCleanup({ ...executeOpts, dryRun: true });
      return json(res, 200, { olderThan: days, plan, inboxRemoved: preview.inboxRemoved });
    } catch (e) {
      return json(res, 500, { error: "cleanup_failed", ...errorMessage(e) });
    }
  }
  if (p === "/api/cleanup" && method === "POST") {
    // Deliberate deviation from existing delete APIs (no server-side confirmation): this bulk delete requires
    // an explicit `confirm: true` in the body. "Current plan" = recomputed now; executeCleanup re-checks each worktree.
    try {
      const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
      if (body["confirm"] !== true) return json(res, 400, { error: "confirm_required", message: "Cần xác nhận rõ: gửi confirm:true trong nội dung yêu cầu để dọn." });
      const raw = body["olderThan"];
      if (raw !== undefined && raw !== null && typeof raw !== "number" && typeof raw !== "string") return json(res, 400, { error: "bad_request", message: "olderThan phải là số nguyên hoặc chuỗi số." });
      const days = parseOlderThan(raw === undefined || raw === null ? undefined : typeof raw === "number" ? String(raw) : raw);
      if (days === null) return json(res, 400, { error: "bad_request", message: "Giá trị olderThan không hợp lệ: cần số nguyên từ 1 trở lên (số ngày)." });
      const busy = store.listRuns({ limit: 100000 }).some((r) => r.status === "queued" || r.status === "running" || manager.isActive(r.id));
      if (busy) return json(res, 409, { error: "still_running", message: "Đang có run chạy hoặc chờ chạy; chờ xong rồi dọn." });
      const { plan, executeOpts } = await buildCleanupPlan({ config: manager.config, store, days, now: Date.now() });
      const out = await executeCleanup({ ...executeOpts, dryRun: false });
      return json(res, 200, { plan, results: out.results, inboxRemoved: out.inboxRemoved });
    } catch (e) {
      return json(res, 500, { error: "cleanup_failed", ...errorMessage(e) });
    }
  }
  if (p === "/api/usage/blocks" && method === "GET") {
    try {
      return json(res, 200, await (opts.usageScan ?? scanUsage)({}));
    } catch (e) {
      return json(res, 500, { error: "usage_failed", ...errorMessage(e) });
    }
  }
  if (p === "/api/settings/max-runs" && method === "GET") {
    return json(res, 200, { maxRuns: manager.maxRuns(), ceiling: QUEUE_MAX_PARALLEL_CEILING, running: manager.codingActiveCount(), waiting: manager.waitingList() });
  }
  if (p === "/api/settings/max-runs" && method === "PUT") {
    const body = (await readBody(req)) as Record<string, unknown>;
    if (clampMaxRuns(body["maxRuns"]) === null) return json(res, 400, { error: "bad_request", message: `Số lệnh run tối đa phải là số từ 1 đến ${QUEUE_MAX_PARALLEL_CEILING}.` });
    return json(res, 200, { maxRuns: manager.setMaxRuns(body["maxRuns"] as number), ceiling: QUEUE_MAX_PARALLEL_CEILING });
  }
  // Model per role group of the 3D workshop (works even when the workshop engine is unavailable).
  if (p === "/api/settings/workshop3d-models" && method === "GET") {
    return json(res, 200, { models: loadAppSettings(manager.config.dataDir).workshop3d?.models ?? {}, options: manager.config.models });
  }
  if (p === "/api/settings/workshop3d-models" && method === "PUT") {
    const check = validateW3DModels(await readBody(req), manager.config.models.map((m) => m.id));
    if (!check.ok) return json(res, 400, { error: "bad_request", message: check.message });
    const saved = saveAppSettings(manager.config.dataDir, { workshop3d: { models: check.models } });
    return json(res, 200, { models: saved.workshop3d?.models ?? {}, options: manager.config.models });
  }
  if (p === "/api/settings/tuning" && method === "GET") {
    return json(res, 200, { values: manager.tuning(), models: manager.allAvailableModels(), limits: TUNING_LIMITS, roleCallsCeiling: manager.config.limits.maxRoleCallsCeiling ?? 30 });
  }
  if (p === "/api/settings/tuning" && method === "PUT") {
    const body = await readBody(req);
    try {
      return json(res, 200, { values: manager.setTuning(body) });
    } catch (e) {
      return json(res, 400, { error: "bad_request", ...errorMessage(e) });
    }
  }
  return PASS;
}
