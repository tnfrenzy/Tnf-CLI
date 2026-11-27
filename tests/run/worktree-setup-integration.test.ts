import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../src/core/git/git.js";
import { applySetupCommand, applySetupCopy, finishWorktreeSetup } from "../../src/core/git/worktree-setup-apply.js";
import { buildContextBlock } from "../../src/core/run/context-scan.js";
import { RunStore } from "../../src/core/run/run-store.js";

let base: string;
let repo: string;
let wt: string;
let runDir: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "wsint-"));
  repo = path.join(base, "repo");
  wt = path.join(base, "wt");
  runDir = path.join(base, "run");
  fs.mkdirSync(repo);
  fs.mkdirSync(wt);
  runGit(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello readme");
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(repo, ".env"), "SECRET_TOKEN=abc");
  fs.writeFileSync(path.join(wt, "README.md"), "hello readme");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("worktree setup chain", () => {
  it("store -> copy -> context exclude -> command -> finish", async () => {
    const store = new RunStore(":memory:");
    store.upsertProject({ name: "p1", repo_path: repo, base_branch: "main", allowed_commands: ["Bash(node *)"] });
    store.setProjectWorktreeSetup("p1", { files: [".env"], command: "node --version", timeoutSec: 30 });
    const cfg = store.getProjectWorktreeSetup("p1");
    const project = store.getProject("p1");

    const copy = await applySetupCopy({ repoPath: repo, worktreePath: wt, files: cfg.files });
    expect(copy?.error).toBeUndefined();
    expect(copy?.copied).toEqual([".env"]);
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("SECRET_TOKEN=abc");

    const ctxCfg = { enabled: true, maxBytes: 4096, files: [".env", "README.md"] };
    const block = buildContextBlock({ worktree: wt, cfg: ctxCfg, ...(copy?.copied.length ? { exclude: copy.copied } : {}) });
    expect(block.loaded.map((l) => l.name)).toEqual(["README.md"]);
    expect(block.text).not.toContain("SECRET_TOKEN");

    const cmd = await applySetupCommand({ worktreePath: wt, command: cfg.command, timeoutSec: cfg.timeoutSec, allowedCommands: project?.allowed_commands ?? [] });
    expect(cmd?.ran).toBe(true);
    expect(cmd?.ok).toBe(true);

    const notice = finishWorktreeSetup(runDir, copy, cmd);
    expect(notice?.key).toBe("worktree.setup");
    const txt = fs.readFileSync(path.join(runDir, "worktree-setup.txt"), "utf8");
    expect(txt).toContain(".env");
    expect(txt).not.toContain("SECRET_TOKEN");
  });

  it("a failing command yields the error key", async () => {
    const cmd = await applySetupCommand({ worktreePath: wt, command: "node --no-such-flag-xyz", timeoutSec: 30, allowedCommands: ["Bash(node *)"] });
    expect(cmd?.ok).toBe(false);
    expect(finishWorktreeSetup(runDir, null, cmd)?.key).toBe("worktree.setup.error");
  });

  it("empty config does nothing", async () => {
    expect(await applySetupCopy({ repoPath: repo, worktreePath: wt, files: [] })).toBeNull();
    expect(await applySetupCommand({ worktreePath: wt, command: null, timeoutSec: 30, allowedCommands: [] })).toBeNull();
    expect(finishWorktreeSetup(runDir, null, null)).toBeNull();
    expect(fs.existsSync(runDir)).toBe(false);
  });
});
