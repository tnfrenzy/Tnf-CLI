import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRoleEvalService, type RoleEvalManager } from "../../src/core/roles/role-eval-runner.js";
import { RoleEvalStore } from "../../src/core/roles/role-eval-store.js";
import { aggregateRoleEval, gradeRoleEvalOutput } from "../../src/core/roles/role-eval.js";
import { roleVersionHash } from "../../src/core/roles/role-eval-util.js";
import type { LibraryRole } from "../../src/core/roles/role-library.js";

let root: string;
let store: RoleEvalStore;
const role: LibraryRole = { id: "dev", description: "Dev", prompt: "Bạn là dev." };

const cases = () => [
  { id: "c1", title: "Một", prompt: "Đề 1", checks: [{ type: "contains", value: "ok" }] },
  { id: "c2", title: "Hai", prompt: "Đề 2", checks: [{ type: "contains", value: "ok" }] },
];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "role-eval-runner-"));
  store = new RoleEvalStore(path.join(root, "evals"));
  store.setCases("dev", cases());
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeManager(opts: { hold?: boolean } = {}) {
  const calls: Parameters<RoleEvalManager["startRun"]>[0][] = [];
  const cancelled: string[] = [];
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let n = 0;
  const manager: RoleEvalManager = {
    async startRun(input) {
      calls.push(input);
      return { id: `run-${++n}` };
    },
    async waitFor(id) {
      if (opts.hold) await gate;
      return { status: "done", result_text: "ok", cost_usd_est: 0.1 };
    },
    cancel(id) {
      cancelled.push(id);
      release?.();
      return true;
    },
  };
  return { manager, calls, cancelled };
}

const mk = (manager: RoleEvalManager) =>
  createRoleEvalService({ manager, store, getRole: (id) => (id === "dev" ? role : null), readStream: () => "" });

describe("RoleEvalService", () => {
  it("runs read-only with the role prompt, cases x repeats, and stores the aggregate", async () => {
    const { manager, calls } = fakeManager();
    const svc = mk(manager);
    expect(svc.start("dev", 2)).toEqual({ started: true });
    await svc.done("dev");
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.readOnly.allowedTools).toEqual(["Read", "Grep", "Glob"]);
      expect(c.readOnly.addDirs).toEqual([]);
      expect(c.readOnly).not.toHaveProperty("writeDirs");
      expect(c.readOnly.systemPrompt).toBe(role.prompt);
    }
    const [res] = store.listResults("dev");
    expect(res!.version).toBe(roleVersionHash(role));
    expect(res!.costUsd).toBeCloseTo(0.4);
    expect(res!.runIds).toHaveLength(4);
    const cs = cases();
    const att = Object.fromEntries(
      cs.map((c) => [c.id, [0, 1].map(() => gradeRoleEvalOutput(c as never, { text: "ok", toolNames: [] }))]),
    );
    expect(res!.score).toBe(aggregateRoleEval(cs as never, att).score);
  });

  it("clamps repeats and rejects unknown role / second start while running", async () => {
    const { manager, calls } = fakeManager({ hold: true });
    const svc = mk(manager);
    expect(svc.start("nope").started).toBe(false);
    expect(svc.start("dev", 99)).toEqual({ started: true });
    const again = svc.start("dev");
    expect(again.started).toBe(false);
    expect(again.reason).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    svc.cancel("dev");
    await svc.done("dev");
    expect(calls).toHaveLength(1);
  });

  it("cancel calls manager.cancel and stores a result with error", async () => {
    const { manager, cancelled } = fakeManager({ hold: true });
    const svc = mk(manager);
    svc.start("dev");
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.cancel("dev")).toBe(true);
    await svc.done("dev");
    expect(cancelled).toEqual(["run-1"]);
    const [res] = store.listResults("dev");
    expect(res!.error).toBeTruthy();
    expect(res!.passed).toBe(false);
  });

  it("removeRole while running cancels and deletes the role file", async () => {
    const { manager, cancelled } = fakeManager({ hold: true });
    const svc = mk(manager);
    svc.start("dev");
    await new Promise((r) => setTimeout(r, 10));
    svc.removeRole("dev");
    await svc.done("dev");
    expect(cancelled).toEqual(["run-1"]);
    expect(fs.existsSync(path.join(root, "evals", "dev.json"))).toBe(false);
  });
});
