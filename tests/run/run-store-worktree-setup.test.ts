import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../src/core/run/run-store.js";

const DEFAULT = { files: [], command: null, timeoutSec: 180 };

function mk(): RunStore {
  const store = new RunStore(":memory:");
  store.upsertProject({ name: "p1", repo_path: "/tmp/p1", base_branch: "main", allowed_commands: [] });
  return store;
}

function rawDb(store: RunStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

describe("RunStore project worktree setup", () => {
  it("returns defaults for a new or unknown project", () => {
    const store = mk();
    expect(store.getProjectWorktreeSetup("p1")).toEqual(DEFAULT);
    expect(store.getProjectWorktreeSetup("nope")).toEqual(DEFAULT);
  });

  it("round-trips set and get", () => {
    const store = mk();
    store.setProjectWorktreeSetup("p1", { files: [".env", "a/b.json"], command: "npm ci", timeoutSec: 300 });
    expect(store.getProjectWorktreeSetup("p1")).toEqual({ files: [".env", "a/b.json"], command: "npm ci", timeoutSec: 300 });
  });

  it("exposes setup fields via getProject and listProjects", () => {
    const store = mk();
    store.setProjectWorktreeSetup("p1", { files: [".env"], command: "npm ci", timeoutSec: 90 });
    const p = store.getProject("p1");
    expect(p?.setup_files).toEqual([".env"]);
    expect(p?.setup_command).toBe("npm ci");
    expect(p?.setup_timeout_sec).toBe(90);
    const l = store.listProjects().find((x) => x.name === "p1");
    expect(l?.setup_files).toEqual([".env"]);
    expect(l?.setup_command).toBe("npm ci");
    expect(l?.setup_timeout_sec).toBe(90);
  });

  it("keeps the config across upsertProject", () => {
    const store = mk();
    store.setProjectWorktreeSetup("p1", { files: [".env"], command: "make", timeoutSec: 60 });
    store.upsertProject({ name: "p1", repo_path: "/tmp/other", base_branch: "dev", allowed_commands: ["x"] });
    expect(store.getProjectWorktreeSetup("p1")).toEqual({ files: [".env"], command: "make", timeoutSec: 60 });
  });

  it("falls back to [] on corrupt JSON", () => {
    const store = mk();
    rawDb(store).prepare("UPDATE projects SET setup_files = ? WHERE name = ?").run("{not json", "p1");
    expect(store.getProjectWorktreeSetup("p1").files).toEqual([]);
    expect(store.getProject("p1")?.setup_files).toEqual([]);
    rawDb(store).prepare("UPDATE projects SET setup_files = ? WHERE name = ?").run('{"a":1}', "p1");
    expect(store.getProjectWorktreeSetup("p1").files).toEqual([]);
  });

  it("normalizes empty command to null and invalid timeout to 180", () => {
    const store = mk();
    store.setProjectWorktreeSetup("p1", { files: [], command: "   ", timeoutSec: -5 });
    expect(store.getProjectWorktreeSetup("p1")).toEqual(DEFAULT);
    rawDb(store).prepare("UPDATE projects SET setup_command = ?, setup_timeout_sec = ? WHERE name = ?").run("", 0, "p1");
    expect(store.getProjectWorktreeSetup("p1")).toEqual(DEFAULT);
  });
});
