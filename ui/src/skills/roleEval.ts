import type { AgentMdPreview, RoleEvalCase, RoleEvalCheck, RoleEvalRunResult } from "../types";

export const MAX_ROLE_EVAL_CASES = 5;

export function emptyRoleEvalCase(index: number): RoleEvalCase {
  return { id: `case-${index}`, title: "", prompt: "", checks: [{ type: "contains", value: "" }] };
}

export function checkSummary(c: RoleEvalCheck): string {
  switch (c.type) {
    case "contains":
      return `contains "${c.value}"`;
    case "not-contains":
      return `not-contains "${c.value}"`;
    case "regex":
      return `regex /${c.pattern}/${c.flags ?? ""}`;
    case "max-length":
      return `max-length ${c.max}`;
    case "min-length":
      return `min-length ${c.min}`;
    case "no-tool":
      return `no-tool: ${c.names.join(", ")}`;
  }
}

/** Copy sorted oldest to newest by (at, array position). */
function sortedOldestFirst(results: RoleEvalRunResult[]): RoleEvalRunResult[] {
  return results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.at - b.r.at || a.i - b.i)
    .map((x) => x.r);
}

export function groupResultsByVersion(
  results: RoleEvalRunResult[],
): { version: string; best: number; last: RoleEvalRunResult }[] {
  const groups = new Map<string, { version: string; best: number; last: RoleEvalRunResult; order: number }>();
  sortedOldestFirst(results).forEach((r, order) => {
    const g = groups.get(r.version);
    if (!g) {
      groups.set(r.version, { version: r.version, best: r.score, last: r, order });
    } else {
      g.best = Math.max(g.best, r.score);
      g.last = r;
      g.order = order;
    }
  });
  return [...groups.values()]
    .sort((a, b) => b.order - a.order)
    .map(({ version, best, last }) => ({ version, best, last }));
}

export function scoreTrend(results: RoleEvalRunResult[]): "up" | "down" | "same" | null {
  const sorted = sortedOldestFirst(results);
  const latest = sorted[sorted.length - 1];
  if (!latest) return null;
  let prev: RoleEvalRunResult | undefined;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const r = sorted[i];
    if (r && r.version !== latest.version) {
      prev = r;
      break;
    }
  }
  if (!prev) return null;
  if (Math.abs(latest.score - prev.score) < 1) return "same";
  return latest.score > prev.score ? "up" : "down";
}

export function canAddCase(cases: RoleEvalCase[]): boolean {
  return cases.length < MAX_ROLE_EVAL_CASES;
}

export function estimatedRuns(caseCount: number, repeats: number): number {
  return caseCount * repeats;
}

export function buildRunRequest(repeats: unknown): { repeats: number } {
  let n: number | null = null;
  if (typeof repeats === "number") n = repeats;
  else if (typeof repeats === "string" && repeats.trim() !== "") n = Number(repeats);
  if (n === null || !Number.isFinite(n)) return { repeats: 1 };
  return { repeats: Math.min(3, Math.max(1, Math.round(n))) };
}

export function nextPollDelay(running: boolean): number | null {
  return running ? 3000 : null;
}

export function showEvalButton(entry: Pick<AgentMdPreview, "kind">): boolean {
  return entry.kind === "role";
}
