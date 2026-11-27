import { describe, expect, it } from "vitest";
import {
  MAX_ROLE_EVAL_CASES,
  buildRunRequest,
  canAddCase,
  checkSummary,
  emptyRoleEvalCase,
  estimatedRuns,
  groupResultsByVersion,
  nextPollDelay,
  scoreTrend,
  showEvalButton,
} from "../../ui/src/skills/roleEval";
import type { AgentMdPreview, RoleEvalCase, RoleEvalRunResult } from "../../ui/src/types";

function res(id: string, version: string, at: number, score: number): RoleEvalRunResult {
  return { id, roleId: "r", version, at, repeats: 1, cases: [], score, passed: score >= 50, costUsd: 0, runIds: [] };
}

describe("emptyRoleEvalCase", () => {
  it("creates case-<index> with one empty contains check", () => {
    const c = emptyRoleEvalCase(3);
    expect(c.id).toBe("case-3");
    expect(c.title).toBe("");
    expect(c.prompt).toBe("");
    expect(c.checks).toEqual([{ type: "contains", value: "" }]);
  });
  it("returns independent objects", () => {
    const a = emptyRoleEvalCase(1);
    const b = emptyRoleEvalCase(1);
    a.checks.push({ type: "contains", value: "x" });
    expect(b.checks).toHaveLength(1);
  });
});

describe("checkSummary", () => {
  it("summarizes every check type", () => {
    expect(checkSummary({ type: "contains", value: "a" })).toBe('contains "a"');
    expect(checkSummary({ type: "not-contains", value: "b" })).toBe('not-contains "b"');
    expect(checkSummary({ type: "regex", pattern: "x+", flags: "i" })).toBe("regex /x+/i");
    expect(checkSummary({ type: "regex", pattern: "x+" })).toBe("regex /x+/");
    expect(checkSummary({ type: "max-length", max: 10 })).toBe("max-length 10");
    expect(checkSummary({ type: "min-length", min: 2 })).toBe("min-length 2");
    expect(checkSummary({ type: "no-tool", names: ["a", "b"] })).toBe("no-tool: a, b");
  });
});

describe("groupResultsByVersion", () => {
  it("returns empty for empty input", () => {
    expect(groupResultsByVersion([])).toEqual([]);
  });
  it("takes best score, latest run, newest group first, regardless of input order", () => {
    const r1 = res("1", "v1", 100, 40);
    const r2 = res("2", "v1", 200, 90);
    const r3 = res("3", "v1", 300, 60);
    const r4 = res("4", "v2", 400, 70);
    const groups = groupResultsByVersion([r4, r1, r3, r2]);
    expect(groups.map((g) => g.version)).toEqual(["v2", "v1"]);
    expect(groups[1]?.best).toBe(90);
    expect(groups[1]?.last.id).toBe("3");
    expect(groups[0]?.best).toBe(70);
    expect(groups[0]?.last.id).toBe("4");
  });
  it("returns the full [{version,best,last}] shape", () => {
    const r1 = res("1", "v1", 100, 40);
    const r2 = res("2", "v1", 200, 90);
    const r3 = res("3", "v2", 300, 70);
    expect(groupResultsByVersion([r1, r2, r3])).toEqual([
      { version: "v2", best: 70, last: r3 },
      { version: "v1", best: 90, last: r2 },
    ]);
  });
  it("orders a version by its newest run when versions interleave", () => {
    const groups = groupResultsByVersion([res("1", "a", 1, 10), res("2", "b", 2, 20), res("3", "a", 3, 30)]);
    expect(groups.map((g) => g.version)).toEqual(["a", "b"]);
  });
  it("tie-break on equal at uses array position for last", () => {
    const first = res("first", "v1", 500, 10);
    const second = res("second", "v1", 500, 20);
    expect(groupResultsByVersion([first, second])[0]?.last.id).toBe("second");
    expect(groupResultsByVersion([second, first])[0]?.last.id).toBe("first");
  });
  it("does not mutate input", () => {
    const input = [res("2", "v1", 2, 1), res("1", "v1", 1, 1)];
    groupResultsByVersion(input);
    expect(input.map((r) => r.id)).toEqual(["2", "1"]);
  });
});

describe("scoreTrend", () => {
  it("null for empty or single-version input", () => {
    expect(scoreTrend([])).toBeNull();
    expect(scoreTrend([res("1", "v1", 1, 50), res("2", "v1", 2, 80)])).toBeNull();
  });
  it("same when diff is below 1", () => {
    expect(scoreTrend([res("1", "v1", 1, 50), res("2", "v2", 2, 50.9)])).toBe("same");
    expect(scoreTrend([res("1", "v1", 1, 50), res("2", "v2", 2, 49.1)])).toBe("same");
    expect(scoreTrend([res("1", "v1", 1, 50), res("2", "v2", 2, 50)])).toBe("same");
  });
  it("diff of exactly 1 is up or down", () => {
    expect(scoreTrend([res("1", "v1", 1, 50), res("2", "v2", 2, 51)])).toBe("up");
    expect(scoreTrend([res("1", "v1", 1, 50), res("2", "v2", 2, 49)])).toBe("down");
  });
  it("compares latest to the latest of the previous different version", () => {
    const results = [res("1", "v1", 1, 10), res("2", "v1", 2, 80), res("3", "v2", 3, 30), res("4", "v2", 4, 85)];
    // latest v2=85 vs previous v1 latest=80 -> diff 5 -> up
    expect(scoreTrend(results)).toBe("up");
    expect(scoreTrend([res("1", "v1", 1, 90), res("2", "v2", 2, 20)])).toBe("down");
  });
  it("handles unordered input", () => {
    const results = [res("3", "v2", 30, 20), res("1", "v1", 10, 90), res("2", "v1", 20, 95)];
    expect(scoreTrend(results)).toBe("down");
  });
  it("three runs A(t1), B(t2), A(t3) compares latest A with B", () => {
    // A latest=80 vs B=50 -> up (not compared with A's own earlier run)
    expect(scoreTrend([res("1", "A", 1, 90), res("2", "B", 2, 50), res("3", "A", 3, 80)])).toBe("up");
    // A latest=20 vs B=50 -> down
    expect(scoreTrend([res("1", "A", 1, 90), res("2", "B", 2, 50), res("3", "A", 3, 20)])).toBe("down");
  });
  it("same at and same version does not throw", () => {
    const run = () => scoreTrend([res("1", "v1", 5, 10), res("2", "v1", 5, 90)]);
    expect(run).not.toThrow();
    expect(run()).toBeNull();
  });
  it("does not mutate input array", () => {
    const input = [res("3", "v2", 30, 20), res("1", "v1", 10, 90), res("2", "v1", 20, 95)];
    const copy = [...input];
    scoreTrend(input);
    expect(input).toEqual(copy);
    expect(input.map((r) => r.id)).toEqual(["3", "1", "2"]);
  });
  it("tie-break on equal at uses array position", () => {
    const a = res("a", "v1", 100, 10);
    const b = res("b", "v2", 100, 90);
    expect(scoreTrend([a, b])).toBe("up");
    expect(scoreTrend([b, a])).toBe("down");
  });
});

describe("case limits and estimates", () => {
  const cases = (n: number): RoleEvalCase[] => Array.from({ length: n }, (_, i) => emptyRoleEvalCase(i));
  it("MAX_ROLE_EVAL_CASES is 5", () => {
    expect(MAX_ROLE_EVAL_CASES).toBe(5);
  });
  it("canAddCase false when full", () => {
    expect(canAddCase(cases(0))).toBe(true);
    expect(canAddCase(cases(4))).toBe(true);
    expect(canAddCase(cases(5))).toBe(false);
    expect(canAddCase(cases(6))).toBe(false);
  });
  it("estimatedRuns multiplies", () => {
    expect(estimatedRuns(4, 3)).toBe(12);
    expect(estimatedRuns(0, 3)).toBe(0);
    expect(estimatedRuns(3, 2)).toBe(6);
  });
});

describe("buildRunRequest", () => {
  it("clamps to 1-3", () => {
    expect(buildRunRequest(0)).toEqual({ repeats: 1 });
    expect(buildRunRequest(-5)).toEqual({ repeats: 1 });
    expect(buildRunRequest(1)).toEqual({ repeats: 1 });
    expect(buildRunRequest(2)).toEqual({ repeats: 2 });
    expect(buildRunRequest(3)).toEqual({ repeats: 3 });
    expect(buildRunRequest(10)).toEqual({ repeats: 3 });
  });
  it("rounds fractional input", () => {
    expect(buildRunRequest(2.4)).toEqual({ repeats: 2 });
    expect(buildRunRequest(2.6)).toEqual({ repeats: 3 });
  });
  it("accepts numeric strings", () => {
    expect(buildRunRequest("2")).toEqual({ repeats: 2 });
  });
  it("defaults to 1 for odd input", () => {
    expect(buildRunRequest("abc")).toEqual({ repeats: 1 });
    expect(buildRunRequest("")).toEqual({ repeats: 1 });
    expect(buildRunRequest(Infinity)).toEqual({ repeats: 1 });
    expect(buildRunRequest(-Infinity)).toEqual({ repeats: 1 });
    expect(buildRunRequest(NaN)).toEqual({ repeats: 1 });
    expect(buildRunRequest(undefined)).toEqual({ repeats: 1 });
    expect(buildRunRequest(null)).toEqual({ repeats: 1 });
  });
});

describe("nextPollDelay", () => {
  it("3000 when running, null otherwise", () => {
    expect(nextPollDelay(true)).toBe(3000);
    expect(nextPollDelay(false)).toBeNull();
  });
});

describe("showEvalButton", () => {
  it("true only for kind role", () => {
    const e = (kind: string) => ({ kind }) as unknown as Pick<AgentMdPreview, "kind">;
    expect(showEvalButton(e("role"))).toBe(true);
    expect(showEvalButton(e("skill"))).toBe(false);
    expect(showEvalButton(e("other"))).toBe(false);
  });
});
