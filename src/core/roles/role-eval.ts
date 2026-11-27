// Pure role-eval helpers: validate eval cases, grade one output, aggregate attempts.
// No I/O. Score units: attempt/case score is a ratio 0..1; the run-level score is 0..100
// (mean of case scores * 100, rounded to 1 decimal).
import { evalRubricCheck, type RubricCheck } from "../skill-workshop/rubric.js";

export type RoleEvalCheck =
  | { type: "contains"; value: string }
  | { type: "not-contains"; value: string }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "max-length"; max: number }
  | { type: "min-length"; min: number }
  | { type: "no-tool"; tools: string[] };

export interface RoleEvalCase {
  id: string;
  title: string;
  prompt: string;
  checks: RoleEvalCheck[];
  passRatio?: number; // 0..1, default 0.5
}

export interface RoleEvalAttempt {
  score: number; // ratio 0..1 = passed checks / total checks
  passed: boolean; // every check passed
  checks: { index: number; type: string; ok: boolean }[];
}

export interface RoleEvalCaseResult {
  caseId: string;
  attempts: number;
  passes: number;
  score: number; // ratio 0..1 = mean attempt score
  passed: boolean;
  checks: { index: number; type: string; ok: boolean }[]; // from the last attempt
}

export interface RoleEvalRunResult {
  id: string;
  roleId: string;
  version: string;
  at: string;
  repeats: number;
  cases: RoleEvalCaseResult[];
  score: number; // 0..100, 1 decimal
  passed: boolean;
  costUsd: number;
  runIds: string[];
  error?: string;
}

export const ROLE_EVAL_LIMITS = {
  maxCases: 5,
  maxChecks: 8,
  maxTitle: 80,
  maxPrompt: 2000,
  maxPattern: 200,
  maxText: 200 * 1024,
  defaultPassRatio: 0.5,
} as const;

const ID_RE = /^[a-z0-9-]{1,40}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function natInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function validateCheck(c: unknown, where: string, errors: string[]): RoleEvalCheck | null {
  if (!isObj(c)) {
    errors.push(`${where}: check phải là đối tượng.`);
    return null;
  }
  switch (c.type) {
    case "contains":
    case "not-contains":
      if (!nonEmptyStr(c.value)) {
        errors.push(`${where}: check ${c.type} cần value là chuỗi không rỗng.`);
        return null;
      }
      return { type: c.type, value: c.value };
    case "regex": {
      if (!nonEmptyStr(c.pattern)) {
        errors.push(`${where}: check regex cần pattern là chuỗi không rỗng.`);
        return null;
      }
      if (c.pattern.length > ROLE_EVAL_LIMITS.maxPattern) {
        errors.push(`${where}: mẫu regex dài tối đa ${ROLE_EVAL_LIMITS.maxPattern} ký tự.`);
        return null;
      }
      let flags: string | undefined;
      if (c.flags !== undefined) {
        if (typeof c.flags !== "string" || !/^[imsu]*$/.test(c.flags) || new Set(c.flags).size !== c.flags.length) {
          errors.push(`${where}: flags regex chỉ gồm i, m, s, u và không lặp ký tự.`);
          return null;
        }
        flags = c.flags;
      }
      try {
        new RegExp(c.pattern, flags);
      } catch {
        errors.push(`${where}: biểu thức chính quy không biên dịch được.`);
        return null;
      }
      return flags === undefined ? { type: "regex", pattern: c.pattern } : { type: "regex", pattern: c.pattern, flags };
    }
    case "max-length":
      if (!natInt(c.max)) {
        errors.push(`${where}: check max-length cần max là số nguyên >= 0.`);
        return null;
      }
      return { type: "max-length", max: c.max };
    case "min-length":
      if (!natInt(c.min)) {
        errors.push(`${where}: check min-length cần min là số nguyên >= 0.`);
        return null;
      }
      return { type: "min-length", min: c.min };
    case "no-tool":
      if (!Array.isArray(c.tools) || c.tools.length === 0 || !c.tools.every(nonEmptyStr)) {
        errors.push(`${where}: check no-tool cần tools là mảng tên công cụ (chuỗi không rỗng) không rỗng.`);
        return null;
      }
      return { type: "no-tool", tools: [...(c.tools as string[])] };
    default:
      errors.push(`${where}: loại check không được hỗ trợ.`);
      return null;
  }
}

export function validateRoleEvalCases(input: unknown): { ok: boolean; cases: RoleEvalCase[]; errors: string[] } {
  const errors: string[] = [];
  const cases: RoleEvalCase[] = [];
  if (!Array.isArray(input)) {
    return { ok: false, cases: [], errors: ["Danh sách ca eval phải là một mảng."] };
  }
  if (input.length < 1 || input.length > ROLE_EVAL_LIMITS.maxCases) {
    errors.push(`Cần từ 1 đến ${ROLE_EVAL_LIMITS.maxCases} ca eval (hiện ${input.length}).`);
  }
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    const w = `ca #${i + 1}`;
    if (!isObj(raw)) {
      errors.push(`${w}: phải là đối tượng.`);
      return;
    }
    const before = errors.length;
    let id = "";
    if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
      errors.push(`${w}: id phải khớp [a-z0-9-]{1,40}.`);
    } else if (seen.has(raw.id)) {
      errors.push(`${w}: id "${raw.id}" bị trùng.`);
    } else {
      id = raw.id;
      seen.add(id);
    }
    if (typeof raw.title !== "string" || raw.title.length > ROLE_EVAL_LIMITS.maxTitle) {
      errors.push(`${w}: title phải là chuỗi tối đa ${ROLE_EVAL_LIMITS.maxTitle} ký tự.`);
    }
    if (typeof raw.prompt !== "string" || raw.prompt.length < 1 || raw.prompt.length > ROLE_EVAL_LIMITS.maxPrompt) {
      errors.push(`${w}: prompt phải dài 1 đến ${ROLE_EVAL_LIMITS.maxPrompt} ký tự.`);
    }
    if (raw.passRatio !== undefined) {
      if (typeof raw.passRatio !== "number" || !Number.isFinite(raw.passRatio) || raw.passRatio < 0 || raw.passRatio > 1) {
        errors.push(`${w}: passRatio phải là số trong khoảng 0 đến 1.`);
      }
    }
    const checks: RoleEvalCheck[] = [];
    if (!Array.isArray(raw.checks) || raw.checks.length < 1 || raw.checks.length > ROLE_EVAL_LIMITS.maxChecks) {
      errors.push(`${w}: checks phải là mảng 1 đến ${ROLE_EVAL_LIMITS.maxChecks} phần tử.`);
    } else {
      raw.checks.forEach((c, j) => {
        const ck = validateCheck(c, `${w}, check #${j + 1}`, errors);
        if (ck) checks.push(ck);
      });
    }
    if (errors.length === before) {
      const out: RoleEvalCase = { id, title: raw.title as string, prompt: raw.prompt as string, checks };
      if (raw.passRatio !== undefined) out.passRatio = raw.passRatio as number;
      cases.push(out);
    }
  });
  if (errors.length > 0) return { ok: false, cases: [], errors };
  return { ok: true, cases, errors: [] };
}

export function gradeRoleEvalOutput(
  c: RoleEvalCase,
  out: { text: string; toolNames: string[] }
): RoleEvalAttempt {
  const text = out.text.length > ROLE_EVAL_LIMITS.maxText ? out.text.slice(0, ROLE_EVAL_LIMITS.maxText) : out.text;
  const checks = c.checks.map((ck, index) => {
    let ok: boolean;
    if (ck.type === "no-tool") {
      ok = !ck.tools.some((t) => out.toolNames.includes(t));
    } else {
      const rc: RubricCheck = ck;
      ok = evalRubricCheck(rc, text) >= 1;
    }
    return { index, type: ck.type as string, ok };
  });
  const okCount = checks.filter((x) => x.ok).length;
  return {
    score: checks.length === 0 ? 0 : okCount / checks.length,
    passed: checks.length > 0 && okCount === checks.length,
    checks,
  };
}

export function aggregateRoleEval(
  cases: RoleEvalCase[],
  attempts: Record<string, RoleEvalAttempt[]>
): { cases: RoleEvalCaseResult[]; score: number; passed: boolean } {
  const results: RoleEvalCaseResult[] = cases.map((c) => {
    const list = Object.prototype.hasOwnProperty.call(attempts, c.id) ? attempts[c.id] ?? [] : [];
    if (list.length === 0) return { caseId: c.id, attempts: 0, passes: 0, score: 0, passed: false, checks: [] };
    const passes = list.filter((a) => a.passed).length;
    const score = list.reduce((s, a) => s + a.score, 0) / list.length;
    return {
      caseId: c.id,
      attempts: list.length,
      passes,
      score,
      passed: passes / list.length >= (c.passRatio ?? ROLE_EVAL_LIMITS.defaultPassRatio),
      checks: list[list.length - 1]?.checks ?? [],
    };
  });
  const mean = results.length === 0 ? 0 : results.reduce((s, r) => s + r.score, 0) / results.length;
  return {
    cases: results,
    score: Math.round(mean * 100 * 10) / 10,
    passed: results.length > 0 && results.every((r) => r.passed),
  };
}
