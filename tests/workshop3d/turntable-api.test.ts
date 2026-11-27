import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ControllerConfig } from "../../src/core/app/config.js";
import { createWorkshop3D, makeWorkshop3DEngine } from "../../src/core/workshop3d/index.js";
import { createW3DStore } from "../../src/core/workshop3d/store.js";
import { W3DError } from "../../src/core/workshop3d/state.js";
import type { W3DRunner } from "../../src/core/workshop3d/runner.js";
import type { W3DBrief } from "../../src/core/workshop3d/types.js";
import { startServer, type StartedServer } from "../../src/server/index.js";

const FAKE = path.resolve(__dirname, "..", "..", "fixtures", "fake-claude.mjs");
const REPO = path.resolve(__dirname, "..", "..");
const TOKEN = "e".repeat(48);
const H = { "x-controller-token": TOKEN };
const J = { ...H, "content-type": "application/json" };

let started: StartedServer;
let base: string;
let root: string;
const calls: string[] = [];
const tCalls: Array<{ slug: string; o: Record<string, unknown> }> = [];
const recovered = { n: 0 };
const startedFiles: Record<string, Buffer | string>[] = [];

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-w3d-api-"));
  const dataDir = path.join(root, "data");
  const store = createW3DStore(dataDir);
  const runner: W3DRunner = {
    start(brief: W3DBrief, files = {}) {
      startedFiles.push(files);
      const slug = store.create(brief);
      calls.push(`start:${brief.title}`);
      return slug;
    },
    answer(slug, text) {
      const s = store.get(slug)!.snapshot;
      if (s.state !== "awaiting_user") throw new W3DError("Phiên không chờ câu trả lời.");
      calls.push(`answer:${slug}:${text}`);
    },
    pause: (slug) => void calls.push(`pause:${slug}`),
    resume: (slug) => void calls.push(`resume:${slug}`),
    stop: (slug) => void calls.push(`stop:${slug}`),
    rebuild: (slug, p) => void calls.push(`rebuild:${slug}:${JSON.stringify(p ?? null)}`),
    recover: () => {
      recovered.n++;
      return [];
    },
    idle: async () => undefined,
  };
  const engine = makeWorkshop3DEngine({
    store,
    runner,
    turntable: async (slug, o) => {
      tCalls.push({ slug, o: { ...o, signal: undefined } });
      if (o.width === 64) return { ok: false, error: "Không tìm thấy Blender." };
      if (o.width === 66) {
        await new Promise<void>((r) => o.signal?.addEventListener("abort", () => r(), { once: true }));
        return { ok: false, error: "Đã hủy.", cancelled: true };
      }
      fs.mkdirSync(path.join(store.dir(slug), "outputs"), { recursive: true });
      fs.writeFileSync(path.join(store.dir(slug), "outputs", "turntable.mp4"), "mp4");
      return { ok: true, file: "outputs/turntable.mp4", frames: 1, seconds: 0, secondsPerFrame: null };
    },
  });
  const config: ControllerConfig = {
    repoRoot: REPO,
    claudePath: null,
    models: [{ id: "sonnet", label: "sonnet" }],
    workspaceDir: path.join(root, "ws"),
    worktreesDir: path.join(root, "ws", "worktrees"),
    dataDir,
    server: { host: "127.0.0.1", port: 0, allowedOrigins: [] },
    defaults: {
      authMode: "subscription",
      model: "sonnet",
      maxTurns: 40,
      maxBudgetUsd: 3,
      timeoutMs: 60_000,
      allowedTools: ["Agent"],
      agentsFile: path.join(root, "roles.json"),
      systemPromptFile: path.join(root, "coord.md"),
      maxConcurrentSubagents: 3,
      maxSubagentSpawnDepth: 1,
      extraArgs: [],
      research: { allowedTools: ["Agent"], agentsFile: path.join(root, "roles.json"), systemPromptFile: path.join(root, "coord.md"), disallowedTools: [], extraArgs: [], maxRoleCalls: 8 },
      coding: {
        allowedTools: ["Agent", "Read"],
        agentsFile: path.join(root, "roles-coding.json"),
        systemPromptFile: path.join(root, "coord-coding.md"),
        settingsFile: path.join(root, "deny.json"),
        disallowedTools: ["Bash(git push*)"],
        extraArgs: ["--setting-sources", "project"],
        maxRoleCalls: 8,
      },
    },
    limits: { maxTurnsCeiling: 100, maxBudgetUsdCeiling: 10 },
  };
  started = await startServer({ config, port: 0, token: TOKEN, claudePath: process.execPath, claudeArgsPrefix: [FAKE], env: { ...process.env, FAKE_CLAUDE_FIXTURE: "roles" }, workshop3d: engine });
  base = `http://127.0.0.1:${started.policy.port}`;
});

afterAll(async () => {
  await started.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (p: string, body: unknown, headers: Record<string, string> = J): Promise<Response> =>
  fetch(`${base}${p}`, { method: "POST", headers, body: JSON.stringify(body) });

async function newSession(): Promise<string> {
  const r = await post("/api/workshop3d", { prompt: "hop go nho" });
  return ((await r.json()) as { slug: string }).slug;
}

describe("POST /api/workshop3d/<slug>/turntable", () => {
  it("requires the token and a known session", async () => {
    const slug = await newSession();
    expect((await post(`/api/workshop3d/${slug}/turntable`, {}, { "content-type": "application/json" })).status).toBe(401);
    expect((await post("/api/workshop3d/20260101-000000-aaaaaa/turntable", {})).status).toBe(404);
  });

  it("validates the body", async () => {
    const slug = await newSession();
    expect((await post(`/api/workshop3d/${slug}/turntable`, { width: "big" })).status).toBe(400);
    expect((await post(`/api/workshop3d/${slug}/turntable`, { background: "blue" })).status).toBe(400);
    expect((await post(`/api/workshop3d/${slug}/turntable`, { engine: "x" })).status).toBe(400);
  });

  it("a refusal answers 409 with the Vietnamese message", async () => {
    const slug = await newSession();
    const r = await post(`/api/workshop3d/${slug}/turntable`, { width: 64 });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { message: string }).message).toContain("Blender");
  });

  it("a finished render lists outputs/turntable.mp4 in files and serves it as video/mp4", async () => {
    const slug = await newSession();
    const r = await post(`/api/workshop3d/${slug}/turntable`, { width: 540, background: null, durationSec: 1.5 });
    expect([200, 202]).toContain(r.status);
    expect(tCalls.at(-1)).toMatchObject({ slug, o: { width: 540, background: null, durationSec: 1.5 } });
    const detail = (await (await fetch(`${base}/api/workshop3d/${slug}`, { headers: H })).json()) as { files: string[]; turntable?: unknown; turntableReady?: boolean };
    expect(detail.files).toContain("outputs/turntable.mp4");
    expect(detail).toHaveProperty("turntable");
    expect(detail.turntableReady).toBe(true);
    const f = await fetch(`${base}/api/workshop3d/${slug}/file?path=outputs/turntable.mp4`, { headers: H });
    expect(f.status).toBe(200);
    expect(f.headers.get("content-type")).toBe("video/mp4");
  });

  it("a long render answers 202 and DELETE cancels it; a second start is refused while it runs", async () => {
    const slug = await newSession();
    const r = await post(`/api/workshop3d/${slug}/turntable`, { width: 66 });
    expect(r.status).toBe(202);
    expect((await post(`/api/workshop3d/${slug}/turntable`, { width: 66 })).status).toBe(409);
    const d = await fetch(`${base}/api/workshop3d/${slug}/turntable`, { method: "DELETE", headers: H });
    expect(((await d.json()) as { cancelled: boolean }).cancelled).toBe(true);
    const again = await fetch(`${base}/api/workshop3d/${slug}/turntable`, { method: "DELETE", headers: H });
    expect(((await again.json()) as { cancelled: boolean }).cancelled).toBe(false);
  });
});
