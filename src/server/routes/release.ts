import { type IncomingMessage, type ServerResponse } from "node:http";
import { dryRunRelease, executeRelease, newReleaseId, readReleaseLogChecked } from "../../core/release/pipeline.js";
import { findIscc } from "../../core/release/inno.js";
import { RELEASE_TEMPLATES, ReleaseConfigError, readReleaseConfig, writeReleaseConfig } from "../../core/release/config.js";
import { PASS, type RouteResult, errorMessage, isViaTunnel, json, readBody } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

/** `/api/releases/*`, `/api/projects/<name>/release` and `/release-config`: the release pipeline of an environment. */
export async function handleReleaseRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<RouteResult> {
  const { manager, store, opts } = ctx;
  const p = url.pathname;
  const method = req.method ?? "GET";
  const relGet = /^\/api\/releases\/([^/]+)$/.exec(p);
  if (relGet && method === "GET") {
    const log = readReleaseLogChecked(manager.config.dataDir, decodeURIComponent(relGet[1]!));
    if (!log) return json(res, 404, { error: "not_found", message: "Không tìm thấy bản ghi phát hành." });
    return json(res, 200, log);
  }
  const relPost = /^\/api\/projects\/([^/]+)\/release$/.exec(p);
  if (relPost && method === "POST") {
    const projectName = decodeURIComponent(relPost[1]!);
    const project = store.getProject(projectName);
    if (!project) return json(res, 404, { error: "project_not_found", message: "Không tìm thấy project." });
    if (!project.repo_path) return json(res, 400, { error: "no_repo", message: "Project không có repo đích; không thể phát hành." });
    const body = (await readBody(req)) as Record<string, unknown>;
    const dryRun = body["dryRun"] !== false;
    let branch: string | null = null;
    if (typeof body["runId"] === "string" && body["runId"]) {
      const r = store.getRun(body["runId"]);
      if (!r) return json(res, 404, { error: "not_found", message: "Không tìm thấy lần chạy." });
      if (r.status === "running" || manager.isActive(r.id)) return json(res, 409, { error: "run_active", message: "Lần chạy chưa xong; hãy chờ xong hoặc hủy trước khi phát hành." });
      branch = r.branch ?? null;
    }
    let config;
    try {
      config = readReleaseConfig(manager.config.dataDir, projectName);
    } catch (e) {
      return json(res, 400, { error: "invalid_release_config", ...errorMessage(e) });
    }
    if (!config) return json(res, 400, { error: "no_release_config", message: "Project chưa có cấu hình phát hành; hãy đặt mẫu hoặc cấu hình trước." });
    const repoPath = project.repo_path;
    const baseBranch = project.base_branch || "main";
    const deps = opts.releaseDeps ?? {};
    if (dryRun) {
      const iscc = findIscc(deps.env ?? process.env, deps.exists) ?? undefined;
      return json(res, 200, dryRunRelease({ repoPath, baseBranch, config, branch, ...(iscc ? { isccPath: iscc } : {}), ...(deps.env ? { env: deps.env } : {}) }));
    }
    if (isViaTunnel(req) && manager.config.release?.allowRemote !== true) {
      return json(res, 403, { error: "release_remote_disabled", message: "Phát hành thật bị tắt khi truy cập qua đường hầm/điện thoại. Hãy phát hành từ máy này hoặc bật release.allowRemote trong cấu hình." });
    }
    // The release runs the whole test suite; other runs executing at the same time made it take 12 min and time out.
    const busy = manager.activeCount();
    if (busy > 0) {
      return json(res, 409, { error: "runs_active", message: `Đang có ${busy} lần chạy hoạt động; bước test sẽ rất chậm và dễ quá thời gian. Hãy chờ chúng xong (hoặc hủy) rồi phát hành.` });
    }
    const releaseId = newReleaseId();
    void executeRelease({
      id: releaseId,
      dataDir: manager.config.dataDir, projectName, repoPath, baseBranch, config, branch,
      ...(deps.runner ? { runner: deps.runner } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.exists ? { exists: deps.exists } : {}), ...(deps.env ? { env: deps.env } : {}),
    }).catch(() => undefined);
    return json(res, 202, { releaseId });
  }
  const rcm = /^\/api\/projects\/([^/]+)\/release-config$/.exec(p);
  if (rcm && (method === "GET" || method === "PUT")) {
    const projectName = decodeURIComponent(rcm[1]!);
    if (!store.getProject(projectName)) return json(res, 404, { error: "project_not_found", message: "Không tìm thấy project." });
    const dataDir = manager.config.dataDir;
    try {
      if (method === "GET") return json(res, 200, { config: readReleaseConfig(dataDir, projectName), templates: RELEASE_TEMPLATES });
      const body = (await readBody(req)) as Record<string, unknown>;
      let input: unknown;
      if (typeof body["template"] === "string") {
        input = Object.prototype.hasOwnProperty.call(RELEASE_TEMPLATES, body["template"]) ? RELEASE_TEMPLATES[body["template"]] : undefined;
        if (!input) return json(res, 400, { error: "unknown_template", message: "Mẫu phát hành không tồn tại." });
      } else if (body["config"] !== undefined) {
        input = body["config"];
      } else {
        return json(res, 400, { error: "bad_request", message: "Cần trường config hoặc template." });
      }
      return json(res, 200, { config: writeReleaseConfig(dataDir, projectName, input), templates: RELEASE_TEMPLATES });
    } catch (e) {
      if (e instanceof ReleaseConfigError) return json(res, 400, { error: "invalid_release_config", message: e.message });
      return json(res, 400, { error: "invalid_release_config", ...errorMessage(e) });
    }
  }
  return PASS;
}
