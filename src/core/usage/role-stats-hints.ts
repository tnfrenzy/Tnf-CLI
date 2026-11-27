import type { RoleGroup, RoleStatsResult } from "./role-stats.js";

export interface RoleReviewHint {
  role: string;
  group: RoleGroup;
  reason: "unused" | "rare" | "denied" | "low_pass";
}

export interface RoleReviewOptions {
  rareMaxCalls?: number;
  deniedMinRatio?: number;
  lowPassMax?: number;
  minVerdictRuns?: number;
}

export function suggestRoleReview(result: Pick<RoleStatsResult, "rows">, opts: RoleReviewOptions = {}): RoleReviewHint[] {
  const rareMaxCalls = opts.rareMaxCalls ?? 2;
  const deniedMinRatio = opts.deniedMinRatio ?? 0.3;
  const lowPassMax = opts.lowPassMax ?? 0.5;
  const minVerdictRuns = opts.minVerdictRuns ?? 3;
  const hints: RoleReviewHint[] = [];
  for (const row of result.rows) {
    if (row.group === "unknown") continue;
    const add = (reason: RoleReviewHint["reason"]): void => {
      hints.push({ role: row.role, group: row.group, reason });
    };
    if (row.group === "library" && row.calls === 0) add("unused");
    if (row.calls > 0 && row.calls <= rareMaxCalls) add("rare");
    if (row.permissionDenials >= 2 && row.calls > 0 && row.permissionDenials / row.calls >= deniedMinRatio) add("denied");
    if (row.runsWithVerdict >= minVerdictRuns && row.passRate !== null && row.passRate <= lowPassMax) add("low_pass");
  }
  return hints;
}
