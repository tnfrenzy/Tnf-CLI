// src/server/codevideo-routes.ts — /api/codevideo/*: code-driven video projects, settings, jobs and files.
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { CvCore } from "../core/codevideo/index.js";
import { CvError, isValidSlug } from "../core/codevideo/index.js";
import { listModels3d } from "../core/codevideo/models3d.js";
import { findBrowser, findFfmpeg } from "../core/codevideo/render/index.js";

const JSON_LIMIT = 1024 * 1024;
const ASSET_LIMIT = 200 * 1024 * 1024;
const GENERIC = "Lỗi nội bộ khi xử lý Xưởng Dựng Video.";
const NOT_ALLOWED = { error: "method_not_allowed", message: "Phương thức không được hỗ trợ." };

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  json: "application/json; charset=utf-8",
};
const MEDIA = new Set(["mp4", "webm", "mov", "mp3", "wav", "m4a", "ogg"]);

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
  res.end(data);
}

function readRaw(req: IncomingMessage, limit: number, tooBig: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new CvError(tooBig, 413));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => (over ? reject(new CvError(tooBig, 413)) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req, JSON_LIMIT, "Nội dung quá lớn (tối đa 1 MB).");
  if (raw.length === 0) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new CvError("JSON không hợp lệ.", 400);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new CvError("Nội dung phải là một đối tượng JSON.", 400);
  return v as Record<string, unknown>;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new CvError("Đường dẫn không hợp lệ.", 400);
  }
}

function parseRange(h: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return null;
  const a = m[1] ?? "";
  const b = m[2] ?? "";
  if (a === "" && b === "") return null;
  let start: number;
  let end: number;
  if (a === "") {
    const n = Number(b);
    if (n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!(start <= end) || start >= size) return null;
  return { start, end };
}

function sendFile(req: IncomingMessage, res: ServerResponse, abs: string, extra: Record<string, string> = {}): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    send(res, 404, { error: "not_found", message: "Không tìm thấy tệp." });
    return;
  }
  const ext = path.extname(abs).slice(1).toLowerCase();
  const media = MEDIA.has(ext);
  const headers: Record<string, string | number> = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  };
  if (ext === "svg") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  if (media) headers["accept-ranges"] = "bytes";
  const rangeHeader = req.headers["range"];
  let start = 0;
  let end = st.size - 1;
  if (media && typeof rangeHeader === "string") {
    const r = parseRange(rangeHeader, st.size);
    if (!r) {
      res.writeHead(416, { "content-range": `bytes */${st.size}`, "cache-control": "no-store" });
      res.end();
      return;
    }
    start = r.start;
    end = r.end;
    headers["content-range"] = `bytes ${start}-${end}/${st.size}`;
    headers["content-length"] = end - start + 1;
    res.writeHead(206, headers);
  } else {
    headers["content-length"] = st.size;
    res.writeHead(200, headers);
  }
  if (st.size === 0) {
    res.end();
    return;
  }
  fs.createReadStream(abs, { start, end })
    .on("error", () => res.destroy())
    .pipe(res);
}

function downloadHeaders(title: string, ext: string): Record<string, string> {
  const clean =
    title
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f"/\\<>:|?*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 80) || "video";
  const ascii = clean.replace(/[^A-Za-z0-9._ -]/g, "_");
  return { "content-disposition": `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${clean}.${ext}`)}` };
}

/** Only these folders of a project may be served through the file route. */
const SERVED_DIRS = new Set(["out", "assets"]);

/** Handles /api/codevideo[...]; returns false when the path is not one of these routes. */
export async function handleCodeVideoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
  method: string,
  ctx: { core: CvCore | null; viaTunnel: boolean; log?: (m: string) => void },
): Promise<boolean> {
  if (p !== "/api/codevideo" && !p.startsWith("/api/codevideo/")) return false;
  const core = ctx.core;
  if (!core) {
    send(res, 503, { error: "codevideo_unavailable", message: "Xưởng Dựng Video chưa sẵn sàng." });
    return true;
  }
  const log = ctx.log ?? (() => undefined);
  const parts = p.split("/").filter(Boolean).slice(2); // after ["api","codevideo"]
  try {
    if (parts.length === 0) {
      if (method === "GET") {
        const s = core.settings.get();
        send(res, 200, {
          projects: core.store.list().map((x) => ({ ...x, job: core.job(x.slug) })),
          tools: { browser: findBrowser() !== null || !!s.browserPath, ffmpeg: findFfmpeg() !== null || !!s.ffmpegPath },
        });
      } else if (method === "POST") {
        if (ctx.viaTunnel) throw new CvError("Không tạo video qua đường hầm.", 403);
        const body = await readJson(req);
        const num = (k: string): number | undefined => (typeof body[k] === "number" ? (body[k] as number) : undefined);
        const project = core.create({
          title: String(body["title"] ?? ""),
          brief: String(body["brief"] ?? ""),
          ...(num("width") !== undefined ? { width: num("width")! } : {}),
          ...(num("height") !== undefined ? { height: num("height")! } : {}),
          ...(num("fps") !== undefined ? { fps: num("fps")! } : {}),
          ...(num("duration") !== undefined ? { duration: num("duration")! } : {}),
          ...(typeof body["model3dSession"] === "string" && body["model3dSession"] ? { model3dSession: body["model3dSession"] } : {}),
        });
        send(res, 201, project);
      } else send(res, 405, NOT_ALLOWED);
      return true;
    }

    const first = parts[0]!;
    if (first === "models3d" && parts.length === 1) {
      if (method !== "GET") send(res, 405, NOT_ALLOWED);
      else send(res, 200, { models: core.models3d ? listModels3d(core.models3d) : [] });
      return true;
    }
    if (first === "settings" && parts.length === 1) {
      if (method === "GET") send(res, 200, core.settings.get());
      else if (method === "PUT") {
        if (ctx.viaTunnel) throw new CvError("Không đổi cài đặt Xưởng Dựng Video qua đường hầm.", 403);
        send(res, 200, core.settings.update(await readJson(req)));
      } else send(res, 405, NOT_ALLOWED);
      return true;
    }

    const slug = decode(first);
    if (!isValidSlug(slug)) throw new CvError("Không tìm thấy dự án video.", 404);
    const sub = parts[1];
    if (parts.length === 1) {
      if (method === "GET") {
        send(res, 200, { ...core.store.get(slug), assets: core.store.listAssets(slug), job: core.job(slug) });
      } else if (method === "DELETE") {
        if (ctx.viaTunnel) throw new CvError("Không xóa video qua đường hầm.", 403);
        core.store.get(slug);
        if (core.job(slug)) throw new CvError("Dự án đang bận, hãy hủy trước khi xóa.", 409);
        core.store.remove(slug);
        send(res, 200, { ok: true });
      } else send(res, 405, NOT_ALLOWED);
      return true;
    }

    if (parts.length === 2 && sub === "assets") {
      if (method !== "POST") {
        send(res, 405, NOT_ALLOWED);
        return true;
      }
      core.store.get(slug);
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const hdr = req.headers["x-file-name"];
      const name = typeof hdr === "string" && hdr !== "" ? decode(hdr).trim() : (q.get("name") ?? "").trim();
      if (name === "") throw new CvError("Thiếu tên tệp (header x-file-name hoặc query name).", 400);
      const data = await readRaw(req, ASSET_LIMIT, "Tệp quá lớn (tối đa 200 MB).");
      if (data.length === 0) throw new CvError("Tệp rỗng.", 400);
      send(res, 201, core.store.addAsset(slug, name, data));
      return true;
    }

    if (parts.length === 2 && sub && ["generate", "revise", "render", "cancel"].includes(sub)) {
      if (method !== "POST") {
        send(res, 405, NOT_ALLOWED);
        return true;
      }
      if (ctx.viaTunnel) throw new CvError("Không chạy dựng video qua đường hầm.", 403);
      core.store.get(slug);
      if (sub === "cancel") {
        send(res, 200, { cancelled: core.cancel(slug) });
        return true;
      }
      let job;
      if (sub === "generate") job = core.startGenerate(slug);
      else if (sub === "render") job = core.startRender(slug);
      else {
        const body = await readJson(req);
        job = core.startRevise(slug, typeof body["instruction"] === "string" ? body["instruction"] : "");
      }
      void core.whenIdle(slug).catch((e: unknown) => log(`codevideo ${slug} ${sub}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
      send(res, 202, { state: core.store.get(slug).state, job });
      return true;
    }

    if (parts.length === 2 && sub === "file") {
      if (method !== "GET") {
        send(res, 405, NOT_ALLOWED);
        return true;
      }
      core.store.get(slug);
      const rel = new URL(req.url ?? "/", "http://localhost").searchParams.get("path");
      if (!rel) throw new CvError("Thiếu tham số path.", 400);
      const abs = core.store.resolveInside(slug, rel);
      const top = path.relative(core.store.dir(slug), abs).split(path.sep)[0] ?? "";
      if (!SERVED_DIRS.has(top)) throw new CvError("Không tìm thấy tệp.", 404);
      sendFile(req, res, abs);
      return true;
    }

    if (parts.length === 2 && sub === "download") {
      if (method !== "GET") {
        send(res, 405, NOT_ALLOWED);
        return true;
      }
      const project = core.store.get(slug);
      if (!project.video) throw new CvError("Dự án chưa có video đã dựng.", 404);
      const abs = core.store.resolveInside(slug, project.video);
      sendFile(req, res, abs, downloadHeaders(project.title, path.extname(abs).slice(1) || "mp4"));
      return true;
    }
    send(res, 404, { error: "not_found", message: "Không có đường dẫn này." });
  } catch (e) {
    if (res.headersSent) {
      res.destroy();
      return true;
    }
    if (e instanceof CvError) send(res, e.status, { error: "codevideo_error", message: e.message });
    else {
      log(`codevideo route ${method} ${p}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      send(res, 500, { error: "internal", message: GENERIC });
    }
  }
  return true;
}
