import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ControllerConfig } from "../../src/core/app/config.js";
import { DANGER_KEYWORDS } from "../../src/core/roles/agent-md.js";
import { startServer, type StartedServer } from "../../src/server/index.js";

let started: StartedServer;
let base: string;
let root: string;
const TOKEN = "t".repeat(48);
const H = { "x-controller-token": TOKEN, "content-type": "application/json" };

interface Ver {
  id: string;
  at: number;
  role?: { id: string; prompt: string; description: string };
  item?: { id: string; content: string };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-libhist-"));
  const config: ControllerConfig = {
    repoRoot: root,
    claudePath: null,
    models: [{ id: "haiku", label: "haiku" }, { id: "sonnet", label: "sonnet" }],
    workspaceDir: path.join(root, "ws"),
    worktreesDir: path.join(root, "ws", "worktrees"),
    dataDir: path.join(root, "data"),
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
        allowedTools: ["Agent", "Read", "Grep", "Glob", "Edit", "Write", "Bash(npm test*)"],
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
  started = await startServer({ config, port: 0, token: TOKEN, claudePath: process.execPath });
  base = `http://127.0.0.1:${started.policy.port}`;
});

afterAll(async () => {
  await started.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function req(method: string, p: string, body?: unknown, headers: Record<string, string> = H): Promise<Response> {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${base}/api/library${p}`, init);
}

async function mkRole(id: string, edits: string[]): Promise<void> {
  const c = await req("POST", "/roles", { id, description: "Vai " + id, prompt: "Bạn là vai gốc.", tools: ["Read"] });
  expect(c.status).toBe(201);
  for (const e of edits) {
    const u = await req("PUT", `/roles/${id}`, { prompt: e });
    expect(u.status).toBe(200);
  }
}

async function hist(kind: "roles" | "items", id: string): Promise<Ver[]> {
  const r = await req("GET", `/${kind}/${id}/history`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { versions: Ver[] }).versions;
}

async function currentRole(id: string): Promise<{ prompt: string; description: string }> {
  const j = (await (await req("GET", "")).json()) as { roles: { id: string; prompt: string; description: string }[] };
  return j.roles.find((r) => r.id === id)!;
}

describe("library history and restore routes", () => {
  it("(a) history lists versions after edits", async () => {
    await mkRole("h-a", ["Nội dung hai.", "Nội dung ba."]);
    expect((await hist("roles", "h-a")).length).toBeGreaterThanOrEqual(2);
  });

  it("(b) dryRun returns version+preview and changes nothing", async () => {
    await mkRole("h-b", ["Nội dung hai.", "Nội dung ba."]);
    const vs = await hist("roles", "h-b");
    const before = await currentRole("h-b");
    const r = await req("POST", "/roles/h-b/restore", { versionId: vs[0]!.id, dryRun: true });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { version: Ver; preview: unknown };
    expect(j.version.id).toBe(vs[0]!.id);
    expect(j.preview).toBeTruthy();
    expect(await currentRole("h-b")).toEqual(before);
    expect((await hist("roles", "h-b")).length).toBe(vs.length);
  });

  it("(c) real restore of a non-oldest version keeps history", async () => {
    await mkRole("h-c", ["Nội dung hai.", "Nội dung ba.", "Nội dung bốn."]);
    const vs = await hist("roles", "h-c");
    expect(vs.length).toBeGreaterThanOrEqual(3);
    const target = vs[1]!; // by array position: neither first nor last
    const r = await req("POST", "/roles/h-c/restore", { versionId: target.id, note: "khôi phục" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { preview: unknown; role: { prompt: string } };
    expect(j.preview).toBeTruthy();
    expect(j.role.prompt).toBe(target.role!.prompt);
    expect((await currentRole("h-c")).prompt).toBe(target.role!.prompt);
    const after = await hist("roles", "h-c");
    expect(after.length).toBe(Math.min(vs.length + 1, 10));
    expect(after.some((v) => v.id === target.id)).toBe(true);
  });

  it("(d) unknown versionId gives 404", async () => {
    await mkRole("h-d", ["Nội dung hai."]);
    const r = await req("POST", "/roles/h-d/restore", { versionId: "khong-co" });
    expect(r.status).toBe(404);
  });

  it("(e) dangerous version needs confirm", async () => {
    const kw = DANGER_KEYWORDS[0]!;
    await mkRole("h-e", [`Chạy ${kw} origin main.`, "Nội dung an toàn."]);
    const vs = await hist("roles", "h-e");
    const danger = vs.find((v) => v.role?.prompt.includes(kw));
    expect(danger).toBeTruthy();
    const dry = (await (await req("POST", "/roles/h-e/restore", { versionId: danger!.id, dryRun: true })).json()) as {
      preview: { dangerKeywords: string[] };
    };
    expect(dry.preview.dangerKeywords.length).toBeGreaterThan(0);
    const no = await req("POST", "/roles/h-e/restore", { versionId: danger!.id });
    expect(no.status).toBe(400);
    expect((await currentRole("h-e")).prompt).toBe("Nội dung an toàn.");
    const yes = await req("POST", "/roles/h-e/restore", { versionId: danger!.id, confirm: true });
    expect(yes.status).toBe(200);
  });

  it("(f) missing or bad fields give 400", async () => {
    await mkRole("h-f", ["Nội dung hai."]);
    const vs = await hist("roles", "h-f");
    for (const body of [{}, { versionId: "" }, { versionId: vs[0]!.id, note: 5 }, { versionId: vs[0]!.id, dryRun: "x" }, { versionId: vs[0]!.id, confirm: 1 }]) {
      const r = await req("POST", "/roles/h-f/restore", body);
      expect(r.status).toBe(400);
    }
  });

  it("(g) items: history and restore return item", async () => {
    const c = await req("POST", "/items", { name: "Mục g", type: "prompt", content: "một" });
    expect(c.status).toBe(201);
    const id = ((await c.json()) as { item: { id: string } }).item.id;
    expect((await req("PUT", `/items/${id}`, { content: "hai" })).status).toBe(200);
    expect((await req("PUT", `/items/${id}`, { content: "ba" })).status).toBe(200);
    const vs = await hist("items", id);
    expect(vs.length).toBeGreaterThanOrEqual(2);
    const r = await req("POST", `/items/${id}/restore`, { versionId: vs[1]!.id });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { preview: unknown; item: { content: string }; role?: unknown };
    expect(j.item.content).toBe(vs[1]!.item!.content);
    expect(j.role).toBeUndefined();
  });

  it("(h) roles/from-catalog/<id> still reaches the old handler", async () => {
    const r = await req("POST", "/roles/from-catalog/khong-co-id-nay");
    expect(r.status).not.toBe(401);
    const j = (await r.json()) as { error?: string; message?: string };
    expect(j.message).not.toBe("Không có đường dẫn này.");
  });

  it("(i) no token is rejected", async () => {
    const h = { "content-type": "application/json" };
    expect((await req("GET", "/roles/h-a/history", undefined, h)).status).toBe(401);
    expect((await req("POST", "/roles/h-a/restore", { versionId: "x" }, h)).status).toBe(401);
  });
});
