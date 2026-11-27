import { describe, it, expect } from "vitest";
import {
  sortRoleStats,
  formatPassRate,
  formatDurationShort,
  formatTokens,
  hintsByRole,
  type UiRoleStatRow,
  type UiRoleReviewHint,
} from "../../ui/src/skills/roleStatsView";

const row = (role: string, n: number, passRate: number | null): UiRoleStatRow => ({
  role,
  group: "g",
  calls: n,
  tokens: n * 10,
  durationMs: n * 100,
  permissionDenials: n,
  passRate,
});

const rows = [row("b", 2, 0.5), row("c", 3, null), row("a", 1, 0.9), row("d", 4, 0.1)];
const names = (r: UiRoleStatRow[]) => r.map((x) => x.role).join("");

describe("sortRoleStats", () => {
  it("sorts by role", () => {
    expect(names(sortRoleStats(rows, "role", "asc"))).toBe("abcd");
    expect(names(sortRoleStats(rows, "role", "desc"))).toBe("dcba");
  });
  for (const key of ["calls", "tokens", "durationMs", "permissionDenials"] as const) {
    it(`sorts by ${key}`, () => {
      expect(names(sortRoleStats(rows, key, "asc"))).toBe("abcd");
      expect(names(sortRoleStats(rows, key, "desc"))).toBe("dcba");
    });
  }
  it("puts null passRate last in asc and desc", () => {
    expect(names(sortRoleStats(rows, "passRate", "asc"))).toBe("dbac");
    expect(names(sortRoleStats(rows, "passRate", "desc"))).toBe("abdc");
  });
  it("does not mutate input", () => {
    const before = names(rows);
    sortRoleStats(rows, "calls", "desc");
    expect(names(rows)).toBe(before);
  });
  it("is stable on ties", () => {
    const t = [row("x", 1, 0.5), row("y", 1, 0.5), row("z", 1, 0.5)];
    expect(names(sortRoleStats(t, "calls", "desc"))).toBe("xyz");
  });
  it("handles empty", () => {
    expect(sortRoleStats([], "role", "asc")).toEqual([]);
  });
});

describe("formatPassRate", () => {
  it("formats", () => {
    expect(formatPassRate(null)).toBe("—");
    expect(formatPassRate(0)).toBe("0%");
    expect(formatPassRate(1)).toBe("100%");
    expect(formatPassRate(0.666)).toBe("67%");
    expect(formatPassRate(0.5)).toBe("50%");
  });
});

describe("formatDurationShort", () => {
  it("formats", () => {
    expect(formatDurationShort(0)).toBe("0s");
    expect(formatDurationShort(45000)).toBe("45s");
    expect(formatDurationShort(200000)).toBe("3m 20s");
    expect(formatDurationShort(3900000)).toBe("1h 5m");
    expect(formatDurationShort(999)).toBe("0s");
    expect(formatDurationShort(3600000)).toBe("1h 0m");
    expect(formatDurationShort(60000)).toBe("1m 0s");
  });
  it("handles invalid", () => {
    expect(formatDurationShort(-5)).toBe("0s");
    expect(formatDurationShort(Number.NaN)).toBe("0s");
    expect(formatDurationShort(Infinity)).toBe("0s");
  });
});

describe("formatTokens", () => {
  it("formats", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(1500000)).toBe("1.5M");
    expect(formatTokens(12345678)).toBe("12.3M");
  });
  it("returns 0 for negative or non-finite", () => {
    expect(formatTokens(-1)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Infinity)).toBe("0");
    expect(formatTokens(-Infinity)).toBe("0");
  });
});

describe("hintsByRole", () => {
  const h = (role: string, reason: UiRoleReviewHint["reason"]): UiRoleReviewHint => ({
    role,
    reason,
  });
  it("empty", () => {
    expect(hintsByRole([])).toEqual({});
  });
  it("groups in order, splits roles, dedupes", () => {
    const out = hintsByRole([
      h("a", "rare"),
      h("b", "unused"),
      h("a", "denied"),
      h("a", "rare"),
    ]);
    expect(out).toEqual({ a: ["rare", "denied"], b: ["unused"] });
  });
});
