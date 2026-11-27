import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunStore } from "../../src/core/run/run-store.js";
import type { ApiContext } from "../../src/server/api-context.js";
import { handleGrantRoutes } from "../../src/server/routes/grants.js";

let server: http.Server;
let base: string;

beforeAll(async () => {
  const store = new RunStore(":memory:");
  store.upsertProject({ name: "p", repo_path: null, base_branch: null, allowed_commands: ["Bash(npm install*)"] });
  const ctx = { manager: { store } } as unknown as ApiContext;
  server = http.createServer((req, res) => {
    void handleGrantRoutes(ctx, req, res, new URL(req.url ?? "/", "http://x")).then((r) => {
      if (!res.writableEnded) {
        res.writeHead(404);
        res.end();
      }
      return r;
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const call = (method: string, url: string, body?: unknown) =>
  fetch(base + url, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
const put = (setup: unknown) => call("PUT", "/api/projects/p/worktree-setup", { setup });

describe("worktree-setup route", () => {
  it("GET returns defaults and allowedCommands", async () => {
    const r = await call("GET", "/api/projects/p/worktree-setup");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ setup: { files: [], command: null, timeoutSec: 180 }, allowedCommands: ["Bash(npm install*)"] });
  });
  it("PUT valid then GET shows it", async () => {
    const r = await put({ files: [".env"], command: "npm install", timeoutSec: 60 });
    expect(r.status).toBe(200);
    const want = { files: [".env"], command: "npm install", timeoutSec: 60 };
    expect(await r.json()).toEqual({ setup: want });
    const g = await call("GET", "/api/projects/p/worktree-setup");
    expect(((await g.json()) as { setup: unknown }).setup).toEqual(want);
  });
  it("blank command becomes null", async () => {
    const r = await put({ files: [], command: "   " });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ setup: { files: [], command: null, timeoutSec: 180 } });
  });
  it("rejects bad files with a Vietnamese message", async () => {
    const r = await put({ files: ["../x"] });
    expect(r.status).toBe(400);
    const b = (await r.json()) as { error: string; message: string };
    expect(b.error).toBe("bad_request");
    expect(b.message).toMatch(/Đường dẫn/);
    expect((await put({ files: ["/abs"] })).status).toBe(400);
    expect((await put({ files: ["C:\\x"] })).status).toBe(400);
  });
  it("rejects bad timeout and command", async () => {
    expect((await put({ timeoutSec: 5 })).status).toBe(400);
    expect((await put({ command: "rm -rf x" })).status).toBe(400);
    expect((await put({ command: 5 })).status).toBe(400);
  });
  it("404 for unknown environment", async () => {
    expect((await call("GET", "/api/projects/nope/worktree-setup")).status).toBe(404);
    expect((await call("PUT", "/api/projects/nope/worktree-setup", { setup: {} })).status).toBe(404);
  });
  it("400 for non-object body or missing setup", async () => {
    expect((await call("PUT", "/api/projects/p/worktree-setup", [1])).status).toBe(400);
    expect((await call("PUT", "/api/projects/p/worktree-setup", "x")).status).toBe(400);
    expect((await call("PUT", "/api/projects/p/worktree-setup", {})).status).toBe(400);
    expect((await call("PUT", "/api/projects/p/worktree-setup", { setup: null })).status).toBe(400);
    expect((await call("PUT", "/api/projects/p/worktree-setup", { setup: [] })).status).toBe(400);
  });
  it("400 for bad percent-encoding in the name", async () => {
    expect((await call("GET", "/api/projects/%E0%A4%A/worktree-setup")).status).toBe(400);
  });
});
