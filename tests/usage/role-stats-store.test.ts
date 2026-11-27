import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStore } from "../../src/core/run/run-store.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function newStore(): RunStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-rolestats-"));
  dirs.push(dir);
  return new RunStore(path.join(dir, "x.db"));
}

function mkRun(store: RunStore, id: string, at: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  store.createRun({ id, status: "running", prompt: "x", mode: "m", model: null, session_id: null, parent_run_id: null, project: "default", claude_version: null, run_dir: "D:/x/" + id });
  vi.useRealTimers();
}

function denied(store: RunStore, runId: string, agent_id: string): void {
  store.appendEvent(runId, { type: "permission.denied", agent_id, tool: "Bash", reason: "no" } as any);
}

describe("RunStore.listPermissionDenials", () => {
  it("returns only permission.denied events", () => {
    const store = newStore();
    mkRun(store, "r1", 1000);
    store.appendEvent("r1", { type: "rate.limit" } as any);
    denied(store, "r1", "dev");
    expect(store.listPermissionDenials({ from: 0, to: 5000 })).toEqual([{ run_id: "r1", agent_id: "dev" }]);
    store.close();
  });

  it("filters runs by created_at range", () => {
    const store = newStore();
    mkRun(store, "r1", 1000);
    mkRun(store, "r2", 2000);
    mkRun(store, "r3", 3000);
    for (const id of ["r1", "r2", "r3"]) denied(store, id, "a");
    expect(store.listPermissionDenials({ from: 2000, to: 2000 }).map((d) => d.run_id)).toEqual(["r2"]);
    expect(store.listPermissionDenials({ from: 1000, to: 2000 }).map((d) => d.run_id)).toEqual(["r1", "r2"]);
    store.close();
  });

  it("returns only run_id and agent_id keys", () => {
    const store = newStore();
    mkRun(store, "r1", 1000);
    denied(store, "r1", "dev");
    const [d] = store.listPermissionDenials({ from: 0, to: 5000 });
    expect(Object.keys(d!).sort()).toEqual(["agent_id", "run_id"]);
    store.close();
  });

  it("keeps agent_id coordinator as is", () => {
    const store = newStore();
    mkRun(store, "r1", 1000);
    denied(store, "r1", "coordinator");
    expect(store.listPermissionDenials({ from: 0, to: 5000 })[0]!.agent_id).toBe("coordinator");
    store.close();
  });

  it("honours limit and defaults to all", () => {
    const store = newStore();
    mkRun(store, "r1", 1000);
    for (const a of ["a1", "a2", "a3", "a4", "a5"]) denied(store, "r1", a);
    expect(store.listPermissionDenials({ from: 0, to: 5000, limit: 2 }).map((d) => d.agent_id)).toEqual(["a1", "a2"]);
    expect(store.listPermissionDenials({ from: 0, to: 5000 })).toHaveLength(5);
    store.close();
  });

  it("skips malformed JSON rows without throwing", () => {
    const store = newStore();
    mkRun(store, "r1", 1000);
    (store as any).db.prepare("INSERT INTO events (run_id, ts, type, json) VALUES (?,?,?,?)").run("r1", 1, "permission.denied", "{not json");
    denied(store, "r1", "dev");
    expect(store.listPermissionDenials({ from: 0, to: 5000 })).toEqual([{ run_id: "r1", agent_id: "dev" }]);
    store.close();
  });
});
