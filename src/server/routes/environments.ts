import { spawn } from "node:child_process";
import fs from "node:fs";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { SKILL_WORKSHOP_PROJECT } from "../../core/skill-workshop/run-step.js";
import { WORKSHOP3D_PROJECT } from "../../core/workshop3d/step-adapter.js";
import { loadAppSettings, saveAppSettings } from "../../core/app/app-settings.js";
import { formatInfo } from "../../core/skill-workshop/output-formats.js";
import { disableServe, enableServe, findTailscale, phoneInfo } from "../../core/app/phone-access.js";
import { DEFAULT_STAFF_PATH, MAX_CONNECTIONS, publicView } from "../../core/app/api-connections.js";
import { TEMPLATES, defaultProjectsDir, scaffoldProject, type TemplateId } from "../../core/app/project-scaffold.js";
import { PASS, type RouteResult, errorMessage, isViaTunnel, json, readBody } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

/** Name of the removed legacy Video Studio project; old rows may still exist in the DB and must not be listed as environments. */
const LEGACY_VIDEOSTUDIO_PROJECT = "videostudio";
/** Internal repo-less project of the code-driven video coder runs: never an environment. */
const CODEVIDEO_PROJECT = "codevideo";

/** Environments and what surrounds them: `/api/projects` (list/create), `/api/connections/*`, the skills-gen "open folder" action, `/api/phone/*` and `/api/scaffold`. */
export async function handleEnvironmentRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<RouteResult> {
  const { manager, store, opts } = ctx;
  const { policy } = opts;
  const currentPhoneInfo = () => phoneInfo({ port: policy.port, token: policy.token, origins: policy.extraOrigins ?? [], exe: findTailscale() });
  const p = url.pathname;
  const method = req.method ?? "GET";
  // Skill training runs live in their own project; it is not an environment and never listed as one.
  if (p === "/api/projects" && method === "GET") return json(res, 200, { projects: store.listProjects().filter((x) => x.name !== SKILL_WORKSHOP_PROJECT && x.name !== WORKSHOP3D_PROJECT && x.name !== LEGACY_VIDEOSTUDIO_PROJECT && x.name !== CODEVIDEO_PROJECT) });
  if (p === "/api/projects" && method === "POST") {
    // CONTEXT-SPEC-v1 §8: {name, repo_path?, base_branch?, allowed_commands?}; repo_path null = plain label (research).
    const body = (await readBody(req)) as Record<string, unknown>;
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (!name) return json(res, 400, { error: "bad_request", message: "Thiếu tên project." });
    const repoPath = typeof body["repo_path"] === "string" && body["repo_path"].trim() ? body["repo_path"].trim() : null;
    const base = typeof body["base_branch"] === "string" && body["base_branch"].trim() ? body["base_branch"].trim() : null;
    const cmds = Array.isArray(body["allowed_commands"]) ? (body["allowed_commands"] as unknown[]).filter((c): c is string => typeof c === "string") : [];
    try {
      const project = manager.addProject({ name, repo_path: repoPath, base_branch: base, allowed_commands: cmds });
      return json(res, 201, { project });
    } catch (e) {
      return json(res, 400, { error: "invalid_project", ...errorMessage(e) });
    }
  }
  if (p === "/api/connections" && method === "GET") {
    return json(res, 200, { connections: manager.connections.list().map(publicView), max: MAX_CONNECTIONS, defaultPath: DEFAULT_STAFF_PATH });
  }
  if (p === "/api/connections" && method === "POST") {
    try {
      const c = manager.connections.add((await readBody(req)) as Record<string, unknown>);
      return json(res, 201, { connection: publicView(c) });
    } catch (e) {
      return json(res, 400, { error: "bad_request", ...errorMessage(e) });
    }
  }
  const connM = /^\/api\/connections\/([^/]+)(?:\/(staff))?$/.exec(p);
  if (connM) {
    const cid = decodeURIComponent(connM[1]!);
    if (connM[2] === "staff" && method === "GET") {
      const r = await manager.connections.staff(cid);
      if (!r) return json(res, 404, { error: "not_found", message: "Không tìm thấy kết nối." });
      return json(res, 200, r);
    }
    if (!connM[2] && method === "DELETE") {
      if (!manager.connections.remove(cid)) return json(res, 404, { error: "not_found", message: "Không tìm thấy kết nối." });
      return json(res, 200, { ok: true });
    }
  }
  const openM = /^\/api\/skills-gen\/sessions\/([a-z0-9-]{1,40})\/rounds\/([1-9][0-9]{0,5})\/open\/([a-z]+)$/.exec(p);
  if (openM && method === "POST") {
    // Open a round's sample file in the program Windows associates with it (local use only: it opens a window on this PC).
    if (isViaTunnel(req)) return json(res, 403, { error: "local_only", message: "Chỉ mở được trên máy chạy app, không mở qua kết nối từ xa. Hãy dùng nút Tải." });
    const info = formatInfo(openM[3]!);
    if (!info) return json(res, 400, { error: "bad_format", message: "Định dạng tệp không hợp lệ." });
    const file = path.join(manager.config.dataDir, "skills-gen", openM[1]!, `round-${openM[2]}`, `sample.${info.ext}`);
    if (!fs.existsSync(file)) return json(res, 404, { error: "sample_missing", message: "Chưa có tệp mẫu cho vòng này." });
    try {
      const child = spawn("explorer.exe", [file], { detached: true, stdio: "ignore", windowsHide: false });
      child.on("error", () => undefined);
      child.unref();
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { error: "open_failed", ...errorMessage(e) });
    }
  }
  if (p === "/api/phone" && method === "GET") {
    return json(res, 200, currentPhoneInfo());
  }
  if (p === "/api/phone/enable" && method === "POST") {
    const exe = findTailscale();
    if (!exe) return json(res, 400, { error: "no_tailscale", message: "Chưa cài Tailscale trên máy này. Cài từ tailscale.com/download rồi đăng nhập." });
    const before = currentPhoneInfo();
    if (!before.running || !before.origin) return json(res, 400, { error: "tailscale_off", message: "Tailscale chưa chạy hoặc chưa đăng nhập. Mở Tailscale và đăng nhập rồi thử lại." });
    const r = enableServe(exe, policy.port);
    if (!r.ok) return json(res, 400, { error: "serve_failed", message: r.message });
    const saved = loadAppSettings(manager.config.dataDir).allowedOrigins ?? [];
    if (!saved.includes(before.origin)) saveAppSettings(manager.config.dataDir, { allowedOrigins: [...saved, before.origin] });
    if (!(policy.extraOrigins ??= []).includes(before.origin)) policy.extraOrigins.push(before.origin);
    return json(res, 200, { ...currentPhoneInfo(), message: r.message });
  }
  if (p === "/api/phone/disable" && method === "POST") {
    const exe = findTailscale();
    const info = currentPhoneInfo();
    const r = exe ? disableServe(exe) : { ok: true, message: "Không tìm thấy Tailscale; chỉ gỡ quyền truy cập." };
    if (info.origin) {
      const saved = loadAppSettings(manager.config.dataDir).allowedOrigins ?? [];
      saveAppSettings(manager.config.dataDir, { allowedOrigins: saved.filter((o) => o !== info.origin) });
      if (policy.extraOrigins) policy.extraOrigins = policy.extraOrigins.filter((o) => o !== info.origin);
    }
    return json(res, r.ok ? 200 : 400, { ...currentPhoneInfo(), message: r.message });
  }
  if (p === "/api/scaffold" && method === "GET") {
    return json(res, 200, { templates: TEMPLATES, defaultParent: defaultProjectsDir(manager.config.workspaceDir) });
  }
  if (p === "/api/scaffold" && method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    try {
      const r = scaffoldProject(
        { name: str("name"), template: body["template"] as TemplateId, goal: str("goal"), parentDir: str("parentDir") },
        { defaultParent: defaultProjectsDir(manager.config.workspaceDir), dataDir: manager.config.dataDir },
      );
      const project = manager.addProject({ name: str("name").trim(), repo_path: r.dir, base_branch: "main", allowed_commands: [] });
      return json(res, 201, { project, dir: r.dir, files: r.files, memory: r.memoryPath });
    } catch (e) {
      return json(res, 400, { error: "scaffold_failed", ...errorMessage(e) });
    }
  }
  return PASS;
}
