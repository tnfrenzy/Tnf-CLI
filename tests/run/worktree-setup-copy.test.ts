import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../src/core/git/git.js";
import { listIgnoredFiles, provisionSetupFiles } from "../../src/core/git/worktree-setup-copy.js";

let repo: string;
let wt: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wscopy-"));
  repo = path.join(base, "repo");
  wt = path.join(base, "wt");
  fs.mkdirSync(repo);
  fs.mkdirSync(wt);
  runGit(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n.env.*\nconfig/\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "t");
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(repo, ".env"), "A=1");
  fs.mkdirSync(path.join(repo, "config"));
  fs.writeFileSync(path.join(repo, "config", "local.json"), "{}");
});

afterEach(() => {
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});

describe("worktree-setup-copy", () => {
  it("lists only ignored files matching patterns", async () => {
    expect(await listIgnoredFiles(repo, [".env"])).toEqual([".env"]);
    expect(await listIgnoredFiles(repo, ["tracked.txt"])).toEqual([]);
  });

  it("copies ignored .env and nested config, not tracked files", async () => {
    const r = await provisionSetupFiles(repo, wt, [".env", "config/**/*.json", "tracked.txt"]);
    expect(r.error).toBeUndefined();
    expect(r.copied.sort()).toEqual([".env", "config/local.json"]);
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("A=1");
    expect(fs.existsSync(path.join(wt, "tracked.txt"))).toBe(false);
  });

  it("does not overwrite existing destination files", async () => {
    fs.writeFileSync(path.join(wt, ".env"), "KEEP");
    const r = await provisionSetupFiles(repo, wt, [".env"]);
    expect(r.copied).toEqual([]);
    expect(r.skipped.map((s) => s.path)).toContain(".env");
    expect(fs.readFileSync(path.join(wt, ".env"), "utf8")).toBe("KEEP");
  });

  it("empty patterns return immediately even for a missing repo", async () => {
    expect(await provisionSetupFiles(path.join(repo, "nope"), wt, [])).toEqual({ copied: [], skipped: [], ms: 0 });
  });

  it("reports error instead of throwing for a broken repo", async () => {
    const r = await provisionSetupFiles(path.join(repo, "nope"), wt, [".env"]);
    expect(r.error).toBeTruthy();
    expect(r.copied).toEqual([]);
  });

  it("skips symlinks", async () => {
    try {
      fs.symlinkSync(path.join(repo, ".env"), path.join(repo, ".env.link"));
    } catch {
      return; // EPERM on Windows without symlink privilege
    }
    const r = await provisionSetupFiles(repo, wt, [".env.link"]);
    expect(r.copied).toEqual([]);
    expect(fs.existsSync(path.join(wt, ".env.link"))).toBe(false);
  });
});
