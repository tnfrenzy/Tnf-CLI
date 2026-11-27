import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ControllerConfig } from '../../src/core/app/config.js';
import { startServer, type StartedServer } from '../../src/server/index.js';
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

describe('computeRoleStats QA – core', () => {
  it('handles 2000 runs x 10 agents in under 500ms', () => {
    const roles = ['writer', 'coder', 'cad', 'zzz'];
    const runs: RoleStatsRun[] = [];
    for (let i = 0; i < 2000; i++) {
      const agents = [];
      for (let j = 0; j < 10; j++) {
        agents.push(agent(`a${i}-${j}`, roles[(i + j) % roles.length], { usage: { ...U, input: 10, output: 5 } }));
      }
      runs.push(run(`r${i}`, 200 + (i % 500), agents, [{ role: 'writer', verdict: 'PASS' }]));
    }
    const input = { ...base, runs, denials: [] };
    computeRoleStats(input); // warm-up
    const t0 = performance.now();
    const res = computeRoleStats(input);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(res.runsScanned).toBe(2000);
    expect(res.rows.reduce((s, r) => s + r.calls, 0)).toBe(20000);
  });

  it('tolerates legacy runs without agents or verdicts', () => {
    const noAgents = { id: 'old1', created_at: 200, verdicts: [] } as unknown as RoleStatsRun;
    const emptyAgents = { id: 'old2', created_at: 200, agents: [], verdicts: [] } as unknown as RoleStatsRun;
    const noVerdicts = { id: 'old3', created_at: 200, agents: [agent('a', 'writer')] } as unknown as RoleStatsRun;
    const normal1 = run('n1', 300, [agent('a', 'writer'), agent('b', 'coder')], [{ role: 'writer', verdict: 'PASS' }]);
    const normal2 = run('n2', 400, [agent('a', 'writer')]);
    let res!: ReturnType<typeof computeRoleStats>;
    expect(() => {
      res = computeRoleStats({ ...base, denials: [], runs: [noAgents, emptyAgents, noVerdicts, normal1, normal2] });
    }).not.toThrow();
    expect(res.runsScanned).toBe(5);
    expect(res.runsWithoutAgents).toBe(2);
    const w = find(res.rows, 'writer');
    expect(w.calls).toBe(3);
    expect(w.runs).toBe(3);
    expect(w.runsWithVerdict).toBe(1);
    expect(find(res.rows, 'coder').calls).toBe(1);
  });

  it('merges blank/subagent/unknown/null roles into a single unknown row', () => {
    const res = computeRoleStats({
      ...base,
      denials: [],
      runs: [
        run('r1', 200, [
          agent('a', ''),
          agent('b', 'subagent'),
          agent('c', 'unknown'),
          agent('d', 'writer'),
          agent('e', null as never),
          agent('f', undefined as never),
          agent('g', '  '),
        ]),
      ],
    });
    const u = res.rows.filter((r) => r.group === 'unknown');
    expect(u).toHaveLength(1);
    expect(u[0].role).toBe('unknown');
    expect(u[0].calls).toBe(6);
    expect(find(res.rows, 'writer').calls).toBe(1);
    expect(find(res.rows, 'writer').group).toBe('library');
    expect(res.rows.filter((r) => r.group === 'other')).toHaveLength(0);
  });

  it('counts coordinator denials separately and routes unmatched agent denials to unknown', () => {
    const runs = [run('r1', 200, [agent('a', 'writer')])];
    const onlyCoord = computeRoleStats({ ...base, runs, denials: [{ run_id: 'r1', agent_id: 'coordinator' }] });
    expect(onlyCoord.coordinatorDenials).toBe(1);
    expect(onlyCoord.rows.every((r) => r.permissionDenials === 0)).toBe(true);

    const res = computeRoleStats({
      ...base,
      runs,
      denials: [
        { run_id: 'r1', agent_id: 'ghost' },
        { run_id: 'missing-run', agent_id: 'a' },
      ],
    });
    expect(res.coordinatorDenials).toBe(0);
    expect(find(res.rows, 'unknown').permissionDenials).toBe(1);
    expect(find(res.rows, 'writer').permissionDenials).toBe(0);
    expect(res.rows.reduce((s, r) => s + r.permissionDenials, 0)).toBe(1);
  });
});

describe('GET /api/library/role-stats QA – route leak check', () => {
  let started: StartedServer;
  let url: string;
  let root: string;
  const TOKEN = 't'.repeat(48);
  const MARK = 'QA-MARKER-5521';
  const WIN_PATH = 'C:\\Users\\victim\\secret\\file.txt';

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tnf-rolestats-qa-'));
    const rp = (n: string) => path.join(root, n);
    const config: ControllerConfig = {
      repoRoot: root,
      claudePath: null,
      models: [{ id: 'sonnet', label: 'sonnet' }],
      workspaceDir: rp('ws'),
      worktreesDir: path.join(root, 'ws', 'worktrees'),
      dataDir: rp('data'),
      server: { host: '127.0.0.1', port: 0, allowedOrigins: [] },
      defaults: {
        authMode: 'subscription',
        model: 'sonnet',
        maxTurns: 40,
        maxBudgetUsd: 3,
        timeoutMs: 60_000,
        allowedTools: ['Agent'],
        agentsFile: rp('roles.json'),
        systemPromptFile: rp('coord.md'),
        maxConcurrentSubagents: 3,
        maxSubagentSpawnDepth: 1,
        extraArgs: [],
        research: { allowedTools: ['Agent'], agentsFile: rp('roles.json'), systemPromptFile: rp('coord.md'), disallowedTools: [], extraArgs: [], maxRoleCalls: 8 },
        coding: {
          allowedTools: ['Agent', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash(npm test*)'],
          agentsFile: rp('roles-coding.json'),
          systemPromptFile: rp('coord-coding.md'),
          settingsFile: rp('deny.json'),
          disallowedTools: ['Bash(git push*)'],
          extraArgs: ['--setting-sources', 'project'],
          maxRoleCalls: 8,
        },
      },
      limits: { maxTurnsCeiling: 100, maxBudgetUsdCeiling: 10 },
    };
    started = await startServer({ config, port: 0, token: TOKEN, claudePath: process.execPath });
    url = `http://127.0.0.1:${started.policy.port}`;
  });

  afterAll(async () => {
    await started.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns real rows for a recent run and leaks no marker or drive path', async () => {
    const store = started.manager.store;
    const secret = `${MARK} ${WIN_PATH}`;
    store.createRun({
      id: 'qa-run-1',
      status: 'done',
      prompt: secret,
      mode: 'coding',
      model: 'sonnet',
      session_id: null,
      parent_run_id: null,
      project: 'default',
      claude_version: null,
      run_dir: path.join(root, 'qa-run-dir'),
      kind: 'coding',
      worktree_path: path.join(root, 'qa-worktree'),
      branch: 'tnf/qa-run-1',
    });
    store.updateRun('qa-run-1', {
      agents: [
        {
          agent_id: 'a1',
          role: 'zz-qa-role',
          parent_id: null,
          tool_use_id: null,
          status: 'finished',
          summary: secret,
          reply: secret,
          usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
        },
      ],
      verdicts: [{ agent_id: 'a1', role: 'zz-qa-role', verdict: 'PASS', note: secret, at: Date.now() }],
    });

    const r = await fetch(`${url}/api/library/role-stats`, { headers: { 'x-controller-token': TOKEN } });
    expect(r.status).toBe(200);
    const text = await r.text();
    const j = JSON.parse(text) as { from: number; to: number; runsScanned: number; rows: { role: string; calls: number }[] };

    const created = store.getRun('qa-run-1')?.created_at as number;
    expect(created).toBeGreaterThanOrEqual(j.from);
    expect(created).toBeLessThanOrEqual(j.to);
    expect(j.runsScanned).toBeGreaterThanOrEqual(1);
    const row = j.rows.find((x) => x.role === 'zz-qa-role');
    expect(row).toBeDefined();
    expect(row!.calls).toBeGreaterThan(0);

    expect(text).not.toContain(MARK);
    expect(text).not.toContain('victim');
    expect(text).not.toContain('C:\\\\Users');
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});
