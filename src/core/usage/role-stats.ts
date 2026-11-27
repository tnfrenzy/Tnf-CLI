import type { RoleGroups } from "./role-groups.js";
import type { RunRecord } from "../run/run-store.js";

export type RoleGroup = "library" | "cad3d" | "coding" | "other" | "unknown";

export interface PermissionDenialRef {
  run_id: string;
  agent_id: string;
}

export interface RoleStatRow {
  role: string;
  group: RoleGroup;
  calls: number;
  runs: number;
  tokens: number;
  durationMs: number;
  runsWithVerdict: number;
  passRuns: number;
  passRate: number | null;
  permissionDenials: number;
  lastUsedAt: number | null;
}

export type RoleStatsRun = Pick<RunRecord, "id" | "created_at" | "agents" | "verdicts">;

export interface RoleStatsInput {
  runs: RoleStatsRun[];
  denials: PermissionDenialRef[];
  groups: RoleGroups;
  from: number;
  to: number;
}

export interface RoleStatsResult {
  runsScanned: number;
  runsWithoutAgents: number;
  coordinatorDenials: number;
  rows: RoleStatRow[];
}

export const PASS_VERDICTS: readonly string[] = ["APPROVED", "APPROVED_WITH_CONCERNS", "PASS", "PASS_ENV"];
export const UNKNOWN_ROLE_NAMES: readonly string[] = ["", "subagent", "unknown"];

const COORDINATOR = "coordinator";

interface Acc {
  row: RoleStatRow;
  runIds: Set<string>;
  verdictRuns: Set<string>;
  passRuns: Set<string>;
}

export function computeRoleStats(input: RoleStatsInput): RoleStatsResult {
  const { groups } = input;
  const library = new Set(groups.library);
  const cad3d = new Set(groups.cad3d);
  const coding = new Set(groups.coding);

  const accs = new Map<string, Acc>();
  const classify = (name: string): { role: string; group: RoleGroup } => {
    if (UNKNOWN_ROLE_NAMES.includes((name ?? "").trim())) return { role: "unknown", group: "unknown" };
    if (library.has(name)) return { role: name, group: "library" };
    if (cad3d.has(name)) return { role: name, group: "cad3d" };
    if (coding.has(name)) return { role: name, group: "coding" };
    return { role: name, group: "other" };
  };
  const get = (name: string): Acc => {
    const c = classify(name);
    let a = accs.get(c.role);
    if (!a) {
      a = {
        row: {
          role: c.role, group: c.group, calls: 0, runs: 0, tokens: 0, durationMs: 0,
          runsWithVerdict: 0, passRuns: 0, passRate: null, permissionDenials: 0, lastUsedAt: null,
        },
        runIds: new Set(), verdictRuns: new Set(), passRuns: new Set(),
      };
      accs.set(c.role, a);
    }
    return a;
  };

  for (const id of groups.library) get(id);

  const runs = input.runs.filter((r) => r.created_at >= input.from && r.created_at <= input.to);
  const agentRole = new Map<string, Map<string, string>>();
  let runsWithoutAgents = 0;

  for (const run of runs) {
    const agents = (run.agents ?? []).filter((a) => a.role !== COORDINATOR && a.agent_id !== COORDINATOR);
    const map = new Map<string, string>();
    agentRole.set(run.id, map);
    if (agents.length === 0) runsWithoutAgents++;
    for (const ag of agents) {
      map.set(ag.agent_id, ag.role);
      const a = get(ag.role);
      a.row.calls++;
      a.runIds.add(run.id);
      const u = ag.usage;
      let tokens = (u?.input ?? 0) + (u?.output ?? 0);
      if (tokens === 0) tokens = ag.progress?.total_tokens ?? 0;
      a.row.tokens += tokens;
      a.row.durationMs += ag.progress?.duration_ms ?? 0;
      if (a.row.lastUsedAt === null || run.created_at > a.row.lastUsedAt) a.row.lastUsedAt = run.created_at;
    }
    for (const v of run.verdicts ?? []) {
      if (v.role === COORDINATOR) continue;
      const a = get(v.role);
      a.verdictRuns.add(run.id);
      if (PASS_VERDICTS.includes(v.verdict)) a.passRuns.add(run.id);
    }
  }

  let coordinatorDenials = 0;
  for (const d of input.denials) {
    if (d.agent_id === COORDINATOR) {
      coordinatorDenials++;
      continue;
    }
    const map = agentRole.get(d.run_id);
    if (!map) continue;
    const role = map.get(d.agent_id);
    get(role === undefined ? "unknown" : role).row.permissionDenials++;
  }

  const rows: RoleStatRow[] = [];
  for (const a of accs.values()) {
    a.row.runs = a.runIds.size;
    a.row.runsWithVerdict = a.verdictRuns.size;
    a.row.passRuns = a.passRuns.size;
    a.row.passRate = a.row.runsWithVerdict > 0 ? a.row.passRuns / a.row.runsWithVerdict : null;
    rows.push(a.row);
  }
  rows.sort((x, y) => y.calls - x.calls || (x.role < y.role ? -1 : x.role > y.role ? 1 : 0));

  return { runsScanned: runs.length, runsWithoutAgents, coordinatorDenials, rows };
}
