import { describe, it, expect } from 'vitest';
import { computeRoleStats, type RoleStatsRun } from '../../src/core/usage/role-stats.js';

const groups = { coding: ['coder', 'both'], library: ['writer', 'both', 'idle'], cad3d: ['cad', 'both'] };
const U = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

function agent(id: string, role: string, extra: Record<string, unknown> = {}) {
  return { agent_id: id, role, parent_id: null, tool_use_id: null, status: 'finished' as const, usage: { ...U }, ...extra };
}
function run(id: string, at: number, agents: ReturnType<typeof agent>[], verdicts: { role: string; verdict: string }[] = []): RoleStatsRun {
  return {
    id,
    created_at: at,
    agents,
    verdicts: verdicts.map((v) => ({ agent_id: 'x', role: v.role, verdict: v.verdict, at })),
  } as RoleStatsRun;
}
const base = { groups, from: 100, to: 1000 };
const find = (rows: { role: string }[], role: string) => rows.find((r) => r.role === role) as ReturnType<typeof computeRoleStats>['rows'][number];

describe('computeRoleStats', () => {
  it('prioritises library > cad3d > coding, unnamed-source is other', () => {
    const res = computeRoleStats({
      ...base,
      denials: [],
      runs: [run('r1', 200, [agent('a', 'both'), agent('b', 'cad'), agent('c', 'coder'), agent('d', 'zzz')])],
    });
    expect(find(res.rows, 'both').group).toBe('library');
    expect(find(res.rows, 'cad').group).toBe('cad3d');
    expect(find(res.rows, 'coder').group).toBe('coding');
    expect(find(res.rows, 'zzz').group).toBe('other');
  });

  it('merges unknown names into one row', () => {
    const res = computeRoleStats({
      ...base,
      denials: [],
      runs: [run('r1', 200, [agent('a', ''), agent('b', 'subagent'), agent('c', 'unknown')])],
    });
    const u = res.rows.filter((r) => r.group === 'unknown');
    expect(u).toHaveLength(1);
    expect(u[0].role).toBe('unknown');
    expect(u[0].calls).toBe(3);
  });

  it('skips coordinator and counts its denials; unmatched denial goes to unknown', () => {
    const res = computeRoleStats({
      ...base,
      runs: [run('r1', 200, [agent('coordinator', 'coordinator'), agent('a', 'writer')]), run('r2', 300, [])],
      denials: [
        { run_id: 'r1', agent_id: 'coordinator' },
        { run_id: 'r1', agent_id: 'a' },
        { run_id: 'r1', agent_id: 'ghost' },
      ],
    });
    expect(res.rows.find((r) => r.role === 'coordinator')).toBeUndefined();
    expect(res.coordinatorDenials).toBe(1);
    expect(find(res.rows, 'writer').permissionDenials).toBe(1);
    expect(find(res.rows, 'unknown').permissionDenials).toBe(1);
    expect(res.runsWithoutAgents).toBe(1);
    expect(res.runsScanned).toBe(2);
  });

  it('computes passRate null and value', () => {
    const res = computeRoleStats({
      ...base,
      denials: [],
      runs: [
        run('r1', 200, [agent('a', 'writer')], [{ role: 'writer', verdict: 'PASS' }]),
        run('r2', 300, [agent('b', 'writer')], [{ role: 'writer', verdict: 'FAIL' }]),
        run('r3', 400, [agent('c', 'coder')]),
      ],
    });
    expect(find(res.rows, 'writer').passRate).toBe(0.5);
    expect(find(res.rows, 'writer').runsWithVerdict).toBe(2);
    expect(find(res.rows, 'coder').passRate).toBeNull();
  });

  it('tokens fall back to progress.total_tokens; duration and lastUsedAt', () => {
    const res = computeRoleStats({
      ...base,
      denials: [],
      runs: [
        run('r1', 200, [agent('a', 'writer', { usage: { ...U, input: 5, output: 7 }, progress: { total_tokens: 99, tool_uses: 0, duration_ms: 10 } })]),
        run('r2', 500, [agent('b', 'writer', { progress: { total_tokens: 40, tool_uses: 0, duration_ms: 5 } })]),
      ],
    });
    const w = find(res.rows, 'writer') as ReturnType<typeof computeRoleStats>['rows'][number];
    expect(w.tokens).toBe(52);
    expect(w.durationMs).toBe(15);
    expect(w.lastUsedAt).toBe(500);
  });

  it('drops runs outside the range and keeps unused library roles', () => {
    const res = computeRoleStats({
      ...base,
      denials: [{ run_id: 'old', agent_id: 'a' }],
      runs: [run('old', 50, [agent('a', 'writer')])],
    });
    expect(res.runsScanned).toBe(0);
    const idle = find(res.rows, 'idle');
    expect(idle.calls).toBe(0);
    expect(idle.lastUsedAt).toBeNull();
    expect(find(res.rows, 'writer').calls).toBe(0);
  });

  it('sorts by calls desc then role asc', () => {
    const res = computeRoleStats({
      ...base,
      denials: [],
      runs: [run('r1', 200, [agent('a', 'zed'), agent('b', 'zed'), agent('c', 'beta'), agent('d', 'alpha')])],
    });
    expect(res.rows.map((r) => r.role)).toEqual(['zed', 'alpha', 'beta', 'both', 'idle', 'writer']);
  });
});
