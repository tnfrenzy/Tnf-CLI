import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodeVideoCore, type CvCore, type CvStepManager } from "../../src/core/codevideo/index.js";
import type { RenderOptions, RenderResult } from "../../src/core/codevideo/render/index.js";
import { handleCodeVideoRoute } from "../../src/server/codevideo-routes.js";

let dataDir: string;
let core: CvCore;
let server: http.Server;
let base: string;
let viaTunnel = false;

const manager: CvStepManager = {
  startRun: async () => ({ id: "r1" }),
  waitFor: async () => ({ status: "done" }),
  cancel: () => true,
  store: { getProject: () => ({}), upsertProject: () => undefined },
};
const okRender = async (o: RenderOptions): Promise<RenderResult> => {
  fs.mkdirSync(path.dirname(o.outFile), { recursive: true });
  fs.writeFileSync(o.outFile, Buffer.from("0123456789"));
  return { ok: true, file: o.outFile, frames: 1, seconds: 1, encoder: "libx264", width: 1, height: 1, fps: 1, elapsedSec: 0, framesPerSec: 1 };
};

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-routes-"));
  viaTunnel = false;
  core = createCodeVideoCore({
    manager,
    dataDir,
    runner: async () => ({ ok: true, text: "", costUsd: 0, runId: "r" }),
    render: okRender,
    sheet: (async (o: { outFile: string }) => (fs.writeFileSync(o.outFile, "p"), { ok: true, file: o.outFile, count: 1 })) as never,
  });
  server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    void handleCodeVideoRoute(req, res, p, req.method ?? "GET", { core, viaTunnel }).then((h) => {
      if (!h) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const j = (method: string, url: string, body?: unknown) =>
  fetch(base + url, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });

describe("codevideo routes", () => {
  it("lists, creates, reads and deletes a project", async () => {
    const created = await j("POST", "/api/codevideo", { title: "Video thử", brief: "Mô tả", duration: 20 });
    expect(created.status).toBe(201);
    const p = (await created.json()) as { slug: string; duration: number };
    expect(p.duration).toBe(20);
    const list = (await (await j("GET", "/api/codevideo")).json()) as { projects: { slug: string }[]; tools: { browser: boolean } };
    expect(list.projects.map((x) => x.slug)).toContain(p.slug);
    expect(typeof list.tools.browser).toBe("boolean");
    const one = (await (await j("GET", `/api/codevideo/${p.slug}`)).json()) as { assets: unknown[] };
    expect(Array.isArray(one.assets)).toBe(true);
    expect((await j("DELETE", `/api/codevideo/${p.slug}`)).status).toBe(200);
    expect((await j("GET", `/api/codevideo/${p.slug}`)).status).toBe(404);
  });

  it("validates input and returns Vietnamese errors", async () => {
    const r = await j("POST", "/api/codevideo", { title: "", brief: "x" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { message: string }).message).toMatch(/tiêu đề/);
    expect((await j("GET", "/api/codevideo/..%2F..")).status).toBe(404);
    expect((await j("PATCH", "/api/codevideo")).status).toBe(405);
  });

  it("uploads assets and serves only out/ and assets/", async () => {
    const p = (await (await j("POST", "/api/codevideo", { title: "A", brief: "b" })).json()) as { slug: string };
    const up = await fetch(`${base}/api/codevideo/${p.slug}/assets`, { method: "POST", headers: { "x-file-name": encodeURIComponent("ảnh.png") }, body: Buffer.from("png") });
    expect(up.status).toBe(201);
    const a = (await up.json()) as { path: string };
    expect(a.path).toBe("assets/anh.png");
    expect((await fetch(`${base}/api/codevideo/${p.slug}/file?path=${encodeURIComponent(a.path)}`)).status).toBe(200);
    expect((await fetch(`${base}/api/codevideo/${p.slug}/file?path=project.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/codevideo/${p.slug}/file?path=${encodeURIComponent("assets/../project.json")}`)).status).toBe(404);
    expect((await fetch(`${base}/api/codevideo/${p.slug}/assets`, { method: "POST", headers: { "x-file-name": "x.exe" }, body: "a" })).status).toBe(400);
  });

  it("generate returns 202, then the video can be downloaded with Range", async () => {
    const p = (await (await j("POST", "/api/codevideo", { title: "Tải về", brief: "b" })).json()) as { slug: string };
    const g = await j("POST", `/api/codevideo/${p.slug}/generate`);
    expect(g.status).toBe(202);
    await core.whenIdle(p.slug);
    expect(core.store.get(p.slug).state).toBe("done");
    const d = await fetch(`${base}/api/codevideo/${p.slug}/download`);
    expect(d.status).toBe(200);
    expect(d.headers.get("content-disposition")).toMatch(/attachment; filename="T_i v_.*\.mp4"/);
    const r = await fetch(`${base}/api/codevideo/${p.slug}/file?path=out/video.mp4`, { headers: { range: "bytes=2-4" } });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe("234");
  });

  it("blocks mutating routes through the tunnel", async () => {
    viaTunnel = true;
    expect((await j("POST", "/api/codevideo", { title: "a", brief: "b" })).status).toBe(403);
    expect((await j("PUT", "/api/codevideo/settings", { reviewRounds: 2 })).status).toBe(403);
  });

  it("settings round-trip and reject bad values", async () => {
    const ok = await j("PUT", "/api/codevideo/settings", { reviewRounds: 2, brand: { hotline: "0900 111 222", colors: { accent: "#ff0000" } } });
    expect(ok.status).toBe(200);
    const s = (await (await j("GET", "/api/codevideo/settings")).json()) as { reviewRounds: number; brand: { hotline: string; colors: { accent: string; primary: string } } };
    expect(s.reviewRounds).toBe(2);
    expect(s.brand.hotline).toBe("0900 111 222");
    expect(s.brand.colors.accent).toBe("#ff0000");
    expect((await j("PUT", "/api/codevideo/settings", { reviewRounds: 9 })).status).toBe(400);
    expect((await j("PUT", "/api/codevideo/settings", { brand: { logo: "http://evil/x.png" } })).status).toBe(400);
  });
});
