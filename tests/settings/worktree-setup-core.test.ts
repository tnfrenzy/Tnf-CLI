import { describe, expect, it } from "vitest";
import {
  WORKTREE_SETUP_LIMITS,
  describeWorktreeSetup,
  globsToPathspecs,
  matchSetupGlob,
  planWorktreeCopy,
  normalizeSetupFiles,
  normalizeSetupTimeout,
  type SetupCommandResult,
  type SetupCopyResult,
  type WorktreeSetupConfig,
} from "../../src/core/git/worktree-setup.js";

describe("worktree-setup limits and types", () => {
  it("has the agreed limit values", () => {
    expect(WORKTREE_SETUP_LIMITS).toEqual({
      maxPatterns: 20,
      maxFiles: 50,
      maxFileBytes: 5242880,
      maxTotalBytes: 20971520,
      defaultTimeoutSec: 180,
      minTimeoutSec: 10,
      maxTimeoutSec: 900,
      logTailBytes: 4000,
    });
  });

  it("normalizers use the limits", () => {
    expect(normalizeSetupTimeout(undefined)).toBe(180);
    expect(normalizeSetupTimeout(10)).toBe(10);
    expect(normalizeSetupTimeout(900)).toBe(900);
    expect(() => normalizeSetupTimeout(9)).toThrow("từ 10 đến 900");
    expect(() => normalizeSetupTimeout(901)).toThrow("từ 10 đến 900");
    const many = Array.from({ length: 21 }, (_, i) => `f${i}`);
    expect(() => normalizeSetupFiles(many)).toThrow("Tối đa 20 mẫu tệp.");
    expect(normalizeSetupFiles(many.slice(0, 20))).toHaveLength(20);
  });

  it("matches globs", () => {
    expect(matchSetupGlob(".env", ".env")).toBe(true);
    expect(matchSetupGlob(".env.*", ".env.local")).toBe(true);
    expect(matchSetupGlob(".env.*", ".env")).toBe(false);
    expect(matchSetupGlob("config/**/*.json", "config/a/b/c.json")).toBe(true);
    expect(matchSetupGlob("config/**/*.json", "config/c.json")).toBe(true);
    expect(matchSetupGlob("*.json", "a/b.json")).toBe(false);
    expect(matchSetupGlob("**", "a/b/c")).toBe(true);
    expect(matchSetupGlob("a?c", "abc")).toBe(true);
    expect(matchSetupGlob("a?c", "a/c")).toBe(false);
    expect(matchSetupGlob("config\\x.json", "config/x.json")).toBe(true);
    expect(matchSetupGlob(".ENV", ".env")).toBe(false);
    expect(matchSetupGlob(".ENV", ".env", { caseInsensitive: true })).toBe(true);
  });

  it("builds pathspecs", () => {
    expect(globsToPathspecs([".env", "a/**"])).toEqual([":(glob).env", ":(glob)a/**"]);
  });

  it("plans copies within limits", () => {
    const c = (path: string, size = 10, symlink?: boolean) => ({ path, size, symlink });
    const r = planWorktreeCopy([".env", "a/*.json"], [c(".env"), c("a/x.json"), c("b.txt"), c(".env", 1, true)]);
    expect(r.copy).toEqual([".env", "a/x.json"]);
    expect(r.skipped.map((s) => s.path)).toEqual(["b.txt", ".env"]);
    expect(r.skipped.every((s) => s.reason.length > 0)).toBe(true);
    expect(planWorktreeCopy([".env"], [c(".env", 100)], { maxFileBytes: 50 }).skipped).toHaveLength(1);
    expect(planWorktreeCopy(["*"], [c("a"), c("b"), c("c")], { maxFiles: 2 })).toMatchObject({ copy: ["a", "b"] });
    expect(planWorktreeCopy(["*"], [c("a", 30), c("b", 30)], { maxTotalBytes: 50 })).toMatchObject({ copy: ["a"] });
  });

  it("describes setup results", () => {
    const okCopy: SetupCopyResult = { copied: [".env"], skipped: [], ms: 1 };
    const okCmd: SetupCommandResult = { ran: true, ok: true, exitCode: 0, timedOut: false, tail: "SECRET", ms: 5 };
    expect(describeWorktreeSetup(null, null)).toBeNull();
    const d = describeWorktreeSetup(okCopy, okCmd)!;
    expect(d.key).toBe("worktree.setup");
    expect(d.text).not.toContain("SECRET");
    expect(describeWorktreeSetup({ ...okCopy, error: "boom" }, null)!.key).toBe("worktree.setup.error");
    expect(describeWorktreeSetup(null, { ...okCmd, ok: false, exitCode: 1 })!.key).toBe("worktree.setup.error");
    expect(describeWorktreeSetup(null, { ...okCmd, ok: false, exitCode: null, timedOut: true })!.key).toBe("worktree.setup.error");
    expect(describeWorktreeSetup(null, { ...okCmd, ran: false, ok: false, reason: "x" })!.key).toBe("worktree.setup.error");
    const notRan: SetupCommandResult = { ran: false, ok: false, exitCode: null, timedOut: false, tail: "", ms: 0, reason: "từ chối" };
    const a = describeWorktreeSetup(null, notRan)!;
    expect(a.key).toBe("worktree.setup.error");
    expect(a.text).toContain("không chạy");
    const b = describeWorktreeSetup(okCopy, notRan)!;
    expect(b.key).toBe("worktree.setup.error");
    expect(b.text).toContain("không chạy");
    expect(describeWorktreeSetup(null, okCmd)!.key).toBe("worktree.setup");
  });

  it("types are usable", () => {
    const cfg: WorktreeSetupConfig = { files: [".env"], command: null, timeoutSec: 180 };
    const copy: SetupCopyResult = { copied: [], skipped: [], ms: 0 };
    const cmd: SetupCommandResult = { ran: false, ok: false, exitCode: null, timedOut: false, tail: "", ms: 0 };
    expect([cfg.files.length, copy.ms, cmd.ran]).toEqual([1, 0, false]);
  });
});
