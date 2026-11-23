import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/app/config.js";
import { CliAccountStore } from "../../src/core/run/cli-accounts.js";
import { autoDistributeRoleModels, resolveModelForProvider } from "../../src/core/run/providers/model-distribution.js";
import { startServer } from "../../src/server/index.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FAKE_CLAUDE = path.join(REPO_ROOT, "fixtures", "fake-claude.mjs");

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("CliAccountStore (Claude Code multi-account isolation & failover)", () => {
  it("isolates multiple Claude accounts via CLAUDE_CONFIG_DIR and persists cooldown failover", () => {
    const tmp = makeTmp("tnf-acc-");
    const store = new CliAccountStore(tmp);
    const list0 = store.list();
    expect(list0).toHaveLength(1);
    expect(list0[0]?.id).toBe("claude-default");

    const acc2 = store.add({ id: "claude-work", label: "Claude Work", provider: "claude", isolated: true });
    expect(acc2.configDir).toBeTruthy();
    expect(fs.existsSync(acc2.configDir!)).toBe(true);

    const env2 = store.envForAccount(acc2, { PATH: "/bin" });
    expect(env2["CLAUDE_CONFIG_DIR"]).toBe(acc2.configDir);

    // Persistent cooldown survives reopening the store
    const until = Date.now() + 30 * 60_000;
    store.markCooldown("claude-default", until);
    const reloaded = new CliAccountStore(tmp);
    expect(reloaded.getCooldownUntil("claude-default")).toBeGreaterThan(Date.now());

    // Failover switches from cooling claude-default to claude-work
    reloaded.updateSettings({ autoFailover: true });
    const picked = reloaded.resolveAccount({
      requestedId: "claude-default",
      isCoolingDown: (id) => reloaded.getCooldownUntil(id) !== null,
    });
    expect(picked.id).toBe("claude-work");

    expect(reloaded.clearCooldown("claude-default")).toBe(true);
    expect(reloaded.getCooldownUntil("claude-default")).toBeNull();
  });

  it("auto-distributes Claude models by role tier cleanly", () => {
    const claudeModels = [
      { id: "haiku", label: "Haiku" },
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
    ];
    expect(resolveModelForProvider({ provider: "claude", role: "analyst", available: claudeModels })).toBe("haiku");
    expect(resolveModelForProvider({ provider: "claude", role: "implementer", available: claudeModels })).toBe("sonnet");
    expect(resolveModelForProvider({ provider: "claude", role: "cad-modeler", available: claudeModels })).toBe("opus");

    const roleMap = autoDistributeRoleModels("claude", ["analyst", "implementer", "cad-modeler"], claudeModels);
    expect(roleMap).toEqual({ analyst: "haiku", implementer: "sonnet", "cad-modeler": "opus" });
  });
});

describe("CLI accounts HTTP API & Tuning integration", () => {
  it("manages Claude accounts, cooldowns, role assignments, and runs via fake-claude", async () => {
    const tmp = makeTmp("tnf-acc-api-");
    const cfg = loadConfig();
    cfg.dataDir = path.join(tmp, "data");
    cfg.workspaceDir = path.join(tmp, "ws");
    cfg.worktreesDir = path.join(tmp, "wt");

    const started = await startServer({
      config: cfg,
      port: 0,
      claudePath: process.execPath,
      claudeArgsPrefix: [FAKE_CLAUDE],
      env: { ...process.env, FAKE_CLAUDE_FIXTURE: "hello" },
      automationIntervalMs: 0,
    });

    try {
      const headers = { "X-Controller-Token": started.policy.token, "Content-Type": "application/json" };
      const base = `http://127.0.0.1:${started.policy.port}`;

      const addRes = await fetch(`${base}/api/cli/accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "claude-backup", label: "Claude Backup", provider: "claude", isolated: true }),
      });
      expect(addRes.status).toBe(201);

      const raRes = await fetch(`${base}/api/cli/role-accounts`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ role_accounts: { "video-director": { accountId: "claude-backup", model: "sonnet" } } }),
      });
      expect(raRes.status).toBe(200);
      expect(started.manager.resolveRoleAssignment("video-director")).toEqual({ accountId: "claude-backup", model: "sonnet" });

      started.manager.markAccountCooldown("claude-default", Date.now() + 10 * 60_000);
      const listRes = await fetch(`${base}/api/cli/accounts`, { headers });
      const listJson = (await listRes.json()) as { cooldowns?: Record<string, number> };
      expect(listJson.cooldowns?.["claude-default"]).toBeGreaterThan(Date.now());

      const clearRes = await fetch(`${base}/api/cli/accounts/claude-default/cooldown`, { method: "DELETE", headers });
      expect(clearRes.status).toBe(200);
      expect(started.manager.isAccountCoolingDown("claude-default")).toBe(false);

      const runRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "Xin chào Claude", account_id: "claude-backup", roles: false }),
      });
      expect(runRes.status).toBe(201);
      const { run } = (await runRes.json()) as { run: { id: string; provider: string; account_id: string } };
      expect(run.provider).toBe("claude");
      expect(run.account_id).toBe("claude-backup");
      const done = await started.manager.waitFor(run.id);
      expect(done?.status).toBe("done");
    } finally {
      await started.close();
    }
  });
});
