import { describe, expect, it } from "vitest";
import { normalizeSetupFiles, normalizeSetupTimeout, validateSetupCommand } from "../../src/core/git/worktree-setup.js";

describe("normalizeSetupFiles", () => {
  it("dedupes, trims and converts backslashes", () => {
    expect(normalizeSetupFiles([" a\\b ", "a/b", "", ".env"])).toEqual(["a/b", ".env"]);
  });
  it("rejects bad paths", () => {
    for (const bad of ["/etc/x", "C:\\x", "\\\\srv\\share", "../x", "a/../b", ".git/config", "a/.GIT/x"]) {
      expect(() => normalizeSetupFiles([bad]), bad).toThrow();
    }
  });
  it("rejects more than 20 patterns and non-arrays", () => {
    expect(() => normalizeSetupFiles(Array.from({ length: 21 }, (_, i) => `f${i}`))).toThrow();
    expect(normalizeSetupFiles(Array.from({ length: 20 }, (_, i) => `f${i}`))).toHaveLength(20);
    expect(() => normalizeSetupFiles("a")).toThrow();
    expect(() => normalizeSetupFiles([1])).toThrow();
  });
});

describe("normalizeSetupTimeout", () => {
  it("defaults and bounds", () => {
    expect(normalizeSetupTimeout(undefined)).toBe(180);
    expect(normalizeSetupTimeout(null)).toBe(180);
    expect(normalizeSetupTimeout(10)).toBe(10);
    expect(normalizeSetupTimeout(900)).toBe(900);
    for (const bad of [5, 901, 1.5, "30"]) expect(() => normalizeSetupTimeout(bad), String(bad)).toThrow();
  });
});

describe("validateSetupCommand", () => {
  const allowed = ["Bash(npm install*)"];
  it("accepts null/blank", () => {
    expect(validateSetupCommand(null, [])).toBeNull();
    expect(validateSetupCommand("   ", [])).toBeNull();
  });
  it("matches the fixed prefix", () => {
    expect(validateSetupCommand("npm install", allowed)).toBeNull();
    expect(validateSetupCommand("npm install --ci", allowed)).toBeNull();
    expect(validateSetupCommand("rm -rf x", allowed)).toEqual(expect.any(String));
  });
  it("ignores invalid allowed entries but keeps valid ones", () => {
    expect(validateSetupCommand("npm install", ["Bash(*)", "garbage", "Bash(npm install*)"])).toBeNull();
    expect(validateSetupCommand("rm x", ["Bash(*)", "Bash(rm*)"])).toBeNull();
    expect(validateSetupCommand("rm x", ["Bash(*)"])).toEqual(expect.any(String));
  });
  it("without a star needs exact or word-boundary match", () => {
    expect(validateSetupCommand("npm ci", ["Bash(npm ci)"])).toBeNull();
    expect(validateSetupCommand("npm cifoo", ["Bash(npm ci)"])).toEqual(expect.any(String));
  });
  it("rejects shell metacharacters and empty allowed list", () => {
    expect(validateSetupCommand("npm install & calc", allowed)).toEqual(expect.any(String));
    expect(validateSetupCommand("npm install", [])).toContain("allowed_commands");
  });
});
