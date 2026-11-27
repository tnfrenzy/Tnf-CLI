// Background role-eval runner: runs each eval case x repeats read-only through the RunManager.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReadOnlySpec } from "../run/run-input.js";
import type { RunManager } from "../run/run-manager.js";
import type { LibraryRole } from "./role-library.js";
import { RoleEvalStore } from "./role-eval-store.js";
import { aggregateRoleEval, gradeRoleEvalOutput, type RoleEvalAttempt, type RoleEvalRunResult } from "./role-eval.js";
import { extractToolNames, roleVersionHash } from "./role-eval-util.js";

export const ROLE_EVAL_TOOLS = ["Read", "Grep", "Glob"] as const;

export interface RoleEvalManager {
  startRun(input: { prompt: string; project: string; maxBudgetUsd?: number; model?: string; readOnly: ReadOnlySpec }): Promise<{ id: string }>;
  waitFor(runId: string): Promise<{ status?: string; result_text?: string | null; error?: string | null; cost_usd_est?: number | null } | null>;
  cancel(runId: string): boolean;
}

export interface RoleEvalDeps {
  manager: RoleEvalManager;
  store: RoleEvalStore;
  getRole(id: string): LibraryRole | null;
  readStream(runId: string): string;
  maxBudgetUsd?: number;
  now?: () => number;
}

export interface RoleEvalService {
  start(roleId: string, repeats?: number): { started: boolean; reason?: string };
  cancel(roleId: string): boolean;
  removeRole(roleId: string): void;
  isRunning(roleId: string): boolean;
  done(roleId: string): Promise<void>;
}

interface Active {
  cancelled: boolean;
  removed: boolean;
  runId: string | null;
  done: Promise<void>;
}

export function createRoleEvalService(deps: RoleEvalDeps): RoleEvalService {
  const active = new Map<string, Active>();
  const now = deps.now ?? Date.now;

  async function loop(roleId: string, role: LibraryRole, repeats: number, st: Active): Promise<void> {
    const cases = deps.store.getCases(roleId);
    const attempts: Record<string, RoleEvalAttempt[]> = {};
    const runIds: string[] = [];
    let cost = 0;
    let error: string | undefined;
    const startedAt = now();
    try {
      outer: for (const c of cases) {
        attempts[c.id] = [];
        for (let i = 0; i < repeats; i++) {
          if (st.cancelled) {
            error = "Đã hủy";
            break outer;
          }
          let text = "";
          let toolNames: string[] = [];
          try {
            const { id } = await deps.manager.startRun({
              prompt: c.prompt,
              project: "role-eval",
              maxBudgetUsd: deps.maxBudgetUsd ?? 0.5,
              readOnly: { systemPrompt: role.prompt, allowedTools: [...ROLE_EVAL_TOOLS], addDirs: [] },
            });
            st.runId = id;
            runIds.push(id);
            const rec = await deps.manager.waitFor(id);
            if (rec && typeof rec.cost_usd_est === "number" && Number.isFinite(rec.cost_usd_est)) cost += rec.cost_usd_est;
            if (rec && rec.status === "done") {
              text = rec.result_text ?? "";
              try {
                toolNames = extractToolNames(deps.readStream(id));
              } catch {
                toolNames = [];
              }
            } else {
              text = "";
              toolNames = [];
              // failed run counts as a failed attempt: grade an empty output below, then force fail
              attempts[c.id]!.push({ score: 0, passed: false, checks: c.checks.map((ck, index) => ({ index, type: ck.type as string, ok: false })) });
              st.runId = null;
              continue;
            }
          } catch {
            attempts[c.id]!.push({ score: 0, passed: false, checks: c.checks.map((ck, index) => ({ index, type: ck.type as string, ok: false })) });
            st.runId = null;
            continue;
          }
          st.runId = null;
          attempts[c.id]!.push(gradeRoleEvalOutput(c, { text, toolNames }));
        }
      }
      if (st.cancelled && !error) error = "Đã hủy";
    } catch (e) {
      error = `Lỗi không mong đợi khi chạy eval: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (st.removed) return;
    try {
      const agg = aggregateRoleEval(cases, attempts);
      const result: RoleEvalRunResult = {
        id: `${roleId}-${startedAt}`,
        roleId,
        version: roleVersionHash(role),
        at: new Date(now()).toISOString(),
        repeats,
        cases: agg.cases,
        score: agg.score,
        passed: error ? false : agg.passed,
        costUsd: cost,
        runIds,
      };
      if (error) result.error = error;
      deps.store.appendResult(result);
    } catch {
      // storage failure must not escape the background loop
    }
  }

  return {
    start(roleId, repeats) {
      const n = typeof repeats === "number" && Number.isFinite(repeats) ? Math.min(3, Math.max(1, Math.floor(repeats))) : 1;
      const role = deps.getRole(roleId);
      if (!role) return { started: false, reason: `Không tìm thấy vai "${roleId}".` };
      if (deps.store.getCases(roleId).length === 0) return { started: false, reason: "Vai chưa có ca đánh giá nào." };
      if (active.has(roleId)) return { started: false, reason: "Vai đang được đánh giá, hãy chờ chạy xong." };
      const st: Active = { cancelled: false, removed: false, runId: null, done: Promise.resolve() };
      active.set(roleId, st);
      st.done = loop(roleId, role, n, st)
        .catch(() => undefined)
        .finally(() => {
          if (active.get(roleId) === st) active.delete(roleId);
        });
      return { started: true };
    },
    cancel(roleId) {
      const st = active.get(roleId);
      if (!st) return false;
      st.cancelled = true;
      if (st.runId) {
        try {
          deps.manager.cancel(st.runId);
        } catch {
          // ignore
        }
      }
      return true;
    },
    removeRole(roleId) {
      const st = active.get(roleId);
      if (st) {
        st.removed = true;
        this.cancel(roleId);
      }
      deps.store.remove(roleId);
    },
    isRunning: (roleId) => active.has(roleId),
    done: (roleId) => active.get(roleId)?.done ?? Promise.resolve(),
  };
}

const services = new WeakMap<RunManager, RoleEvalService>();

export function getRoleEvalService(manager: RunManager): RoleEvalService {
  let svc = services.get(manager);
  if (!svc) {
    const dataDir = manager.config.dataDir;
    svc = createRoleEvalService({
      manager: manager as unknown as RoleEvalManager,
      store: new RoleEvalStore(path.join(dataDir, "library", "role-evals")),
      getRole: (id) => manager.library.getRole(id) ?? null,
      readStream: (runId) => {
        try {
          return readFileSync(path.join(dataDir, "runs", runId, "stream.jsonl"), "utf8");
        } catch {
          return "";
        }
      },
      now: Date.now,
    });
    services.set(manager, svc);
  }
  return svc;
}
