import path from "node:path";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { getRoleEvalService } from "../../core/roles/role-eval-runner.js";
import { RoleEvalStore } from "../../core/roles/role-eval-store.js";
import { roleVersionHash } from "../../core/roles/role-eval-util.js";
import { loadRoleGroups } from "../../core/usage/role-groups.js";
import { computeRoleStats } from "../../core/usage/role-stats.js";
import { suggestRoleReview } from "../../core/usage/role-stats-hints.js";
import { LibraryError } from "../../core/roles/role-library.js";
import { importAgentMd, type LibraryImportRequest } from "../../core/roles/agent-md-import.js";
import { addFromCatalog, catalogFile, readCatalog, searchCatalog } from "../../core/roles/role-catalog.js";
import { previewRestore, restoreWithCheck } from "../../core/roles/library-restore.js";
import { PASS, type RouteResult, errorMessage, httpStatusError, json, readBody, requireJsonObject } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

const TOO_LARGE = Symbol("too_large");

/** `/api/role-catalog` and `/api/library/*`: the role catalog and the role/skill/prompt library. */
export async function handleLibraryRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<RouteResult> {
  const { manager } = ctx;
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (p === "/api/role-catalog" && method === "GET") {
    const roles = searchCatalog(readCatalog(catalogFile(manager.config.repoRoot)), url.searchParams.get("q") ?? "");
    return json(res, 200, { roles, in_library: manager.library.list().roles.map((r) => r.id) });
  }
  if (p === "/api/library" || p.startsWith("/api/library/")) {
    // Role/skill/prompt library (data/library/library.json). Errors carry their own status; messages are Vietnamese.
    const lib = manager.library;
    const parts = p.split("/").filter(Boolean); // ["api","library", "roles"|"items", id?]
    try {
      if (parts.length === 2 && method === "GET") return json(res, 200, lib.list());
      if (parts.length === 5 && parts[2] === "roles" && parts[3] === "from-catalog" && method === "POST") {
        const role = addFromCatalog(readCatalog(catalogFile(manager.config.repoRoot)), decodeURIComponent(parts[4]!), lib);
        return json(res, 201, { role });
      }
      if (parts.length === 3 && parts[2] === "import" && method === "POST") {
        const ibody = requireJsonObject(await readBody(req, 160 * 1024));
        if (typeof ibody["text"] !== "string") throw httpStatusError(400, "Trường text phải là chuỗi.");
        const as = ibody["as"];
        if (as !== undefined && as !== "role" && as !== "skill" && as !== "prompt") {
          throw httpStatusError(400, "Trường as phải là role, skill hoặc prompt.");
        }
        if (ibody["id"] !== undefined && typeof ibody["id"] !== "string") throw httpStatusError(400, "Trường id phải là chuỗi.");
        if (ibody["filename"] !== undefined && typeof ibody["filename"] !== "string") {
          throw httpStatusError(400, "Trường filename phải là chuỗi.");
        }
        if (ibody["dryRun"] !== undefined && typeof ibody["dryRun"] !== "boolean") {
          throw httpStatusError(400, "Trường dryRun phải là true hoặc false.");
        }
        const iopts: LibraryImportRequest = { text: ibody["text"] };
        if (as !== undefined) iopts.as = as;
        if (typeof ibody["id"] === "string") iopts.id = ibody["id"];
        if (typeof ibody["filename"] === "string") iopts.filename = ibody["filename"];
        if (typeof ibody["dryRun"] === "boolean") iopts.dryRun = ibody["dryRun"];
        const result = importAgentMd(lib, iopts);
        if (iopts.dryRun) return json(res, 200, { preview: result.preview });
        const out: Record<string, unknown> = { preview: result.preview };
        if (result.created?.kind === "role") out["role"] = result.created.role;
        else if (result.created) out["item"] = result.created.item;
        return json(res, 201, out);
      }
      if (
        parts.length === 5 &&
        (parts[2] === "roles" || parts[2] === "items") &&
        ((parts[4] === "history" && method === "GET") || (parts[4] === "restore" && method === "POST"))
      ) {
        const kind = parts[2] === "roles" ? "role" : "item";
        const hid = decodeURIComponent(parts[3]!);
        if (parts[4] === "history") return json(res, 200, { versions: lib.history(kind, hid) });
        const rbody = requireJsonObject(await readBody(req, 160 * 1024));
        const versionId = rbody["versionId"];
        if (typeof versionId !== "string" || versionId === "") throw httpStatusError(400, "Trường versionId phải là chuỗi không rỗng.");
        if (rbody["note"] !== undefined && typeof rbody["note"] !== "string") throw httpStatusError(400, "Trường note phải là chuỗi.");
        if (rbody["dryRun"] !== undefined && typeof rbody["dryRun"] !== "boolean") {
          throw httpStatusError(400, "Trường dryRun phải là true hoặc false.");
        }
        if (rbody["confirm"] !== undefined && typeof rbody["confirm"] !== "boolean") {
          throw httpStatusError(400, "Trường confirm phải là true hoặc false.");
        }
        if (rbody["dryRun"] === true) return json(res, 200, previewRestore(lib, kind, hid, versionId));
        const ropts: { confirm?: boolean; note?: string } = {};
        if (typeof rbody["confirm"] === "boolean") ropts.confirm = rbody["confirm"];
        if (typeof rbody["note"] === "string") ropts.note = rbody["note"];
        const out = restoreWithCheck(lib, kind, hid, versionId, ropts);
        return json(res, 200, out);
      }
      if (parts[2] === "roles" && parts[4] === "evals" && (parts.length === 5 || parts.length === 6)) {
        const evalId = decodeURIComponent(parts[3]!);
        const evalRole = lib.getRole(evalId);
        if (!evalRole) return json(res, 404, { error: "not_found", message: `Không tìm thấy vai "${evalId}".` });
        const store = new RoleEvalStore(path.join(manager.config.dataDir, "library", "role-evals"));
        const svc = getRoleEvalService(manager);
        const readEvalBody = async (): Promise<unknown> => {
          try {
            return await readBody(req, 64 * 1024);
          } catch (err) {
            if ((err as { status?: number }).status === 413) return TOO_LARGE;
            throw err;
          }
        };
        if (parts.length === 5 && method === "GET") {
          return json(res, 200, {
            cases: store.getCases(evalId),
            results: store.listResults(evalId, 20),
            version: roleVersionHash(evalRole),
            running: svc.isRunning(evalId),
          });
        }
        if (parts.length === 5 && method === "PUT") {
          const raw = await readEvalBody();
          if (raw === TOO_LARGE) return json(res, 413, { error: "too_large", message: "Nội dung quá lớn." });
          const body = requireJsonObject(raw);
          const cases = store.setCases(evalId, body["cases"]);
          return json(res, 200, { cases, version: roleVersionHash(evalRole) });
        }
        if (parts.length === 6 && parts[5] === "run" && method === "POST") {
          const raw = await readEvalBody();
          if (raw === TOO_LARGE) return json(res, 413, { error: "too_large", message: "Nội dung quá lớn." });
          const body = requireJsonObject(raw);
          const repeats = body["repeats"];
          if (repeats !== undefined && (typeof repeats !== "number" || !Number.isInteger(repeats) || repeats < 1 || repeats > 3)) {
            throw httpStatusError(400, "repeats phải là số nguyên từ 1 đến 3.");
          }
          if (store.getCases(evalId).length === 0) throw httpStatusError(400, "Chưa có ca đánh giá nào cho vai này.");
          if (svc.isRunning(evalId)) {
            return json(res, 409, { error: "already_running", message: "Vai này đang được đánh giá." });
          }
          const started = svc.start(evalId, repeats);
          if (!started.started) {
            return json(res, 409, { error: "not_started", message: "Không thể bắt đầu đánh giá.", reason: started.reason });
          }
          return json(res, 202, { started: true });
        }
        if (parts.length === 6 && parts[5] === "cancel" && method === "POST") {
          return json(res, 200, { cancelled: svc.cancel(evalId) });
        }
      }
      if (parts.length === 3 && parts[2] === "role-stats" && method === "GET") {
        const rawDays = Number(url.searchParams.get("days"));
        const days = Number.isFinite(rawDays) && url.searchParams.get("days") !== null && url.searchParams.get("days") !== "" ? Math.min(90, Math.max(1, Math.floor(rawDays))) : 30;
        const to = Date.now();
        const from = to - days * 86400000;
        const runs = ctx.store.listRuns({ from, to, limit: 2000 });
        const denials = ctx.store.listPermissionDenials({ from, to });
        const groups = loadRoleGroups({
          codingAgentsFile: manager.config.defaults.coding.agentsFile,
          design3dAgentsFile: path.join(manager.config.repoRoot, "config", "roles-design3d.json"),
          libraryRoleIds: lib.list().roles.map((r) => r.id),
        });
        // Explicit minimal mapping: no prompt, reply, summary, output_file or paths reach the stats.
        const statsRuns = runs.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          verdicts: r.verdicts,
          agents: (r.agents ?? []).map((a) => ({
            agent_id: a.agent_id,
            role: a.role,
            usage: a.usage,
            ...(a.progress ? { progress: { total_tokens: a.progress.total_tokens, tool_uses: a.progress.tool_uses, duration_ms: a.progress.duration_ms } } : {}),
            parent_id: null,
            tool_use_id: null,
            status: a.status,
          })),
        }));
        const stats = computeRoleStats({ runs: statsRuns, denials, groups, from, to });
        return json(res, 200, {
          from,
          to,
          days,
          runsScanned: stats.runsScanned,
          runsWithoutAgents: stats.runsWithoutAgents,
          coordinatorDenials: stats.coordinatorDenials,
          truncated: runs.length === 2000,
          rows: stats.rows,
          hints: suggestRoleReview(stats),
        });
      }
      const coll = parts[2];
      const id =parts[3] ? decodeURIComponent(parts[3]) : undefined;
      if (parts.length <= 4 && (coll === "roles" || coll === "items")) {
        if (!id && method === "POST") {
          const body = (await readBody(req, 160 * 1024)) as Record<string, unknown>;
          return json(res, 201, coll === "roles" ? { role: lib.createRole(body) } : { item: lib.createItem(body) });
        }
        if (id && method === "PUT") {
          const body = (await readBody(req, 160 * 1024)) as Record<string, unknown>;
          return json(res, 200, coll === "roles" ? { role: lib.updateRole(id, body) } : { item: lib.updateItem(id, body) });
        }
        if (id && method === "DELETE") {
          if (coll === "roles") {
            lib.deleteRole(id);
            getRoleEvalService(manager).removeRole(id);
          } else lib.deleteItem(id);
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: "not_found", message: "Không có đường dẫn này." });
    } catch (e) {
      if (e instanceof LibraryError) return json(res, e.status, { error: "library_error", message: e.message });
      return json(res, 400, { error: "bad_request", ...errorMessage(e) });
    }
  }
  return PASS;
}
