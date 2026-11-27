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
const H = { "x-controller-token": TOKEN };
const ROLE = "zz-seed-role";
const SECRET_PROMPT = "SECRET-PROMPT-CONTENT-8731";
const SECRET_RUN_DIR = "SECRET-RUN-DIR-4417";
const SECRET_WORKTREE = "SECRET-WORKTREE-9052";

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-rolestats-"));
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

type Stats = Record<string, unknown> & { from: number; to: number; days: number; runsScanned: number; rows: unknown[] };

async function get(query = ""): Promise<Stats> {
  const r = await fetch(`${base}/api/library/role-stats${query}`, { headers: H });
  expect(r.status).toBe(200);
  return (await r.json()) as Stats;
}

describe("GET /api/library/role-stats", () => {
  it("rejects a request without token with 401", async () => {
    const r = await fetch(`${base}/api/library/role-stats`);
    expect(r.status).toBe(401);
  });

  it("returns all keys with a token", async () => {
    const j = await get();
    for (const k of ["from", "to", "days", "runsScanned", "runsWithoutAgents", "coordinatorDenials", "truncated", "rows", "hints"]) {
      expect(j).toHaveProperty(k);
    }
    expect(j.days).toBe(30);
  });

  it("clamps days=500 to 90", async () => {
    const j = await get("?days=500");
    expect(j.days).toBe(90);
    expect(j.to - j.from).toBe(90 * 86400000);
  });

  it("uses 30 when days is not a number", async () => {
    const j = await get("?days=abc");
    expect(j.days).toBe(30);
  });

  it("aggregates a seeded run and leaks no prompt, run_dir or worktree_path", async () => {
    const store = started.manager.store;
    store.createRun({
      id: "rs-run-1",
      status: "done",
      prompt: SECRET_PROMPT,
      mode: "coding",
      model: "sonnet",
      session_id: null,
      parent_run_id: null,
      project: "default",
      claude_version: null,
      run_dir: path.join(root, SECRET_RUN_DIR),
      kind: "coding",
      worktree_path: path.join(root, SECRET_WORKTREE),
      branch: "tnf/rs-run-1",
    });
    store.updateRun("rs-run-1", {
      agents: [
        {
          agent_id: "a1",
          role: ROLE,
          parent_id: null,
          tool_use_id: null,
          status: "finished",
          summary: SECRET_PROMPT,
          reply: SECRET_PROMPT,
          usage: { input: 100, output: 50, cache_read: 0, cache_write: 0 },
        },
      ],
      verdicts: [{ agent_id: "a1", role: ROLE, verdict: "PASS", note: SECRET_PROMPT, at: Date.now() }],
    });
    const j = await get();
    expect(j.runsScanned).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(j);
    expect(text).toContain(ROLE);
    expect(text).not.toContain(SECRET_PROMPT);
    expect(text).not.toContain(SECRET_RUN_DIR);
    expect(text).not.toContain(SECRET_WORKTREE);
    expect(text).not.toContain("worktree_path");
    expect(text).not.toContain("run_dir");
    expect(text).not.toContain("prompt");
  });
});
