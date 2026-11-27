import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSetupSpawn, runSetupCommand } from "../../src/core/git/worktree-setup-command.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wscmd-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const script = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);

describe("worktree-setup-command", () => {
  it("buildSetupSpawn splits without a shell", () => {
    expect(buildSetupSpawn("node --version")).toEqual({ file: "node", args: ["--version"] });
    const n = buildSetupSpawn("npm install");
    if (process.platform === "win32") expect(n.file).toBe("cmd.exe");
    else expect(n.file).toBe("npm");
  });

  it("succeeds with node --version", async () => {
    const r = await runSetupCommand({ cwd: dir, command: "node --version", timeoutMs: 20000 });
    expect(r).toMatchObject({ ran: true, ok: true, exitCode: 0, timedOut: false });
    expect(r.tail).toMatch(/^v\d+/);
  });

  it("reports non-zero exit", async () => {
    script("fail.js", "process.exit(3);");
    const r = await runSetupCommand({ cwd: dir, command: "node fail.js", timeoutMs: 20000 });
    expect(r).toMatchObject({ ran: true, ok: false, exitCode: 3, timedOut: false });
  });

  it("times out and kills a sleeping command", async () => {
    script("sleep.js", "setTimeout(function () {}, 60000);");
    const r = await runSetupCommand({ cwd: dir, command: "node sleep.js", timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  }, 20000);

  it("does not throw for a missing command", async () => {
    const r = await runSetupCommand({ cwd: dir, command: "definitely-not-a-real-cmd-xyz", timeoutMs: 5000 });
    expect(r.ok).toBe(false);
  });

  it("redacts secrets in the tail", async () => {
    script("secret.js", "console.log('token=abcdef123456 sk-abcdefghijklmnop');");
    const r = await runSetupCommand({ cwd: dir, command: "node secret.js", timeoutMs: 20000 });
    expect(r.ok).toBe(true);
    expect(r.tail).not.toContain("abcdef123456");
    expect(r.tail).not.toContain("sk-abcdefghijklmnop");
  });
});
