import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { BillingGuardError } from "../core/run/billing-guard.js";
import { type RunManager } from "../core/run/run-manager.js";
import { validateInboxName } from "../core/run/inbox.js";
import { SkillError, resolveInside } from "../core/skill-workshop/package.js";
import { ATTACH_LIMITS, ATTACH_RE, attachmentRel, validateAttachmentName } from "../core/skill-workshop/attachments.js";
import { W3DAttachmentError } from "../core/workshop3d/attachments.js";
import { W3DFileError } from "../core/workshop3d/index.js";
import { W3DError } from "../core/workshop3d/state.js";
import { W3D_BRIEF_LIMITS, type W3DBrief } from "../core/workshop3d/types.js";
import { normalizeSlots } from "../core/workshop3d/variants.js";

// Request/response helpers shared by the route modules of the local HTTP server.

/** A route group returns PASS when the request is not one of its routes, so the dispatcher tries the next group. */
export const PASS = Symbol("pass");
export type RouteResult = void | typeof PASS;

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function errorMessage(e: unknown): { message: string; kind?: string } {
  if (e instanceof BillingGuardError) return { message: e.message, kind: e.kind };
  if (e instanceof Error) return { message: e.message };
  return { message: String(e) };
}

export async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      if (tooLarge) return;
      data += c;
      if (data.length > limit) {
        // Do not destroy the socket: drain the rest so the handler can still answer 413.
        tooLarge = true;
        data = "";
        req.resume();
      }
    });
    req.on("end", () => {
      if (tooLarge) return reject(httpStatusError(413, "Nội dung quá lớn."));
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(httpStatusError(400, "JSON không hợp lệ."));
      }
    });
    req.on("error", reject);
  });
}

export function httpStatusError(status: 400 | 413, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Body must be a plain JSON object (not array, null or string); otherwise 400. */
export function requireJsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpStatusError(400, "Nội dung phải là một đối tượng JSON.");
  }
  return body as Record<string, unknown>;
}

/** Keep only https://<host>/… so secrets in path, query or fragment never leave the server. */
export function maskWebhookUrl(u: string): string {
  try {
    return `https://${new URL(u).host}/…`;
  } catch {
    return "https://…";
  }
}

export function autopilotView(manager: RunManager): {
  enabled: boolean;
  schedule: string | null;
  webhookCount: number;
  webhooks: string[];
  pruneDone: { enabled: boolean; keepDays: number; branches: boolean };
  pruneKept: { project: string; branch: string; reason: string }[];
  updatedAt: string;
} {
  const s = manager.autopilot.snapshot();
  return {
    enabled: s.enabled,
    schedule: s.schedule,
    webhookCount: s.webhooks.length,
    webhooks: s.webhooks.map(maskWebhookUrl),
    pruneDone: s.pruneDone,
    pruneKept: s.pruneKept,
    updatedAt: s.updatedAt,
  };
}

export const SUMMARY_MAX_RUNS = 1000;

export const SKILL_BODY_LIMIT =2.5 * 1024 * 1024;

export class BodyError extends Error {
  constructor(message: string, readonly code: "too_large" | "bad_json") {
    super(message);
  }
}

/** Shared error mapping for /api/skills and /api/skills-gen: SkillError -> its status, BodyError -> 400, else 500. */
export function skillErrorResponse(res: ServerResponse, e: unknown): void {
  if (e instanceof SkillError) return json(res, e.status, { error: e.code, message: e.message, ...(e.fields ? { fields: e.fields, errors: e.fields } : {}) });
  if (e instanceof BodyError) return json(res, 400, { error: e.code, message: e.message });
  return json(res, 500, { error: "internal", message: "Lỗi nội bộ khi xử lý skill." });
}

/** JSON body for skills: over the limit the rest is drained (socket stays open so the client gets the 400), then BodyError. */
export async function readSkillBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new BodyError("Nội dung quá lớn.", "too_large"));
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) return reject(new BodyError("JSON không hợp lệ.", "bad_json"));
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new BodyError("JSON không hợp lệ.", "bad_json"));
      }
    });
    req.on("error", reject);
  });
}

export const W3D_TEXT_MAX = W3D_BRIEF_LIMITS.object;
export const W3D_DETAILS = ["standard", "high", "ultra"];

export class W3DBadRequest extends Error {}

/** Brief from POST /api/workshop3d: a one-line prompt, or a full brief with the limits parseIntake applies. */
export function w3dBriefFromBody(body: Record<string, unknown>): W3DBrief {
  const att = body["attachments"];
  if (att !== undefined && !(Array.isArray(att) && att.length === 0)) {
    throw new W3DBadRequest("Ảnh mẫu tải lên qua POST /api/inbox rồi ghi mã đính kèm vào inbox_stage; khóa attachments chỉ nhận danh sách rỗng.");
  }
  const rawBrief = body["brief"];
  if (rawBrief === undefined || rawBrief === null) {
    const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
    if (!prompt) throw new W3DBadRequest("Hãy mô tả vật thể cần dựng (prompt) hoặc gửi brief.");
    if (prompt.length > W3D_TEXT_MAX) throw new W3DBadRequest(`Mô tả dài quá ${W3D_TEXT_MAX} ký tự.`);
    return { title: prompt.slice(0, 60), object: prompt, params: {}, detail: "high", attachments: [] };
  }
  if (typeof rawBrief !== "object" || Array.isArray(rawBrief)) throw new W3DBadRequest("brief phải là một đối tượng.");
  const b = rawBrief as Record<string, unknown>;
  const text = (v: unknown, max: number, label: string): string => {
    if (typeof v !== "string" || !v.trim()) throw new W3DBadRequest(`brief.${label} phải là chuỗi không rỗng.`);
    if (v.trim().length > max) throw new W3DBadRequest(`brief.${label} dài quá ${max} ký tự.`);
    return v.trim();
  };
  const detail = b["detail"] === undefined ? "high" : b["detail"];
  if (typeof detail !== "string" || !W3D_DETAILS.includes(detail)) throw new W3DBadRequest('brief.detail phải là "standard", "high" hoặc "ultra".');
  const params: Record<string, string | number> = {};
  if (b["params"] !== undefined) {
    const pr = b["params"];
    if (!pr || typeof pr !== "object" || Array.isArray(pr)) throw new W3DBadRequest("brief.params phải là đối tượng.");
    const entries = Object.entries(pr as Record<string, unknown>);
    if (entries.length > 50) throw new W3DBadRequest("brief.params tối đa 50 tham số.");
    for (const [k, v] of entries) {
      if (!k || k.length > 60) throw new W3DBadRequest("Tên tham số phải từ 1 đến 60 ký tự.");
      if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
      else if (typeof v === "string" && v.length <= 200) params[k] = v;
      else throw new W3DBadRequest(`Tham số ${k.slice(0, 60)} phải là số hữu hạn hoặc chuỗi ngắn.`);
    }
  }
  const L = W3D_BRIEF_LIMITS;
  const brief: W3DBrief = { title: text(b["title"], L.title, "title"), object: text(b["object"], L.object, "object"), params, detail: detail as W3DBrief["detail"], attachments: [] };
  if (b["material"] !== undefined) brief.material = text(b["material"], L.material, "material");
  if (b["purpose"] !== undefined) brief.purpose = text(b["purpose"], L.purpose, "purpose");
  if (b["slots"] !== undefined) {
    const slots = normalizeSlots(b["slots"]);
    if (!slots.ok) throw new W3DBadRequest(slots.error);
    if (slots.value.length > 0) brief.slots = slots.value;
  }
  return brief;
}

export function w3dErrorResponse(res: ServerResponse, e: unknown): void {
  if (e instanceof W3DError) return json(res, 409, { error: "w3d_state", message: e.message });
  if (e instanceof W3DFileError) return json(res, e.status, { error: "w3d_file", message: e.message });
  if (e instanceof W3DBadRequest) return json(res, 400, { error: "bad_request", message: e.message });
  if (e instanceof W3DAttachmentError) return json(res, 400, { error: "bad_attachment", message: e.message });
  if (e instanceof BodyError) return json(res, 400, { error: e.code, message: e.message });
  return json(res, 500, { error: "internal", message: "Lỗi nội bộ khi xử lý phiên dựng 3D." });
}

/** Raw body (attachments): bytes, capped; the request is destroyed once the cap is exceeded. */
export async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`Tệp quá lớn (tối đa ${limit / 1024 / 1024} MB).`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function fileNameHeader(req: IncomingMessage): string {
  const h = req.headers["x-file-name"];
  return typeof h === "string" ? h.trim() : "";
}

export function numOpt(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve a file inside a run directory, refusing path traversal. */
export function safeJoin(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  const normRoot = path.resolve(root) + path.sep;
  return abs.startsWith(normRoot) ? abs : null;
}

/** Validate `attachments` of POST /api/skills and read the staged files (`<stageDir>/inbox/<name>`); throws SkillError(400). */
export function readStagedAttachments(raw: unknown, manager: { stageDir(id: string): string }): { items: { pair: string; side: string; name: string; data: Buffer }[]; stageDirs: string[] } {
  const items: { pair: string; side: string; name: string; data: Buffer }[] = [];
  const stageDirs = new Set<string>();
  if (raw === undefined || raw === null) return { items, stageDirs: [] };
  const bad = (msg: string, code = "bad_attachment") => new SkillError(msg, 400, code);
  if (!Array.isArray(raw)) throw bad("`attachments` phải là một danh sách.");
  for (const a of raw) {
    if (!a || typeof a !== "object") throw bad("Mục tệp đính kèm không hợp lệ.");
    const { pair, side, stageId, names } = a as Record<string, unknown>;
    if (typeof stageId !== "string" || validateInboxName(stageId)) throw bad("Mã đính kèm không hợp lệ.", "bad_stage");
    if (typeof pair !== "string" || typeof side !== "string" || !Array.isArray(names)) throw bad("Mục tệp đính kèm thiếu cặp mẫu, phía hoặc danh sách tên tệp.");
    const stageDir = manager.stageDir(stageId);
    if (!fs.existsSync(stageDir)) throw bad("Không tìm thấy tệp đính kèm đã tải lên (mã đính kèm không tồn tại).", "bad_stage");
    stageDirs.add(stageDir);
    const inboxDir = path.join(stageDir, "inbox");
    for (const n of names) {
      if (typeof n !== "string") throw bad("Tên tệp đính kèm không hợp lệ.");
      const name = validateAttachmentName(n);
      if (!ATTACH_RE.test(attachmentRel(pair, side, name))) throw bad("Cặp mẫu hoặc phía của tệp đính kèm không hợp lệ.");
      const file = resolveInside(inboxDir, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(file);
      } catch {
        throw bad(`Tệp "${name}" chưa được tải lên (không có trong mã đính kèm).`, "attach_missing");
      }
      if (!st.isFile() || st.isSymbolicLink()) throw bad(`Tệp "${name}" không hợp lệ.`);
      if (st.size > ATTACH_LIMITS.fileBytes) throw bad(`Tệp "${name}" quá lớn (tối đa ${ATTACH_LIMITS.fileBytes / 1024 / 1024} MB mỗi tệp).`, "attach_too_big");
      items.push({ pair, side, name, data: fs.readFileSync(file) });
    }
  }
  return { items, stageDirs: [...stageDirs] };
}

/** JSON object body, or null when the body is missing, malformed or not an object. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostnameOf(value: string, isUrl: boolean): string | null {
  try {
    const u = new URL(isUrl ? value : `http://${value}`);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the request did not come straight from this machine: Host or Origin is not loopback.
 * Derived from the real connection headers only; X-Forwarded-* can only make the result stricter, never looser.
 */
/** `mcp.json` at a run-dir root may hold plaintext connector secrets: never served, whatever put it there. */
export function isSecretRunFile(rel: string): boolean {
  return rel.replace(/\\/g, "/").replace(/^(\.\/)+/, "").toLowerCase() === "mcp.json";
}

export function isViaTunnel(req: IncomingMessage): boolean {
  const host = req.headers.host;
  const h = typeof host === "string" ? hostnameOf(host, false) : null;
  if (!h || !LOCAL_HOSTNAMES.has(h)) return true;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin) {
    const o = hostnameOf(origin, true);
    if (!o || !LOCAL_HOSTNAMES.has(o)) return true;
  }
  if (req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"]) return true;
  return false;
}

export function authMessage(f: string): string {
  switch (f) {
    case "bad_host":
      return "Header Host không hợp lệ (chỉ chấp nhận 127.0.0.1/localhost hoặc tên trong server.allowedOrigins).";
    case "bad_origin":
      return "Origin không được phép.";
    default:
      return "Thiếu hoặc sai token điều khiển.";
  }
}
