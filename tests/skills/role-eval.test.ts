import { describe, expect, it } from "vitest";
import {
  aggregateRoleEval,
  gradeRoleEvalOutput,
  validateRoleEvalCases,
  type RoleEvalAttempt,
  type RoleEvalCase,
} from "../../src/core/roles/role-eval.js";

// Units: attempt/case score = ratio 0..1; aggregate run score = 0..100 (1 decimal).

const mk = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  title: "Ca một",
  prompt: "Làm gì đó",
  checks: [{ type: "contains", value: "ok" }],
  ...over,
});

function bad(input: unknown) {
  const r = validateRoleEvalCases(input);
  expect(r.ok).toBe(false);
  expect(r.cases).toEqual([]);
  expect(r.errors.length).toBeGreaterThan(0);
  return r.errors;
}

describe("validateRoleEvalCases", () => {
  it("accepts 1 case and 5 cases", () => {
    const r = validateRoleEvalCases([mk()]);
    expect(r.ok).toBe(true);
    expect(r.cases).toHaveLength(1);
    expect(r.errors).toEqual([]);
    const five = [1, 2, 3, 4, 5].map((n) => mk({ id: `c${n}` }));
    expect(validateRoleEvalCases(five).ok).toBe(true);
  });
  it("rejects 0 and 6 cases and non-array", () => {
    bad([]);
    bad([1, 2, 3, 4, 5, 6].map((n) => mk({ id: `c${n}` })));
    bad({});
    bad(null);
  });
  it("rejects duplicate and malformed ids", () => {
    bad([mk(), mk()]);
    bad([mk({ id: "Bad_ID" })]);
    bad([mk({ id: "a".repeat(41) })]);
    bad([mk({ id: "" })]);
  });
  it("rejects long title and bad prompt", () => {
    bad([mk({ title: "x".repeat(81) })]);
    expect(validateRoleEvalCases([mk({ title: "x".repeat(80) })]).ok).toBe(true);
    bad([mk({ prompt: "" })]);
    bad([mk({ prompt: "x".repeat(2001) })]);
  });
  it("rejects 0 and 9 checks", () => {
    bad([mk({ checks: [] })]);
    bad([mk({ checks: Array.from({ length: 9 }, () => ({ type: "contains", value: "a" })) })]);
    expect(validateRoleEvalCases([mk({ checks: Array.from({ length: 8 }, () => ({ type: "contains", value: "a" })) })]).ok).toBe(true);
  });
  it("rejects unknown type, bad contains value", () => {
    bad([mk({ checks: [{ type: "json-schema", schema: {} }] })]);
    bad([mk({ checks: [{ type: "contains", value: "" }] })]);
    bad([mk({ checks: ["x"] })]);
  });
  it("regex rules", () => {
    bad([mk({ checks: [{ type: "regex", pattern: "(" }] })]);
    bad([mk({ checks: [{ type: "regex", pattern: "a".repeat(201) }] })]);
    expect(validateRoleEvalCases([mk({ checks: [{ type: "regex", pattern: "a".repeat(200) }] })]).ok).toBe(true);
    bad([mk({ checks: [{ type: "regex", pattern: "a", flags: "g" }] })]);
    bad([mk({ checks: [{ type: "regex", pattern: "a", flags: "ii" }] })]);
    expect(validateRoleEvalCases([mk({ checks: [{ type: "regex", pattern: "a", flags: "imsu" }] })]).ok).toBe(true);
  });
  it("max/min must be integers >= 0", () => {
    bad([mk({ checks: [{ type: "max-length", max: -1 }] })]);
    bad([mk({ checks: [{ type: "max-length", max: 1.5 }] })]);
    bad([mk({ checks: [{ type: "min-length", min: -1 }] })]);
    bad([mk({ checks: [{ type: "min-length", min: 1.5 }] })]);
    expect(validateRoleEvalCases([mk({ checks: [{ type: "max-length", max: 0 }, { type: "min-length", min: 0 }] })]).ok).toBe(true);
  });
  it("no-tool needs a non-empty string array", () => {
    bad([mk({ checks: [{ type: "no-tool", tools: [] }] })]);
    bad([mk({ checks: [{ type: "no-tool", tools: "Bash" }] })]);
    bad([mk({ checks: [{ type: "no-tool", tools: [""] }] })]);
    expect(validateRoleEvalCases([mk({ checks: [{ type: "no-tool", tools: ["Bash"] }] })]).ok).toBe(true);
  });
  it("passRatio must be within 0..1", () => {
    bad([mk({ passRatio: 1.5 })]);
    bad([mk({ passRatio: -0.1 })]);
    const r = validateRoleEvalCases([mk({ passRatio: 1 })]);
    expect(r.ok).toBe(true);
    expect(r.cases[0]?.passRatio).toBe(1);
  });
  it("errors are Vietnamese, non-empty and locate the case", () => {
    const errs = bad([mk({ checks: [{ type: "contains", value: "" }] })]);
    expect(errs[0]).toMatch(/ca #1/);
    expect(errs[0]).toMatch(/check #1/);
    expect(errs[0]).toMatch(/không rỗng/);
  });
});

const kase = (checks: RoleEvalCase["checks"], passRatio?: number): RoleEvalCase => ({
  id: "c1",
  title: "t",
  prompt: "p",
  checks,
  ...(passRatio === undefined ? {} : { passRatio }),
});

describe("gradeRoleEvalOutput", () => {
  it("grades all 6 check types as pass", () => {
    const c = kase([
      { type: "contains", value: "abc" },
      { type: "not-contains", value: "zzz" },
      { type: "regex", pattern: "^a.c", flags: "i" },
      { type: "max-length", max: 10 },
      { type: "min-length", min: 3 },
      { type: "no-tool", tools: ["Bash"] },
    ]);
    const r = gradeRoleEvalOutput(c, { text: "abcdef", toolNames: ["Read"] });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.checks.map((x) => x.type)).toEqual(["contains", "not-contains", "regex", "max-length", "min-length", "no-tool"]);
    expect(r.checks.map((x) => x.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.checks.every((x) => x.ok)).toBe(true);
  });
  it("grades all 6 check types as fail", () => {
    const c = kase([
      { type: "contains", value: "qqq" },
      { type: "not-contains", value: "abc" },
      { type: "regex", pattern: "^z" },
      { type: "max-length", max: 2 },
      { type: "min-length", min: 100 },
      { type: "no-tool", tools: ["Bash"] },
    ]);
    const r = gradeRoleEvalOutput(c, { text: "abcdef", toolNames: ["Bash"] });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.checks.every((x) => !x.ok)).toBe(true);
  });
  it("no-tool is case sensitive and uses toolNames", () => {
    const c = kase([{ type: "no-tool", tools: ["Bash"] }]);
    expect(gradeRoleEvalOutput(c, { text: "", toolNames: ["Bash"] }).passed).toBe(false);
    expect(gradeRoleEvalOutput(c, { text: "", toolNames: ["Read", "Edit"] }).passed).toBe(true);
    expect(gradeRoleEvalOutput(c, { text: "", toolNames: ["bash"] }).passed).toBe(true);
  });
  it("score is the ratio of passed checks (2/3), passed false", () => {
    const c = kase([
      { type: "contains", value: "a" },
      { type: "contains", value: "b" },
      { type: "contains", value: "z" },
    ]);
    const r = gradeRoleEvalOutput(c, { text: "ab", toolNames: [] });
    expect(r.score).toBeCloseTo(2 / 3, 10);
    expect(r.passed).toBe(false);
  });
  it("truncates text over 200 KB", () => {
    const limit = 200 * 1024;
    const text = "a".repeat(limit) + "TAIL";
    const c = kase([
      { type: "contains", value: "TAIL" },
      { type: "min-length", min: limit + 1 },
      { type: "max-length", max: limit },
    ]);
    const r = gradeRoleEvalOutput(c, { text, toolNames: [] });
    expect(r.checks.map((x) => x.ok)).toEqual([false, false, true]);
  });
});

const att = (passed: boolean, score: number, ok = passed): RoleEvalAttempt => ({
  score,
  passed,
  checks: [{ index: 0, type: "contains", ok }],
});

describe("aggregateRoleEval", () => {
  it("default passRatio 0.5: 1/2 passes, 0/2 fails", () => {
    const c = kase([{ type: "contains", value: "a" }]);
    const r1 = aggregateRoleEval([c], { c1: [att(true, 1), att(false, 0)] });
    expect(r1.cases[0]).toMatchObject({ caseId: "c1", attempts: 2, passes: 1, score: 0.5, passed: true });
    expect(r1.passed).toBe(true);
    const r0 = aggregateRoleEval([c], { c1: [att(false, 0), att(false, 0)] });
    expect(r0.cases[0]?.passed).toBe(false);
    expect(r0.passed).toBe(false);
  });
  it("passRatio 1 with 1/2 fails", () => {
    const c = kase([{ type: "contains", value: "a" }], 1);
    const r = aggregateRoleEval([c], { c1: [att(true, 1), att(false, 0)] });
    expect(r.cases[0]?.passed).toBe(false);
  });
  it("overall score is 0..100 rounded to 1 decimal (2/3 => 66.7)", () => {
    const c = kase([{ type: "contains", value: "a" }]);
    const r = aggregateRoleEval([c], { c1: [att(false, 2 / 3)] });
    expect(r.score).toBe(66.7);
  });
  it("empty or missing attempts => zero result", () => {
    const c = kase([{ type: "contains", value: "a" }]);
    const expected = { caseId: "c1", attempts: 0, passes: 0, score: 0, passed: false, checks: [] };
    const a = aggregateRoleEval([c], { c1: [] });
    expect(a.cases[0]).toEqual(expected);
    expect(a.score).toBe(0);
    expect(a.passed).toBe(false);
    expect(aggregateRoleEval([c], {}).cases[0]).toEqual(expected);
  });
  it("no cases => score 0, passed false", () => {
    expect(aggregateRoleEval([], {})).toEqual({ cases: [], score: 0, passed: false });
  });
  it("checks come from the last attempt", () => {
    const c = kase([{ type: "contains", value: "a" }]);
    const r = aggregateRoleEval([c], { c1: [att(true, 1, true), att(false, 0, false)] });
    expect(r.cases[0]?.checks).toEqual([{ index: 0, type: "contains", ok: false }]);
  });
  it("overall passed requires every case to pass", () => {
    const c1 = { ...kase([{ type: "contains", value: "a" }]), id: "c1" };
    const c2 = { ...kase([{ type: "contains", value: "a" }]), id: "c2" };
    const both = aggregateRoleEval([c1, c2], { c1: [att(true, 1)], c2: [att(true, 1)] });
    expect(both.passed).toBe(true);
    expect(both.score).toBe(100);
    const one = aggregateRoleEval([c1, c2], { c1: [att(true, 1)], c2: [att(false, 0)] });
    expect(one.passed).toBe(false);
    expect(one.score).toBe(50);
  });
});
