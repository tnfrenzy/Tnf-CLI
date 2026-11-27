import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { defaultOutputDir } from "../../core/app/outputs.js";
import { PASS, type RouteResult, errorMessage, fileNameHeader, json, readBody, readRawBody } from "../http-util.js";
import { normalizeSetupFiles, normalizeSetupTimeout, validateSetupCommand } from "../../core/git/worktree-setup.js";
import type { ApiContext } from "../api-context.js";

/** `/api/grants`, `/api/projects/<name>/preview`, `/api/projects/<name>/worktree-setup`, `/api/settings/output-dir` and `/api/outputs/save`: what runs may touch and where their files go. */
export async function handleGrantRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<RouteResult> {
  const { manager } = ctx;
  const p = url.pathname;
  const method = req.method ?? "GET";
  // ---- Grants ----
  if (p === "/api/grants" && method === "GET") {
    const project = new URL(req.url ?? "/", "http://localhost").searchParams.get("project");
    return json(res, 200, manager.getGrants(project));
  }
  if (p === "/api/grants" && method === "PUT") {
    const body = (await readBody(req)) as Record<string, unknown>;
    try {
      const project = typeof body["project"] === "string" && body["project"] ? body["project"] : "__default__";
      return json(res, 200, { grants: manager.setGrants(project, body["grants"]) });
    } catch (e) {
      return json(res, 400, { error: "bad_request", ...errorMessage(e) });
    }
  }
  // ---- Preview config (per environment) ----
  const prevM = /^\/api\/projects\/([^/]+)\/preview$/.exec(p);
  if (prevM) {
    const name = decodeURIComponent(prevM[1]!);
    if (method === "GET") {
      if (!manager.store.getProject(name)) return json(res, 404, { error: "not_found", message: "Không tìm thấy môi trường." });
      return json(res, 200, { preview: manager.getPreviewConfig(name) });
    }
    if (method === "PUT") {
      if (!manager.store.getProject(name)) return json(res, 404, { error: "not_found", message: "Không tìm thấy môi trường." });
      const body = (await readBody(req)) as Record<string, unknown>;
      try {
        return json(res, 200, { preview: manager.setPreviewConfig(name, body["preview"]) });
      } catch (e) {
        return json(res, 400, { error: "bad_request", ...errorMessage(e) });
      }
    }
  }
  // ---- Worktree setup (per environment) ----
  const wsM = /^\/api\/projects\/([^/]+)\/worktree-setup$/.exec(p);
  if (wsM && (method === "GET" || method === "PUT")) {
    try {
      const name = decodeURIComponent(wsM[1]!);
      const project = manager.store.getProject(name);
      if (!project) return json(res, 404, { error: "not_found", message: "Không tìm thấy môi trường." });
      if (method === "GET") {
        return json(res, 200, { setup: manager.store.getProjectWorktreeSetup(name), allowedCommands: project.allowed_commands });
      }
      const body = (await readBody(req)) as unknown;
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Nội dung gửi lên phải là một đối tượng JSON.");
      const setupRaw = (body as Record<string, unknown>)["setup"];
      if (typeof setupRaw !== "object" || setupRaw === null || Array.isArray(setupRaw)) throw new Error("Thiếu trường setup (phải là đối tượng).");
      const s = setupRaw as Record<string, unknown>;
      const files = normalizeSetupFiles(s["files"] ?? []);
      const timeoutSec = normalizeSetupTimeout(s["timeoutSec"]);
      const rawCmd = s["command"];
      if (rawCmd !== undefined && rawCmd !== null && typeof rawCmd !== "string") throw new Error("Lệnh setup phải là chuỗi hoặc để trống.");
      const command = typeof rawCmd === "string" && rawCmd.trim() ? rawCmd.trim() : null;
      const bad = validateSetupCommand(command, project.allowed_commands);
      if (bad) throw new Error(bad);
      const setup = { files, command, timeoutSec };
      manager.store.setProjectWorktreeSetup(name, setup);
      return json(res, 200, { setup });
    } catch (e) {
      return json(res, 400, { error: "bad_request", ...errorMessage(e) });
    }
  }
  // ---- Output folder ----
  if (p === "/api/settings/output-dir" && method === "GET") {
    return json(res, 200, { outputDir: manager.outputDir(), defaultDir: defaultOutputDir(manager.config.workspaceDir) });
  }
  if (p === "/api/settings/output-dir" && method === "PUT") {
    try {
      const body = (await readBody(req)) as Record<string, unknown>;
      return json(res, 200, { outputDir: manager.setOutputDir(body["outputDir"] as string), defaultDir: defaultOutputDir(manager.config.workspaceDir) });
    } catch (e) {
      return json(res, 400, { error: "bad_request", ...errorMessage(e) });
    }
  }
  if (p === "/api/outputs/save" && method === "POST") {
    const group = typeof req.headers["x-output-group"] === "string" ? req.headers["x-output-group"].trim() : "";
    const name = fileNameHeader(req);
    if (!group || !name) return json(res, 400, { error: "bad_request", message: "Thiếu tên tệp hoặc nhóm thư mục." });
    try {
      const data = await readRawBody(req, 50 * 1024 * 1024);
      return json(res, 200, { ok: true, path: manager.saveOutputFile(group, name, data) });
    } catch (e) {
      return json(res, 400, { error: "save_failed", ...errorMessage(e) });
    }
  }
  return PASS;
}
