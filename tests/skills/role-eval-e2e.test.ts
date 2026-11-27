// End-to-end role evaluation with the fake Claude CLI: argv is read-only, API key is not passed on, result is stored.
// Positive control for the secret-env flag: tests/skills/fake-claude-secret-env.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ControllerConfig } from "../../src/core/app/config.js";
import { RunManager } from "../../src/core/run/run-manager.js";
import { RunStore } from "../../src/core/run/run-store.js";
import { RoleEvalStore } from "../../src/core/roles/role-eval-store.js";
import { createRoleEvalService } from "../../src/core/roles/role-eval-runner.js";
import type { RoleEvalManager } from "../../src/core/roles/role-eval-runner.js";
import type { RoleEvalRunResult } from "../../src/core/roles/role-eval.js";

const FAKE = path.resolve(__dirname, "..", "..", "fixtures", "fake-claude.mjs");
const FIXTURE = path.resolve(__dirname, "..", "..", "fixtures", "role-eval-ok.stream.jsonl");
const FAKE_KEY = "sk-ant-fake-not-real";
const ROLE_ID = "tester";

function tmpConfig(root: string): ControllerConfig {
  const roles = path.join(root, "roles.json");
  const coord = path.join(root, "coord.md");
  fs.writeFileSync(roles, "{}");
  fs.writeFileSync(coord, "coordinator");
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
      agentsFile: roles,
      systemPromptFile: coord,
      maxConcurrentSubagents: 3,
      maxSubagentSpawnDepth: 1,
      extraArgs: [],
      research: { allowedTools: ["Agent"], agentsFile: roles, systemPromptFile: coord, disallowedTools: [], extraArgs: [], maxRoleCalls: 8 },
      coding: {
        allowedTools: ["Agent", "Read"],
        agentsFile: roles,
        systemPromptFile: coord,
        settingsFile: path.join(root, "deny.json"),
        disallowedTools: [],
        extraArgs: [],
        maxRoleCalls: 8
      }
    },
    limits: { maxTurnsCeiling: 100, maxBudgetUsdCeiling: 10 }
  };
}

let root: string;
let runStore: RunStore;
let store: RoleEvalStore;
let argsFile: string;
let secretFile: string;
let result: RoleEvalRunResult;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-role-e2e-"));
  argsFile = path.join(root, "args.json");
  secretFile = path.join(root, "secret.json");
  runStore = new RunStore(":memory:");
  store = new RoleEvalStore(path.join(root, "role-eval"));
  const config = tmpConfig(root);
  const mgr = new RunManager({
    config,
    store: runStore,
    claudePath: process.execPath,
    claudeArgsPrefix: [FAKE],
    env: {
      ...process.env,
      TNF_FAKE_CLAUDE: "1",
      FAKE_CLAUDE_FIXTURE: FIXTURE,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
      FAKE_CLAUDE_SECRET_ENV_FILE: secretFile,
      ANTHROPIC_API_KEY: FAKE_KEY
    }
  });
  store.setCases(ROLE_ID, [
    { id: "contains", title: "contains keyword", prompt: "Say the keyword.", checks: [{ type: "contains", value: "ROLE_EVAL_OK" }] },
    { id: "no-tool", title: "must not Read", prompt: "Answer without tools.", checks: [{ type: "no-tool", tools: ["Read"] }] }
  ]);
  const service = createRoleEvalService({
    manager: mgr as unknown as RoleEvalManager,
    getRole: () => ({ prompt: "You are a careful tester." } as never),
    store,
    readStream: (runId) => fs.readFileSync(path.join(config.dataDir, "runs", runId, "stream.jsonl"), "utf8"),
    now: () => Date.now()
  });
  const started = service.start(ROLE_ID, 1);
  expect(started.started).toBe(true);
  await service.done(ROLE_ID);
  result = store.listResults(ROLE_ID)[0]!;
}, 120_000);

afterAll(() => {
  runStore.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("role-eval e2e (fake-claude)", () => {
  it("argv: only Read, Grep, Glob are allowed, no permission bypass", () => {
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args).toContain("-p");
    const i = args.indexOf("--allowedTools");
    expect(i).toBeGreaterThanOrEqual(0);
    const tools: string[] = [];
    for (let k = i + 1; k < args.length && !args[k].startsWith("--"); k++) tools.push(args[k]);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(/^(Read|Grep|Glob)(\(.*\))?$/.test(t)).toBe(true);
    for (const t of tools) expect(/^(Write|Edit|Bash)/.test(t)).toBe(false);
    expect(args).not.toContain("--dangerously-skip-permissions");
    const pm = args.indexOf("--permission-mode");
    if (pm >= 0) expect(args[pm + 1]).not.toBe("bypassPermissions");
  });

  it("the API key is not passed to claude", () => {
    const raw = fs.readFileSync(secretFile, "utf8");
    expect(raw).not.toContain(FAKE_KEY);
    expect((JSON.parse(raw) as { ANTHROPIC_API_KEY_PRESENT: boolean }).ANTHROPIC_API_KEY_PRESENT).toBe(false);
  });

  it("stores a scored result: contains passes, no-tool (Read forbidden) fails", () => {
    const list = store.listResults(ROLE_ID);
    expect(list.length).toBe(1);
    const r = list[0];
    expect(r.id).toBe(result.id);
    expect(typeof r.score).toBe("number");
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.cases.find((c) => c.caseId === "contains")?.passed).toBe(true);
    expect(r.cases.find((c) => c.caseId === "no-tool")?.passed).toBe(false);
    expect(r.runIds.length).toBeGreaterThan(0);
    expect(r.costUsd ?? 0).toBeGreaterThanOrEqual(0);
  });
});
