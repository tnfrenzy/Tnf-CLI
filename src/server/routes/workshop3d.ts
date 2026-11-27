import { spawn } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { validateInboxName } from "../../core/run/inbox.js";
import { readStagedW3DImages } from "../../core/workshop3d/attachments.js";
import { workshop3dUnavailableMessage } from "../../core/workshop3d/index.js";
import type { TurntableOptions } from "../../core/workshop3d/turntable.js";
import { PASS, type RouteResult, SKILL_BODY_LIMIT, W3DBadRequest, errorMessage, isViaTunnel, json, readBody, readSkillBody, w3dBriefFromBody, w3dErrorResponse, W3D_TEXT_MAX } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

/** Body of POST .../turntable -> options; every field optional, a bad type is a 400 (ranges are clamped by normalizeTurntable). */
export function turntableOptionsFromBody(body: Record<string, unknown>): TurntableOptions {
  const out: TurntableOptions = {};
  for (const k of ["width", "height", "durationSec", "fps", "samples", "elevationDeg", "turns"] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new W3DBadRequest(`Giá trị "${k}" phải là một số.`);
    out[k] = v;
  }
  const bg = body["background"];
  if (bg !== undefined) {
    if (bg !== null && (typeof bg !== "string" || !/^#[0-9a-fA-F]{6}$/.test(bg))) throw new W3DBadRequest("Màu nền phải dạng #rrggbb hoặc null (trong suốt).");
    out.background = bg;
  }
  const eng = body["engine"];
  if (eng !== undefined) {
    if (eng !== "eevee" && eng !== "cycles") throw new W3DBadRequest('Bộ render phải là "eevee" hoặc "cycles".');
    out.engine = eng;
  }
  if (body["pedestal"] !== undefined) {
    if (typeof body["pedestal"] !== "boolean") throw new W3DBadRequest('"pedestal" phải là true hoặc false.');
    out.pedestal = body["pedestal"];
  }
  return out;
}

/** `/api/workshop3d/*`: sessions of the 3D workshop (503 while the engine is unavailable). */
export async function handleWorkshop3dRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<RouteResult> {
  const { manager, w3d, workshop3d } = ctx;
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (p === "/api/workshop3d" || p.startsWith("/api/workshop3d/")) {
    const parts = p.split("/").filter(Boolean); // ["api","workshop3d", slug?, action?]
    if (!workshop3d) return json(res, 503, { error: "w3d_unavailable", message: workshop3dUnavailableMessage(w3d.error) });
    try {
      if (parts.length === 2 && method === "GET") return json(res, 200, { sessions: workshop3d.listForApi(), kit: workshop3d.kit() });
      if (parts.length === 2 && method === "POST") {
        const body = await readSkillBody(req, SKILL_BODY_LIMIT);
        // Preflight: without the CAD python the session would only fail at the build step, after four role calls.
        const brief = w3dBriefFromBody(body);
        // Reference images: staged one by one with POST /api/inbox, then named here by their stage id.
        const stage = body["inbox_stage"];
        let images: Record<string, Buffer> = {};
        let stageDir: string | null = null;
        if (stage !== undefined && stage !== null) {
          if (typeof stage !== "string" || validateInboxName(stage)) throw new W3DBadRequest("Mã đính kèm không hợp lệ.");
          stageDir = manager.stageDir(stage);
          images = readStagedW3DImages(stageDir);
        }
        const missing = workshop3d.preflight();
        if (missing) return json(res, 503, { error: "cad_unavailable", message: missing });
        const slug = workshop3d.runner.start(brief, images);
        if (stageDir) fs.rmSync(stageDir, { recursive: true, force: true });
        return json(res, 201, { slug });
      }
      if (parts.length >= 3 && parts.length <= 4) {
        let slug: string;
        try {
          slug = decodeURIComponent(parts[2]!);
        } catch {
          return json(res, 404, { error: "not_found", message: "Không tìm thấy phiên dựng 3D." });
        }
        const detail = workshop3d.detail(slug);
        if (!detail) return json(res, 404, { error: "not_found", message: "Không tìm thấy phiên dựng 3D." });
        const action = parts[3];
        if (!action && method === "GET") return json(res, 200, detail);
        if (!action && method === "DELETE") {
          // "Xóa bản dựng": the whole session folder, nothing outside it; 409 while it runs, bakes or renders.
          const r = workshop3d.remove(slug);
          return json(res, 200, { ok: true, bytes: r.bytes });
        }
        if (action === "file" && method === "GET") {
          const rel = new URL(req.url ?? "/", "http://localhost").searchParams.get("path") ?? "";
          const info = workshop3d.filePath(slug, rel);
          res.writeHead(200, {
            "content-type": info.contentType,
            "content-length": info.size,
            "content-disposition": `${info.inline ? "inline" : "attachment"}; filename="${path.basename(info.abs).replace(/[^\w.-]/g, "_")}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          return void fs.createReadStream(info.abs).on("error", () => res.destroy()).pipe(res);
        }
        if (method === "POST" && action === "presentation") {
          // "Tạo trang trình bày": (re)builds outputs/trinh-bay/index.html from the session's files (no agent, no Blender).
          if (!workshop3d.buildPresentation) return json(res, 503, { error: "presentation_unavailable", message: "Trang trình bày chưa bật trên máy chủ này." });
          const r = workshop3d.buildPresentation(slug);
          const delivered = workshop3d.deliver?.(slug) ?? null;
          return json(res, 200, { ok: true, dir: r.dir, delivery: delivered?.dir ?? null, images: r.images, hasModel: r.hasModel, doorOpen: r.doorOpen, warnings: r.warnings });
        }
        if (action === "turntable" && method === "DELETE") {
          // "Hủy render video quay tròn": kills the running Blender / ffmpeg of this session.
          return json(res, 200, { ok: true, cancelled: workshop3d.cancelTurntable?.(slug) ?? false });
        }
        if (action === "turntable" && method === "POST") {
          // "Render video quay tròn": outputs/turntable.mp4 (or .webm when the background is transparent). Runs in the
          // background (202); progress is `turntable` of GET /api/workshop3d/<slug>, the file is listed in `files` when done.
          if (!workshop3d.turntable) return json(res, 503, { error: "turntable_unavailable", message: "Render video quay tròn chưa bật trên máy chủ này." });
          const opts = turntableOptionsFromBody(await readSkillBody(req, SKILL_BODY_LIMIT));
          const job = workshop3d.turntable(slug, opts);
          // A refusal (no Blender, no model, already running) answers at once; a real render answers 202.
          const early = await Promise.race([job.then((r) => ({ r })), new Promise<null>((resolve) => setTimeout(() => resolve(null), 60))]);
          if (early) {
            if (!early.r.ok) return json(res, 409, { error: "turntable_failed", message: early.r.error });
            return json(res, 200, { ok: true, file: early.r.file });
          }
          job.catch(() => undefined);
          return json(res, 202, { ok: true, started: true });
        }
        if (method === "POST" && action === "open") {
          // Opens the session's output folder, the presentation folder or its index.html on this PC (local use only).
          if (isViaTunnel(req)) return json(res, 403, { error: "local_only", message: "Chỉ mở được trên máy chạy app, không mở qua kết nối từ xa." });
          const what = String((((await readBody(req)) ?? {}) as Record<string, unknown>)["what"] ?? "");
          // Make sure the Settings output folder is up to date before opening anything in it.
          try {
            workshop3d.deliver?.(slug);
          } catch {
            // opening falls back to the session folder below
          }
          const pp = workshop3d.paths?.(slug);
          if (!pp) return json(res, 404, { error: "not_found", message: "Không tìm thấy thư mục của phiên." });
          const dl = pp.delivery;
          const target = what === "outputs" ? (dl ?? pp.outputs) : what === "session" ? pp.session : what === "presentation" ? (dl ? path.join(dl, "trinh-bay") : pp.presentation) : what === "index" && pp.presentation ? path.join(dl ?? pp.presentation, ...(dl ? ["trinh-bay"] : []), "index.html") : null;
          if (!target || !fs.existsSync(target)) return json(res, 404, { error: "not_found", message: "Chưa có thư mục hoặc tệp này. Bấm \"Tạo trang trình bày\" trước." });
          try {
            const child = spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: false });
            child.on("error", () => undefined);
            child.unref();
            return json(res, 200, { ok: true, path: target });
          } catch (e) {
            return json(res, 500, { error: "open_failed", ...errorMessage(e) });
          }
        }
        if (method === "POST" && action === "continue") {
          // "Dựng tiếp": one more round for a finished session, with the user's notes (what to change, what is not good enough).
          const body = await readSkillBody(req, SKILL_BODY_LIMIT);
          const text = body["text"];
          if (typeof text !== "string" || !text.trim()) throw new W3DBadRequest("Hãy ghi chỗ chưa hài lòng hoặc nội dung cần sửa.");
          if (text.length > W3D_TEXT_MAX) throw new W3DBadRequest(`Nội dung dài quá ${W3D_TEXT_MAX} ký tự.`);
          workshop3d.resetCancel();
          workshop3d.runner.continueWith(slug, text);
          return json(res, 200, { ok: true });
        }
        if (method === "POST" && action && ["answer", "pause", "resume", "stop", "rebuild"].includes(action)) {
          const body = action === "answer" || action === "rebuild" ? await readSkillBody(req, SKILL_BODY_LIMIT) : {};
          if (action === "answer") {
            const text = body["text"];
            if (typeof text !== "string" || !text.trim()) throw new W3DBadRequest("Câu trả lời đang trống.");
            if (text.length > W3D_TEXT_MAX) throw new W3DBadRequest(`Câu trả lời dài quá ${W3D_TEXT_MAX} ký tự.`);
            workshop3d.runner.answer(slug, text);
          } else if (action === "rebuild") {
            const pr = body["params"];
            if (pr !== undefined && (!pr || typeof pr !== "object" || Array.isArray(pr))) throw new W3DBadRequest("params phải là đối tượng tên -> giá trị.");
            workshop3d.runner.rebuild(slug, pr as Record<string, string | number> | undefined);
          } else if (action === "pause") workshop3d.runner.pause(slug);
          else if (action === "resume") workshop3d.runner.resume(slug);
          else workshop3d.runner.stop(slug);
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: "not_found", message: "Không có đường dẫn này." });
    } catch (e) {
      return w3dErrorResponse(res, e);
    }
  }
  return PASS;
}
