import fs from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { CommentsError, PreviewError, readRoles, type OpenDirTarget, type StartRunInput } from "../../core/run/run-manager.js";
import { resolveReportText } from "../../core/run/report-text.js";
import { INBOX_MAX_BYTES, listInbox, saveInboxFile, validateInboxName } from "../../core/run/inbox.js";
import { buildZip } from "../../core/app/zip.js";
import { EXT_FORMAT as DESIGN3D_EXT_FORMAT } from "../../core/design3d/design3d-outputs.js";
import { errorMessage, fileNameHeader, isSecretRunFile, isViaTunnel, json, numOpt, readBody, readRawBody, safeJoin } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

/** `/api/runs/<id>/*`: everything about one run. Last group of the dispatcher, so it also answers the final 404. */
export async function handleRunRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { manager, store } = ctx;
  const p = url.pathname;
  const method = req.method ?? "GET";
  const m = /^\/api\/runs\/([^/]+)(?:\/(.*))?$/.exec(p);
  if (!m) return json(res, 404, { error: "not_found", message: "Không có đường dẫn này." });
  const runId = decodeURIComponent(m[1]!);
  const sub = m[2] ?? "";
  const run = store.getRun(runId);
  if (!run) return json(res, 404, { error: "not_found", message: "Không tìm thấy lần chạy." });

  if (sub === "" && method === "GET") {
    const project = store.getProject(run.project);
    const merged = manager.mergedFlag(run);
    return json(res, 200, {
      run: merged === undefined ? run : { ...run, merged },
      wait_reason: manager.waitReason(runId) ?? null,
      merged,
      merge_precheck: run.merge_precheck ?? null,
      active: manager.isActive(runId),
      artifacts: store.getArtifacts(runId),
      worktree_exists: manager.worktreeExists(run),
      repo_path: project?.repo_path ?? null,
      base_branch: project?.base_branch ?? null,
      stream_path: path.join(manager.config.dataDir, "runs", runId, "stream.jsonl"),
      inbox: listInbox(run.run_dir),
    });
  }
  if (sub === "roles" && method === "GET") {
    // Effective roles of the run (per-run override file wins, else the kind's default); prompts are not exposed.
    const d = manager.config.defaults;
    const override = path.join(manager.config.dataDir, "runs", runId, "roles.json");
    const file = fs.existsSync(override) ? override : run.kind === "coding" ? d.coding.agentsFile : d.agentsFile;
    const roles = Object.entries(readRoles(file)).map(([id, def]) => ({
      id,
      description: typeof def["description"] === "string" ? def["description"] : "",
      ...(typeof def["model"] === "string" ? { model: def["model"] } : {}),
    }));
    return json(res, 200, { roles });
  }
  if (sub === "model" && method === "GET") {
    const MAX_MODEL_BYTES = 50 * 1024 * 1024;
    const MODEL_TYPES: Record<string, string> = {
      stl: "model/stl",
      glb: "model/gltf-binary",
      gltf: "model/gltf+json",
      step: "application/step",
      obj: "model/obj",
    };
    const rel = url.searchParams.get("path") ?? "";
    if (!rel.trim()) return json(res, 400, { error: "bad_request", message: "Thiếu tham số path." });
    const format = DESIGN3D_EXT_FORMAT[path.extname(rel).toLowerCase()];
    if (!format) return json(res, 400, { error: "bad_request", message: "Đuôi tệp không phải mô hình 3D." });
    const file = isSecretRunFile(rel) ? null : safeJoin(run.run_dir, rel);
    if (!file) return json(res, 400, { error: "bad_request", message: "Đường dẫn không hợp lệ." });
    let real: string;
    let st: fs.Stats;
    try {
      const realRoot = fs.realpathSync(run.run_dir);
      real = fs.realpathSync(file);
      if (!(real + path.sep).startsWith(realRoot + path.sep) || real === realRoot) {
        return json(res, 400, { error: "bad_request", message: "Đường dẫn không hợp lệ." });
      }
      st = fs.statSync(real);
    } catch {
      return json(res, 404, { error: "not_found", message: "Không có tệp." });
    }
    if (!st.isFile()) return json(res, 404, { error: "not_found", message: "Không có tệp." });
    if (st.size > MAX_MODEL_BYTES) return json(res, 413, { error: "too_large", message: "Tệp 3D quá lớn (tối đa 50 MB)." });
    res.writeHead(200, { "content-type": MODEL_TYPES[format] ?? "application/octet-stream", "content-length": st.size, "cache-control": "no-store" });
    return void fs.createReadStream(real).pipe(res);
  }
  if (sub === "inbox" && method === "POST") {
    // Attach a file to an existing run (read by the next follow-up, or by the running agents if they look).
    const name = fileNameHeader(req);
    const bad = validateInboxName(name);
    if (bad) return json(res, 400, { error: "bad_request", message: bad });
    try {
      const data = await readRawBody(req, INBOX_MAX_BYTES);
      const file = saveInboxFile(run.run_dir, name, data);
      return json(res, 201, { ok: true, file, inbox: listInbox(run.run_dir) });
    } catch (e) {
      return json(res, 400, { error: "inbox_failed", ...errorMessage(e) });
    }
  }
  if (sub === "artifacts.zip" && method === "GET") {
    // "Tải tất cả": every recorded artifact (small text files) in one archive, built in memory.
    const entries = [];
    for (const a of store.getArtifacts(runId)) {
      if (isSecretRunFile(a.rel_path)) continue;
      const file = safeJoin(run.run_dir, a.rel_path);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      entries.push({ name: a.rel_path.replace(/\\/g, "/"), data: fs.readFileSync(file), mtime: a.mtime });
    }
    if (entries.length === 0) return json(res, 404, { error: "not_found", message: "Chưa có tệp nào." });
    const zip = buildZip(entries);
    res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length, "content-disposition": `attachment; filename="${runId}-artifacts.zip"`, "cache-control": "no-store" });
    return void res.end(zip);
  }
  if (sub === "quota-resume" && method === "GET") {
    return json(res, 200, { resume: manager.getQuotaResume(runId), max_attempts: manager.config.autoResume?.maxAttempts ?? 3 });
  }
  if (sub === "quota-resume/cancel" && method === "POST") {
    if (!manager.cancelQuotaResume(runId)) return json(res, 409, { error: "not_pending", message: "Không có hẹn tự tiếp tục đang chờ." });
    return json(res, 200, { ok: true });
  }
  if (sub === "open-output" && method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    try {
      const rel = typeof body["rel_path"] === "string" && body["rel_path"] ? body["rel_path"] : undefined;
      return json(res, 200, { ok: true, path: manager.openOutput(runId, rel) });
    } catch (e) {
      return json(res, 400, { error: "open_failed", ...errorMessage(e) });
    }
  }
  if (sub === "preview" && method === "POST") {
    try {
      return json(res, 202, { state: manager.startPreview(runId, { viaTunnel: isViaTunnel(req) }) });
    } catch (e) {
      if (e instanceof PreviewError) return json(res, { not_found: 404, bad_request: 400, forbidden: 403, conflict: 409 }[e.code], { error: e.code, ...errorMessage(e) });
      throw e;
    }
  }
  if (sub === "preview" && method === "GET") {
    return json(res, 200, { state: manager.getPreviewState(runId), config: run.project ? manager.getPreviewConfig(run.project) : { kind: "none" } });
  }
  if (sub.startsWith("preview/") && method === "GET") {
    let name = "";
    try {
      name = decodeURIComponent(sub.slice("preview/".length));
    } catch {
      /* malformed escape: falls through to 404 */
    }
    const file = manager.previewFile(runId, name);
    if (!file) return json(res, 404, { error: "not_found", message: "Không tìm thấy ảnh." });
    const data = fs.readFileSync(file);
    res.writeHead(200, { "content-type": "image/png", "content-length": data.length, "cache-control": "no-store" });
    return void res.end(data);
  }
  if (sub === "open-dir" && method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const target: OpenDirTarget = body["target"] === "worktree" ? "worktree" : "run_dir";
    try {
      return json(res, 200, { ok: true, path: manager.openDir(runId, target) });
    } catch (e) {
      return json(res, 400, { error: "open_failed", ...errorMessage(e) });
    }
  }
  if (sub === "cleanup-worktree" && method === "POST") {
    if (manager.isActive(runId)) return json(res, 409, { error: "still_running", message: "Lần chạy vẫn đang chạy; hãy chờ xong hoặc hủy trước." });
    try {
      return json(res, 200, { ok: true, ...manager.cleanupWorktree(runId) });
    } catch (e) {
      return json(res, 400, { error: "cleanup_failed", ...errorMessage(e) });
    }
  }
  if (sub === "release" && method === "POST") {
    if (manager.isActive(runId)) return json(res, 409, { error: "still_running", message: "Lần chạy vẫn đang chạy; hãy chờ xong hoặc hủy trước." });
    try {
      return json(res, 200, { ok: true, ...manager.releaseRun(runId) });
    } catch (e) {
      return json(res, 400, { error: "release_failed", ...errorMessage(e) });
    }
  }
  if (sub === "merge-precheck" && method === "POST") {
    // The branch always comes from the run record; nothing is read from the client.
    if (run.kind !== "coding" || !run.branch) return json(res, 400, { error: "bad_request", message: "Chỉ lần chạy lập trình có nhánh mới kiểm tra gộp được." });
    try {
      const result = manager.precheckMerge(run.id);
      if (result === undefined) return json(res, 400, { error: "precheck_failed", message: "Không kiểm tra được khả năng gộp nhánh này." });
      return json(res, 200, result);
    } catch (e) {
      return json(res, 400, { error: "precheck_failed", ...errorMessage(e) });
    }
  }
  if (sub === "publish" && method === "POST") {
    if (manager.isActive(runId)) return json(res, 409, { error: "still_running", message: "Lần chạy vẫn đang chạy; hãy chờ xong hoặc hủy trước." });
    if (manager.mergedFlag(run) === false) return json(res, 409, { error: "not_merged", message: "Nhánh chưa được commit vào main. Hãy commit vào main trước khi phát hành." });
    try {
      return json(res, 200, manager.publishRun(runId));
    } catch (e) {
      return json(res, 400, { error: "publish_failed", ...errorMessage(e) });
    }
  }
  if (sub === "events" && method === "GET") {
    const after = numOpt(url.searchParams.get("after")) ?? 0;
    return json(res, 200, { events: store.getEvents(runId, after) });
  }
  if (sub === "report" && method === "GET") {
    const text = resolveReportText(run.run_dir, run.result_text);
    if (text === null) return json(res, 404, { error: "no_report", message: "Chưa có report.md." });
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
    return void res.end(text);
  }
  if (sub.startsWith("artifacts/") && method === "GET") {
    const rel = decodeURIComponent(sub.slice("artifacts/".length));
    const file = isSecretRunFile(rel) ? null : safeJoin(run.run_dir, rel);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: "not_found", message: "Không có tệp." });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return void res.end(fs.readFileSync(file, "utf8"));
  }
  if (sub === "stream" && method === "GET") {
    const file = path.join(manager.config.dataDir, "runs", runId, "stream.jsonl");
    if (!fs.existsSync(file)) return json(res, 404, { error: "not_found", message: "Không có stream.jsonl." });
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    return void fs.createReadStream(file).pipe(res);
  }
  if (sub === "cancel" && method === "POST") {
    const ok = manager.cancel(runId);
    return json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "not_active", message: "Lần chạy này không còn chạy." });
  }
  if (sub === "followup" && method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const prompt = typeof body["prompt"] === "string" ? body["prompt"] : "";
    const over: Omit<StartRunInput, "prompt"> = {};
    const mt = numOpt(body["max_turns"]);
    if (mt !== undefined) over.maxTurns = mt;
    const mb = numOpt(body["budget_usd"]);
    if (mb !== undefined) over.maxBudgetUsd = mb;
    // A present, non-empty `comments` wins over `prompt` (prompt is ignored).
    const hasComments = "comments" in body && !(Array.isArray(body["comments"]) && body["comments"].length === 0);
    if (!hasComments && prompt.trim() === "") {
      return json(res, 400, { error: "empty_followup", message: "Cần nhập câu hỏi hoặc ít nhất một nhận xét." });
    }
    try {
      const child = hasComments
        ? await manager.followupWithComments(runId, body["comments"], over)
        : await manager.followup(runId, prompt, over);
      return json(res, 201, { run: child });
    } catch (e) {
      if (e instanceof CommentsError) return json(res, 400, { error: "invalid_comments", message: e.message });
      return json(res, 400, { error: "followup_failed", ...errorMessage(e) });
    }
  }
  return json(res, 404, { error: "not_found", message: "Không có đường dẫn này." });
}
