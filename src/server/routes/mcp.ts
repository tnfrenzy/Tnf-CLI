import { spawn } from "node:child_process";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { sanitizeEnv } from "../../core/run/billing-guard.js";
import { MCP_PRESETS, loadMcpServers, saveMcpServers, validateMcpServer, type McpServer, type CliMcpItem } from "../../core/mcp/mcp-registry.js";
import { probeMcp } from "../../core/mcp/mcp-probe.js";
import { readCliSnapshot, writeCliSnapshot, runClaudeMcpList } from "../../core/mcp/mcp-cli.js";
import { PASS, type RouteResult, errorMessage, isViaTunnel, json, readBody } from "../http-util.js";
import type { ApiContext } from "../api-context.js";

const REDACTED = "***";

function redactMap(m: Record<string, string> | undefined): Record<string, string> | undefined {
  return m ? Object.fromEntries(Object.keys(m).map((k) => [k, REDACTED])) : m;
}

/** Response view of a registry server: header and env values (bearer tokens, API keys) are never sent back to the browser. */
function redactServer(s: McpServer): McpServer {
  const out: McpServer = { ...s };
  if (s.headers) out.headers = redactMap(s.headers)!;
  if (s.env) out.env = redactMap(s.env)!;
  return out;
}

/**
 * A PUT may echo redacted values back: keep the stored value for every key whose value is still the placeholder.
 * Trade-off: a secret that is literally "***" cannot be set to a new "***" over an existing key (it keeps the stored one).
 */
function restoreMap(cur: Record<string, string> | undefined, incoming: unknown): unknown {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) merged[k] = v === REDACTED && cur?.[k] !== undefined ? cur[k] : v;
  return merged;
}

function restoreSecrets(cur: McpServer, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...patch };
  if ("headers" in out) out["headers"] = restoreMap(cur.headers, out["headers"]);
  if ("env" in out) out["env"] = restoreMap(cur.env, out["env"]);
  return out;
}

/** Concurrent `claude mcp list` refreshes share one in-flight call (it health-checks every server and is slow). */
let cliRefreshInFlight: Promise<{ at: number; items: CliMcpItem[] }> | null = null;

/** `/api/mcp/*`: the MCP registry of Settings > Kết nối MCP (secrets are redacted on the way out and restored on the way in). */
export async function handleMcpRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<RouteResult> {
  const { manager } = ctx;
  const p = url.pathname;
  const method = req.method ?? "GET";
  // ---- MCP registry (Settings > Kết nối MCP) ----
  if (p === "/api/mcp" && method === "GET") {
    return json(res, 200, { servers: loadMcpServers(manager.config.dataDir).map(redactServer), presets: MCP_PRESETS, cli: readCliSnapshot(manager.config.dataDir) });
  }
  if (p === "/api/mcp" && method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    try {
      const preset = typeof body["preset"] === "string" ? MCP_PRESETS.find((x) => x.id === body["preset"]) : undefined;
      if (typeof body["preset"] === "string" && !preset) return json(res, 400, { error: "bad_request", message: "Mẫu MCP không tồn tại." });
      const server = validateMcpServer(preset ? { ...preset, enabled: true } : body);
      const list = loadMcpServers(manager.config.dataDir);
      if (list.some((x) => x.id === server.id)) return json(res, 400, { error: "bad_request", message: "Đã có máy chủ MCP cùng id." });
      saveMcpServers(manager.config.dataDir, [...list, server]);
      return json(res, 201, { server: redactServer(server) });
    } catch (e) {
      return json(res, 400, { error: "bad_request", ...errorMessage(e) });
    }
  }
  if (p === "/api/mcp/cli/refresh" && method === "POST") {
    try {
      cliRefreshInFlight ??= runClaudeMcpList(manager.claudePathForTools(), sanitizeEnv(manager.env, "subscription"))
        .then((items) => writeCliSnapshot(manager.config.dataDir, items))
        .finally(() => {
          cliRefreshInFlight = null;
        });
      return json(res, 200, await cliRefreshInFlight);
    } catch (e) {
      return json(res, 500, { error: "mcp_list_failed", ...errorMessage(e) });
    }
  }
  if (p === "/api/mcp/cli/login" && method === "POST") {
    if (isViaTunnel(req)) return json(res, 403, { error: "local_only", message: "Chỉ mở được trên máy chạy app, không mở qua kết nối từ xa." });
    // OAuth only works inside interactive `claude` (/mcp): open a terminal there for the user (fixed args, no user input).
    // Env is stripped of API keys like every other claude launch (CLAUDE.md rule 3).
    const opened = await new Promise<Error | null>((resolve) => {
      const child = spawn("cmd.exe", ["/c", "start", "", "cmd.exe", "/k", "claude"], {
        shell: false,
        detached: true,
        stdio: "ignore",
        cwd: manager.config.workspaceDir,
        env: sanitizeEnv(manager.env, "subscription"),
      });
      child.once("error", (e) => resolve(e));
      child.once("spawn", () => {
        child.unref();
        resolve(null);
      });
    });
    if (opened) return json(res, 500, { error: "login_failed", message: `Không mở được cửa sổ đăng nhập: ${opened.message}` });
    return json(res, 200, { ok: true });
  }
  const mcpM = /^\/api\/mcp\/([a-z0-9_-]+)(?:\/(probe))?$/.exec(p);
  if (mcpM) {
    const id = mcpM[1]!;
    const list = loadMcpServers(manager.config.dataDir);
    const cur = list.find((x) => x.id === id);
    if (!cur) return json(res, 404, { error: "not_found", message: "Không tìm thấy máy chủ MCP." });
    if (mcpM[2] === "probe" && method === "POST") {
      if (isViaTunnel(req)) return json(res, 403, { error: "local_only", message: "Chỉ kiểm tra được trên máy chạy app, không kiểm tra qua kết nối từ xa." });
      return json(res, 200, await probeMcp(cur));
    }
    if (!mcpM[2] && method === "PUT") {
      try {
        const patch = restoreSecrets(cur, (await readBody(req)) as Record<string, unknown>);
        const server = validateMcpServer({ ...cur, ...patch, id });
        saveMcpServers(manager.config.dataDir, list.map((x) => (x.id === id ? server : x)));
        return json(res, 200, { server: redactServer(server) });
      } catch (e) {
        return json(res, 400, { error: "bad_request", ...errorMessage(e) });
      }
    }
    if (!mcpM[2] && method === "DELETE") {
      saveMcpServers(manager.config.dataDir, list.filter((x) => x.id !== id));
      return json(res, 200, { ok: true });
    }
  }
  return PASS;
}
