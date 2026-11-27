import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ControllerConfig } from "../../src/core/app/config.js";
import { startServer, type StartedServer } from "../../src/server/index.js";

let started: StartedServer;
let base: string;
let root: string;
const TOKEN = "t".repeat(48);
const H = { "x-controller-token": TOKEN, "content-type": "application/json" };
const UI = path.resolve(__dirname, "../../ui/src");

interface Ver {
  id: string;
  at: number;
  note: string;
  role?: { id: string; prompt: string; description: string };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-libhist-int-"));
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

function req(method: string, p: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: H };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${base}/api/library${p}`, init);
}

async function hist(id: string): Promise<Ver[]> {
  const r = await req("GET", `/roles/${id}/history`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { versions: Ver[] }).versions;
}

describe("library history integration", () => {
  it("12 edits keep 10 versions; restore keeps history and returns the response keys", async () => {
    const id = "int-role";
    const c = await req("POST", "/roles", { id, description: "Vai tích hợp", prompt: "Bản gốc.", tools: ["Read"] });
    expect(c.status).toBe(201);
    for (let i = 1; i <= 12; i++) {
      const u = await req("PUT", `/roles/${id}`, { prompt: `Bản sửa số ${i}.`, note: `ghi chú ${i}` });
      expect(u.status).toBe(200);
    }
    const before = await hist(id);
    expect(before.length).toBe(10);

    // pick by array position (not the oldest, index 0), never by `at`
    const target = before[1]!;
    const targetPrompt = target.role!.prompt;
    const r = await req("POST", `/roles/${id}/restore`, { versionId: target.id, note: "khôi phục" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toContain("preview");
    expect(Object.keys(body)).toContain("role");
    expect((body.role as { prompt: string }).prompt).toBe(targetPrompt);

    const j = (await (await req("GET", "")).json()) as { roles: { id: string; prompt: string }[] };
    expect(j.roles.find((x) => x.id === id)!.prompt).toBe(targetPrompt);

    const after = await hist(id);
    expect(after.length).toBe(Math.min(before.length + 1, 10));
    expect(after.some((v) => v.role?.prompt === targetPrompt)).toBe(true);
  });

  it("every lib_hist_* key used in the UI exists in vi.ts and en.ts", () => {
    const read = (f: string) => fs.readFileSync(path.join(UI, f), "utf8");
    const used = new Set<string>();
    for (const f of ["components/skills/LibraryHistory.tsx", "pages/LibraryPage.tsx"]) {
      for (const m of read(f).matchAll(/lib_hist_\w+/g)) used.add(m[0]);
    }
    expect(used.size).toBeGreaterThan(0);
    const vi = read("i18n/vi.ts");
    const en = read("i18n/en.ts");
    for (const k of used) {
      expect(vi, `vi.ts missing ${k}`).toMatch(new RegExp(`\\b${k}\\b`));
      expect(en, `en.ts missing ${k}`).toMatch(new RegExp(`\\b${k}\\b`));
    }
  });

  it("LibraryPage diffs against the saved entry (lib.roles/lib.items), not the draft", () => {
    const src = fs.readFileSync(path.join(UI, "pages/LibraryPage.tsx"), "utf8");
    expect(src).toMatch(/lib\.roles\.find\(\(r\) => r\.id === role\.id\)/);
    expect(src).toMatch(/lib\.items\.find\(\(i\) => i\.id === item\.id\)/);
    expect(src).not.toMatch(/current=\{\{ role: \{ id: role\.id, description: role\.description, prompt: role\.prompt/);
    expect(src).not.toMatch(/current=\{\{ item: \{ id: item\.id, name: item\.name/);
  });

  it("api.ts exposes libraryHistory and restoreLibraryVersion", () => {
    const api = fs.readFileSync(path.join(UI, "api.ts"), "utf8");
    expect(api).toMatch(/libraryHistory\s*:/);
    expect(api).toMatch(/restoreLibraryVersion\s*:/);
  });
});
