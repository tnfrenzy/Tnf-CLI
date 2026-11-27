import { type IncomingMessage, type ServerResponse } from "node:http";
import { AUTOPILOT_SCHEDULE_MAX_LEN } from "../../core/queue/autopilot-state.js";
import { summarizePeriod } from "../../core/usage/period-summary.js";
import { findDuplicates } from "../../core/queue/queue-dup.js";
import { PASS, type RouteResult, autopilotView, errorMessage, json, readBody, requireJsonObject, SUMMARY_MAX_RUNS } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

/** `/api/autopilot/*`: schedule, webhooks and summaries of the autopilot. */
export async function handleAutopilotRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<RouteResult> {
  const { manager, store } = ctx;
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (p === "/api/autopilot" || p.startsWith("/api/autopilot/")) {
    const sub = p.slice("/api/autopilot/".length);
    const allowed: Record<string, string> = { status: "GET", enable: "POST", disable: "POST", schedule: "PUT", webhooks: "PUT", "prune-done": "PUT", summary: "GET", "check-duplicate": "POST" };
    const want = allowed[sub];
    if (!want) return json(res, 404, { error: "not_found", message: "Không tìm thấy đường dẫn autopilot." });
    if (method !== want) return json(res, 405, { error: "method_not_allowed", message: `Chỉ hỗ trợ ${want}.` });
    if (sub === "status") return json(res, 200, autopilotView(manager));
    if (sub === "summary") {
      const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
      const parseIso = (name: string): number | null | undefined => {
        const raw = url.searchParams.get(name);
        if (raw === null) return undefined;
        if (!ISO_RE.test(raw)) return null;
        const t = Date.parse(raw);
        return Number.isFinite(t) ? t : null;
      };
      const fromP = parseIso("from");
      const toP = parseIso("to");
      if (fromP === null) return json(res, 400, { error: "bad_request", message: "from phải là ngày ISO 8601." });
      if (toP === null) return json(res, 400, { error: "bad_request", message: "to phải là ngày ISO 8601." });
      const toMs = toP ?? Date.now();
      const fromMs = fromP ?? toMs - 24 * 3600 * 1000;
      if (fromMs > toMs) return json(res, 400, { error: "bad_request", message: "from không được sau to." });
      const filter = { from: fromMs, to: toMs };
      const runs = store.listRuns({ ...filter, limit: SUMMARY_MAX_RUNS });
      const truncated = store.countRuns(filter) > runs.length;
      const queueCommands = store.listProjects().flatMap((pr) => manager.queue.list(pr.name));
      const sum = summarizePeriod({ from: fromMs, to: toMs, runs, queueCommands });
      return json(res, 200, {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        ...sum,
        truncated,
        estimate: true,
      });
    }
    if (sub === "check-duplicate") {
      const dbody = requireJsonObject(await readBody(req));
      const keys = ["project", "title", "prompt", "files"];
      const extra = Object.keys(dbody).filter((k) => !keys.includes(k));
      if (extra.length) return json(res, 400, { error: "bad_request", message: `Khóa không hợp lệ: ${extra.join(", ")}.` });
      const { project: dproj, title, prompt, files } = dbody;
      if (typeof dproj !== "string" || !dproj.trim()) return json(res, 400, { error: "bad_request", message: "project phải là chuỗi không rỗng." });
      if (typeof title !== "string" || title.length < 1 || title.length > 200) {
        return json(res, 400, { error: "bad_request", message: "title phải là chuỗi 1..200 ký tự." });
      }
      if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > 20000)) {
        return json(res, 400, { error: "bad_request", message: "prompt phải là chuỗi tối đa 20000 ký tự." });
      }
      if (
        files !== undefined &&
        (!Array.isArray(files) || files.length > 50 || files.some((f) => typeof f !== "string" || f.length > 300))
      ) {
        return json(res, 400, { error: "bad_request", message: "files phải là mảng tối đa 50 chuỗi, mỗi chuỗi tối đa 300 ký tự." });
      }
      if (!store.getProject(dproj)) return json(res, 404, { error: "project_not_found", message: "Không tìm thấy project." });
      const duplicates = findDuplicates(
        {
          project: dproj,
          title,
          body: typeof prompt === "string" ? prompt : "",
          ...(Array.isArray(files) ? { files: files as string[] } : {}),
        },
        manager.queue.list(dproj),
      );
      return json(res, 200, { duplicates, hasHigh: duplicates.some((d) => d.level === "high") });
    }
    const abody = requireJsonObject(await readBody(req));
    if (sub === "prune-done") {
      const extra = Object.keys(abody).filter((k) => k !== "enabled" && k !== "keepDays" && k !== "branches");
      if (extra.length) return json(res, 400, { error: "bad_request", message: `Khóa không hợp lệ: ${extra.join(", ")}.` });
      const cur = manager.autopilot.snapshot().pruneDone;
      try {
        manager.setPruneDone(abody["enabled"] ?? cur.enabled, abody["keepDays"] ?? cur.keepDays, abody["branches"] ?? cur.branches);
      } catch (e) {
        return json(res, 400, { error: "invalid_prune_done", ...errorMessage(e) });
      }
      return json(res, 200, autopilotView(manager));
    }
    if (sub === "schedule" || sub === "webhooks") {
      const key = sub;
      const extra = Object.keys(abody).filter((k) => k !== key);
      if (extra.length) return json(res, 400, { error: "bad_request", message: `Khóa không hợp lệ: ${extra.join(", ")}.` });
      if (!(key in abody)) return json(res, 400, { error: "bad_request", message: `Thiếu khóa ${key}.` });
      if (key === "schedule") {
        const v = abody["schedule"];
        if (v !== null && typeof v !== "string") return json(res, 400, { error: "invalid_schedule", message: "schedule phải là chuỗi hoặc null." });
        if (typeof v === "string" && v.length > AUTOPILOT_SCHEDULE_MAX_LEN) {
          return json(res, 400, { error: "invalid_schedule", message: `Lịch tối đa ${AUTOPILOT_SCHEDULE_MAX_LEN} ký tự.` });
        }
        try {
          manager.autopilot.setSchedule(v);
        } catch (e) {
          return json(res, 400, { error: "invalid_schedule", ...errorMessage(e) });
        }
      } else {
        try {
          manager.setWebhooks(abody["webhooks"]);
        } catch (e) {
          return json(res, 400, { error: "invalid_webhooks", ...errorMessage(e) });
        }
      }
      return json(res, 200, autopilotView(manager));
    }
    if (sub === "enable") manager.autopilot.enable();
    else manager.autopilot.disable();
    return json(res, 200, autopilotView(manager));
  }
  return PASS;
}
