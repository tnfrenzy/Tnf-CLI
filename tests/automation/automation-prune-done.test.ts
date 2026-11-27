import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AutomationProcessor, type AutomationDeps } from "../../src/core/queue/automation-processor.js";
import type { PruneOutcome } from "../../src/core/queue/queue-store.js";
import { AutopilotState } from "../../src/core/queue/autopilot-state.js";
import { parseAutomation, parsePruneDone, type ControllerConfig } from "../../src/core/app/config.js";
import { vi as viDict } from "../../ui/src/i18n/vi.js";
import { en as enDict } from "../../ui/src/i18n/en.js";

const NOW = Date.UTC(2026, 10, 3, 5, 0);

function mkDeps(over: Partial<AutomationDeps> = {}): AutomationDeps {
  return {
    now: () => NOW,
    utcOffsetMinutes: () => 0,
    snapshot: () => ({ enabled: true, scheduleSpec: null, pruneDone: { enabled: true, keepDays: 7, branches: false } }),
    projects: () => ["a", "b"],
    hasApproved: () => false,
    isActive: () => false,
    startRunAll: async () => {},
    loadLastRunAt: () => null,
    saveLastRunAt: () => {},
    ...over,
  };
}

describe("AutomationProcessor prune step", () => {
  it("prunes every project each tick, logs count and ids", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const p = new AutomationProcessor(
      mkDeps({
        pruneMerged: (project, days) => {
          calls.push(`${project}:${days}`);
          return out(project === "a" ? ["x1", "x2"] : []);
        },
        log: (m) => logs.push(m),
      }),
    );
    const r = await p.tick();
    expect(r.status).toBe("no_schedule");
    expect(calls).toEqual(["a:7", "b:7"]);
    expect(r.pruned).toEqual([{ project: "a", ids: ["x1", "x2"], branchesDeleted: [], branchesKept: [] }]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("2 merged");
    expect(logs[0]).toContain("x1, x2");
  });

  it("does nothing when the switch is off or autopilot is off", async () => {
    const pruneMerged = vi_fn();
    const off = new AutomationProcessor(mkDeps({ pruneMerged, snapshot: () => ({ enabled: true, scheduleSpec: null, pruneDone: { enabled: false, keepDays: 7, branches: false } }) }));
    expect((await off.tick()).pruned).toBeUndefined();
    const ap = new AutomationProcessor(mkDeps({ pruneMerged, snapshot: () => ({ enabled: false, scheduleSpec: null, pruneDone: { enabled: true, keepDays: 7, branches: false } }) }));
    expect((await ap.tick()).status).toBe("off");
    expect(pruneMerged.calls).toBe(0);
  });

  it("never throws: one failing project is logged and the others still run", async () => {
    const logs: string[] = [];
    const p = new AutomationProcessor(
      mkDeps({
        pruneMerged: (project) => {
          if (project === "a") throw new Error("boom");
          return out(["ok1"]);
        },
        log: (m) => logs.push(m),
      }),
    );
    const r = await p.tick();
    expect(r.pruned).toEqual([{ project: "b", ids: ["ok1"], branchesDeleted: [], branchesKept: [] }]);
    expect(logs.some((m) => m.includes("a: prune failed: boom"))).toBe(true);
  });

  it("survives projects() throwing", async () => {
    const p = new AutomationProcessor(mkDeps({ pruneMerged: () => out([]), projects: () => { throw new Error("db down"); } }));
    await expect(p.tick()).resolves.toMatchObject({ status: "no_schedule" });
  });
});

function out(ids: string[]): PruneOutcome {
  return { ids, branchesDeleted: [], branchesKept: [] };
}

function vi_fn(): (() => PruneOutcome) & { calls: number } {
  const f = (() => {
    f.calls++;
    return out([]);
  }) as (() => PruneOutcome) & { calls: number };
  f.calls = 0;
  return f;
}

describe("pruneDone config and state", () => {
  it("defaults off with 7 days", () => {
    expect(parsePruneDone(undefined)).toEqual({ enabled: false, keepDays: 7, branches: false });
    expect(parseAutomation({}).pruneDone).toEqual({ enabled: false, keepDays: 7, branches: false });
    expect(parseAutomation({ pruneDone: { enabled: true, keepDays: 30, branches: false } }).pruneDone).toEqual({ enabled: true, keepDays: 30, branches: false });
    expect(parseAutomation({ pruneDone: { enabled: true } }).pruneDone).toEqual({ enabled: true, keepDays: 7, branches: false });
  });

  it.each([{ keepDays: 0, branches: false }, { keepDays: 366 }, { keepDays: 1.5 }, { keepDays: "7" }, { enabled: "yes" }, []])("rejects %j", (bad) => {
    expect(() => parseAutomation({ pruneDone: bad })).toThrow(/config: automation\.pruneDone/);
  });

  it("AutopilotState seeds from config and validates updates", () => {
    const cfg = parseAutomation({ pruneDone: { enabled: true, keepDays: 3, branches: false } });
    const s = new AutopilotState(cfg as ControllerConfig["automation"]);
    expect(s.snapshot().pruneDone).toEqual({ enabled: true, keepDays: 3, branches: false });
    s.setPruneDone(false, 14);
    s.setPruneDone(false, 14, true);
    expect(s.snapshot().pruneDone.branches).toBe(true);
    expect(() => s.setPruneDone(false, 14, "x")).toThrow();
    s.setPruneDone(false, 14, false);
    expect(s.snapshot().pruneDone).toEqual({ enabled: false, keepDays: 14, branches: false });
    expect(() => s.setPruneDone(true, 0)).toThrow();
    expect(() => s.setPruneDone("x", 5)).toThrow();
    expect(s.snapshot().pruneDone).toEqual({ enabled: false, keepDays: 14, branches: false });
    expect(new AutopilotState().snapshot().pruneDone).toEqual({ enabled: false, keepDays: 7, branches: false });
  });
});

describe("pruneDone UI + i18n", () => {
  it("panel wires the switch and day count through t() and the API", () => {
    const src = fs.readFileSync("ui/src/pages/AutomationPanel.tsx", "utf8");
    for (const s of ["t.auto_prune", "t.auto_prune_days", "t.auto_prune_hint", "t.auto_prune_branches", "t.auto_prune_kept", "autopilotSetPruneDone"]) expect(src).toContain(s);
    expect(fs.readFileSync("ui/src/api.ts", "utf8")).toContain("/api/autopilot/prune-done");
  });

  it("has the keys in both languages and English has no Vietnamese", () => {
    const vi = viDict as Record<string, string>;
    const en = enDict as Record<string, string>;
    for (const k of ["auto_prune", "auto_prune_days", "auto_prune_hint", "auto_prune_branches", "auto_prune_branches_hint", "auto_prune_kept", "auto_prune_days_bad"]) {
      expect(vi[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
      expect(en[k]).not.toMatch(/[àáạảãâăđêôơưÀÁĐ]/i);
    }
  });
});
