import { describe, it, expect } from 'vitest';
import { suggestRoleReview } from '../../src/core/usage/role-stats-hints.js';
import type { RoleStatRow } from '../../src/core/usage/role-stats.js';

function row(over: Partial<RoleStatRow>): RoleStatRow {
  return {
    role: 'r', group: 'coding', calls: 10, runs: 5, tokens: 0, durationMs: 0,
    runsWithVerdict: 0, passRuns: 0, passRate: null, permissionDenials: 0, lastUsedAt: 1, ...over,
  };
}
const reasons = (rows: RoleStatRow[], opts?: Parameters<typeof suggestRoleReview>[1]) =>
  suggestRoleReview({ rows }, opts).map((h) => h.reason);

describe('suggestRoleReview', () => {
  it('unused: library with zero calls only', () => {
    expect(reasons([row({ group: 'library', calls: 0 })])).toEqual(['unused']);
    expect(reasons([row({ group: 'coding', calls: 0 })])).toEqual([]);
  });
  it('rare: 0<calls<=2', () => {
    expect(reasons([row({ calls: 2 })])).toEqual(['rare']);
    expect(reasons([row({ calls: 3 })])).toEqual([]);
  });
  it('denied: >=2 denials and ratio >=0.3', () => {
    expect(reasons([row({ calls: 10, permissionDenials: 3 })])).toEqual(['denied']);
    expect(reasons([row({ calls: 10, permissionDenials: 2 })])).toEqual([]);
    expect(reasons([row({ calls: 10, permissionDenials: 1 })])).toEqual([]);
  });
  it('low_pass: >=3 verdict runs and passRate<=0.5', () => {
    expect(reasons([row({ runsWithVerdict: 4, passRuns: 2, passRate: 0.5 })])).toEqual(['low_pass']);
    expect(reasons([row({ runsWithVerdict: 4, passRuns: 3, passRate: 0.75 })])).toEqual([]);
    expect(reasons([row({ runsWithVerdict: 2, passRuns: 0, passRate: 0 })])).toEqual([]);
  });
  it('skips unknown rows', () => {
    expect(reasons([row({ group: 'unknown', role: 'unknown', calls: 1, permissionDenials: 5 })])).toEqual([]);
  });
  it('one row may yield several hints', () => {
    expect(reasons([row({ calls: 2, permissionDenials: 2 })])).toEqual(['rare', 'denied']);
  });
  it('opts override thresholds', () => {
    expect(reasons([row({ calls: 3 })], { rareMaxCalls: 3 })).toEqual(['rare']);
    expect(reasons([row({ runsWithVerdict: 2, passRate: 0 })], { minVerdictRuns: 2 })).toEqual(['low_pass']);
    expect(reasons([row({ calls: 10, permissionDenials: 2 })], { deniedMinRatio: 0.2 })).toEqual(['denied']);
    expect(reasons([row({ runsWithVerdict: 4, passRate: 0.75 })], { lowPassMax: 0.8 })).toEqual(['low_pass']);
  });
});
