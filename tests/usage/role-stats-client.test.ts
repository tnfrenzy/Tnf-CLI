import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setToken } from "../../ui/src/api";
import type { RoleStatsResponse, UiRoleReviewHint, UiRoleStatRow } from "../../ui/src/types";

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const rowNull: UiRoleStatRow = {
  role: "coder",
  group: "coding",
  calls: 0,
  runs: 0,
  tokens: 0,
  durationMs: 0,
  permissionDenials: 0,
  runsWithVerdict: 0,
  passRuns: 0,
  passRate: null,
  lastUsedAt: null,
};
const rowNum: UiRoleStatRow = {
  role: "reviewer",
  group: "other",
  calls: 5,
  runs: 3,
  tokens: 1200,
  durationMs: 45000,
  permissionDenials: 2,
  runsWithVerdict: 2,
  passRuns: 1,
  passRate: 0.5,
  lastUsedAt: 1790000000000,
};
const hint: UiRoleReviewHint = { role: "coder", group: "coding", reason: "unused" };
const sample: RoleStatsResponse = {
  from: 1789000000000,
  to: 1790000000000,
  days: 7,
  runsScanned: 10,
  runsWithoutAgents: 4,
  coordinatorDenials: 1,
  truncated: false,
  rows: [rowNull, rowNum],
  hints: [hint],
};

function call(fn: ReturnType<typeof mockFetch>) {
  return fn.mock.calls[0] as unknown as [string, RequestInit];
}

describe("api.roleStats", () => {
  it("requests /api/library/role-stats?days=7 when days is given", async () => {
    setToken("tok123");
    const fn = mockFetch(sample);
    await api.roleStats(7);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(call(fn)[0].endsWith("/api/library/role-stats?days=7")).toBe(true);
  });

  it("requests plain /api/library/role-stats without query when days is omitted", async () => {
    setToken("tok123");
    const fn = mockFetch(sample);
    await api.roleStats();
    const url = call(fn)[0];
    expect(url.endsWith("/api/library/role-stats")).toBe(true);
    expect(url).not.toContain("?");
    expect(url).not.toContain("days");
  });

  it("sends the x-controller-token header with GET (or no method) in both calls", async () => {
    setToken("tok123");
    for (const days of [7, undefined]) {
      const fn = mockFetch(sample);
      await api.roleStats(days);
      const init = call(fn)[1];
      expect([undefined, "GET"]).toContain(init.method);
      expect((init.headers as Record<string, string>)["x-controller-token"]).toBe("tok123");
      vi.unstubAllGlobals();
    }
  });

  it("returns the full response shape untouched", async () => {
    setToken("tok123");
    mockFetch(sample);
    const res = await api.roleStats(7);
    expect(res).toEqual(sample);
    expect(typeof res.coordinatorDenials).toBe("number");
    expect(res.hints).toEqual([hint]);
    for (const row of res.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["role", "group", "calls", "runs", "tokens", "durationMs", "permissionDenials", "runsWithVerdict", "passRuns", "passRate", "lastUsedAt"].sort(),
      );
      expect(row.passRate === null || typeof row.passRate === "number").toBe(true);
      expect(row.lastUsedAt === null || typeof row.lastUsedAt === "number").toBe(true);
    }
    expect(res.rows[0].passRate).toBeNull();
    expect(res.rows[0].lastUsedAt).toBeNull();
    expect(res.rows[1].passRate).toBe(0.5);
  });
});
