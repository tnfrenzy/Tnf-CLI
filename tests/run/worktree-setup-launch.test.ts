import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControllerConfig } from "../../src/core/app/config.js";
import { runGit } from "../../src/core/git/git.js";
import { RunManager } from "../../src/core/run/run-manager.js";
import { RunStore } from "../../src/core/run/run-store.js";

// Real RunManager coding launch with the fake CLI: worktree setup copy (Task 9) and setup command (Task 10).
const FAKE = path.resolve(__dirname, "..", "..", "fixtures", "fake-claude.mjs");
const FIX = path.resolve(__dirname, "..", "..", "fixtures", "real-coding-commit.stream.jsonl");
const PROJECT = "setupproj";

function makeRepo(root: string): string {
  const r = path.join(root, "target-repo");
  fs.mkdirSync(r, { recursive: true });
  const g = (args: string[]) => {
    const res = runGit(r, args);
    if (res.code !== 0) throw new Error(res.stderr);
  };
  g(["init", "-b", "main"]);
  g(["config", "core.autocrlf", "false"]);
  g(["config", "user.name", "Test User"]);
  g(["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(r, "README.md"), "# target\n");
  fs.writeFileSync(path.join(r, ".gitignore"), ".env*\n");
  g(["add", "-A"]);
  g(["commit", "-m", "init"]);
  fs.writeFileSync(path.join(r, ".env"), "A=1\n");
  return r;
}

function tmpConfig(): ControllerConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-wts-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  return {
    repoRoot: root,
    claudePath: null,
    models: [{ id: "sonnet", label: "sonnet" }],
    workspaceDir: path.join(root, "workspace"),
    worktreesDir: path.join(root, "workspace", "worktrees"),
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
        disallowedTools: [],
        extraArgs: ["--setting-sources", "project"],
        maxRoleCalls: 8,
      },
    },
    limits: { maxTurnsCeiling: 100, maxBudgetUsdCeiling: 10 },
  } as unknown as ControllerConfig;
}

describe("worktree setup in run launch (fake CLI)", () => {
  let cfg: ControllerConfig;
  let store: RunStore;
  let mgr: RunManager;
  let repo: string;

  beforeEach(() => {
    cfg = tmpConfig();
    store = new RunStore(":memory:");
    repo = makeRepo(cfg.repoRoot);
    store.upsertProject({ name: PROJECT, repo_path: repo, base_branch: "main", allowed_commands: ["Bash(node --version*)"] });
    mgr = new RunManager({ config: cfg, store, claudePath: process.execPath, claudeArgsPrefix: [FAKE], env: { ...process.env, FAKE_CLAUDE_FIXTURE: FIX } });
  });
  afterEach(() => {
    store.close();
    fs.rmSync(cfg.repoRoot, { recursive: true, force: true });
  });

  it("copies the ignored .env into a fresh worktree and records worktree-setup.txt", async () => {
    store.setProjectWorktreeSetup(PROJECT, { files: [".env"], command: null, timeoutSec: 180 });
    const rec = await mgr.startRun({ prompt: "làm", project: PROJECT });
    await mgr.waitFor(rec.id);
    const run = store.getRun(rec.id)!;
    expect(fs.readFileSync(path.join(run.worktree_path!, ".env"), "utf8")).toBe("A=1\n");
  });

  it("allowed setup command runs before the agent and is recorded", async () => {
    store.setProjectWorktreeSetup(PROJECT, { files: [".env"], command: "node --version", timeoutSec: 60 });
    const rec = await mgr.startRun({ prompt: "làm", project: PROJECT });
    await mgr.waitFor(rec.id);
    const run = store.getRun(rec.id)!;
    expect(run.status).not.toBe("error");
    const txt = fs.readFileSync(path.join(run.run_dir, "worktree-setup.txt"), "utf8");
    expect(txt).toContain("command: ran=true ok=true");
  });

  it("failing setup command is recorded as error but the run still runs", async () => {
    store.upsertProject({ name: PROJECT, repo_path: repo, base_branch: "main", allowed_commands: ["Bash(node --no-such-flag-xyz*)"] });
    store.setProjectWorktreeSetup(PROJECT, { files: [], command: "node --no-such-flag-xyz", timeoutSec: 60 });
    const rec = await mgr.startRun({ prompt: "làm", project: PROJECT });
    await mgr.waitFor(rec.id);
    const run = store.getRun(rec.id)!;
    expect(run.status).not.toBe("error");
    const txt = fs.readFileSync(path.join(run.run_dir, "worktree-setup.txt"), "utf8");
    expect(txt).toContain("ok=false");
  });

  it("empty config copies nothing and writes no setup file", async () => {
    const rec = await mgr.startRun({ prompt: "làm", project: PROJECT });
    await mgr.waitFor(rec.id);
    const run = store.getRun(rec.id)!;
    expect(fs.existsSync(path.join(run.worktree_path!, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(run.run_dir, "worktree-setup.txt"))).toBe(false);
  });

  it("reuseWorktreeOf does not copy again", async () => {
    store.setProjectWorktreeSetup(PROJECT, { files: [".env*"], command: null, timeoutSec: 180 });
    const first = await mgr.startRun({ prompt: "làm", project: PROJECT });
    await mgr.waitFor(first.id);
    fs.writeFileSync(path.join(repo, ".env.late"), "B=2\n");
    const second = await mgr.startRun({ prompt: "tiếp", project: PROJECT, reuseWorktreeOf: first.id });
    await mgr.waitFor(second.id);
    const run = store.getRun(second.id)!;
    expect(fs.existsSync(path.join(run.worktree_path!, ".env.late"))).toBe(false);
    expect(fs.existsSync(path.join(run.run_dir, "worktree-setup.txt"))).toBe(false);
  });
});
