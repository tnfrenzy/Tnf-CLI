import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applySetupCommand, applySetupCopy, finishWorktreeSetup } from "../../src/core/git/worktree-setup-apply.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wts-apply-"));
}

describe("worktree-setup-apply", () => {
  it("returns null for empty config and writes nothing", async () => {
    const dir = tmp();
    expect(await applySetupCopy({ repoPath: "/nonexistent", worktreePath: dir, files: [] })).toBeNull();
    expect(await applySetupCommand({ worktreePath: dir, command: null, timeoutSec: 30, allowedCommands: [] })).toBeNull();
    expect(await applySetupCommand({ worktreePath: dir, command: "  ", timeoutSec: 30, allowedCommands: [] })).toBeNull();
    expect(finishWorktreeSetup(dir, null, null)).toBeNull();
    expect(fs.existsSync(path.join(dir, "worktree-setup.txt"))).toBe(false);
  });

  it("rejects a command that is not allowed", async () => {
    const r = await applySetupCommand({ worktreePath: tmp(), command: "node --version", timeoutSec: 30, allowedCommands: [] });
    expect(r?.ran).toBe(false);
    expect(r?.ok).toBe(false);
    expect(r?.reason).toBeTruthy();
  });

  it("runs an allowed command and finish writes the file", async () => {
    const dir = tmp();
    const r = await applySetupCommand({ worktreePath: dir, command: "node --version", timeoutSec: 30, allowedCommands: ["Bash(node *)"] });
    expect(r?.ran).toBe(true);
    expect(r?.ok).toBe(true);
    const n = finishWorktreeSetup(dir, null, r);
    expect(n?.key).toBe("worktree.setup");
    expect(fs.existsSync(path.join(dir, "worktree-setup.txt"))).toBe(true);
  });

  it("finish reports error key for a failed copy and does not throw on unwritable runDir", () => {
    const dir = tmp();
    const file = path.join(dir, "afile");
    fs.writeFileSync(file, "x");
    const n = finishWorktreeSetup(path.join(file, "sub"), { copied: [], skipped: [], ms: 1, error: "boom" }, null);
    expect(n?.key).toBe("worktree.setup.error");
  });
});
