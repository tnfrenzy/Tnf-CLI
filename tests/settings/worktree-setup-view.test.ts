import { describe, expect, it } from "vitest";
import { clampTimeoutSec, clientCheckPattern, commandSuggestions, patternsToText, textToPatterns } from "../../ui/src/settings/worktreeSetupView.js";

describe("worktree setup view helpers", () => {
  it("round-trips patterns", () => {
    const files = [".env", "config/**/*.json"];
    expect(textToPatterns(patternsToText(files))).toEqual(files);
  });
  it("trims, drops blanks and duplicates", () => {
    expect(textToPatterns("  .env \r\n\n.env\n.env.*\n")).toEqual([".env", ".env.*"]);
  });
  it("suggests allowed commands", () => {
    const allowed = ["npm install", "pnpm i", "npm test"];
    expect(commandSuggestions(allowed, "")).toEqual(allowed);
    expect(commandSuggestions(allowed, "NPM")).toEqual(["npm install", "pnpm i", "npm test"]);
    expect(commandSuggestions(allowed, "test")).toEqual(["npm test"]);
    expect(commandSuggestions(allowed, "zzz")).toEqual([]);
  });
  it("checks patterns", () => {
    expect(clientCheckPattern(".env")).toBeNull();
    expect(clientCheckPattern("config/**/*.json")).toBeNull();
    expect(clientCheckPattern("/etc/passwd")).toMatch(/tương đối/);
    expect(clientCheckPattern("C:\\x\\.env")).not.toBeNull();
    expect(clientCheckPattern("../x")).toMatch(/\.\./);
    expect(clientCheckPattern("a/.git/config")).toMatch(/\.git/);
    expect(clientCheckPattern("a".repeat(201))).toMatch(/dài/);
    expect(clientCheckPattern("  ")).not.toBeNull();
  });
  it("clamps timeout", () => {
    expect(clampTimeoutSec(5)).toBe(10);
    expect(clampTimeoutSec(10)).toBe(10);
    expect(clampTimeoutSec(900)).toBe(900);
    expect(clampTimeoutSec(5000)).toBe(900);
    expect(clampTimeoutSec(Number.NaN)).toBe(180);
    expect(clampTimeoutSec(60)).toBe(60);
  });
});
