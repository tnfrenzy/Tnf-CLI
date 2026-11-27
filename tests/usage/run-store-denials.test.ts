import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/core/run/run-store.js";
import type { NormalizedEvent } from "../../src/core/run/events.js";

function mk(store: RunStore, id: string) {
  return store.createRun({ id, status: "done", prompt: "p", mode: "m", model: null, session_id: null, parent_run_id: null, project: "p", claude_version: null, run_dir: "D:/x" });
}
const denied = (agent_id: string): NormalizedEvent => ({ type: "permission.denied", agent_id, tool: "Bash", reason: "no" });

describe("RunStore.listPermissionDenials", () => {
  it("returns only denials of runs in range, with just run_id and agent_id", async () => {
    const store = new RunStore(":memory:");
    const a = mk(store, "old");
    await new Promise((r) => setTimeout(r, 15));
    const b = mk(store, "new");
    store.appendEvent("old", denied("x"));
    store.appendEvent("new", denied("coder"));
    store.appendEvent("new", { type: "permission.denied", agent_id: 5, tool: "t", reason: "r" } as unknown as NormalizedEvent);
    store.appendEvent("new", { type: "rate.limit" } as unknown as NormalizedEvent);
    const out = store.listPermissionDenials({ from: b.created_at, to: b.created_at + 1000 });
    expect(a.created_at).toBeLessThan(b.created_at);
    expect(out).toEqual([
      { run_id: "new", agent_id: "coder" },
      { run_id: "new", agent_id: "" },
    ]);
    expect(Object.keys(out[0]!).sort()).toEqual(["agent_id", "run_id"]);
    expect(store.listPermissionDenials({ from: 0, to: b.created_at + 1000, limit: 1 })).toHaveLength(1);
  });
});
