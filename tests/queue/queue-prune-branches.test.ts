import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitBranchPruner, type BranchRunInfo } from "../../src/core/git/branch-prune.js";
import { QueueStore, type BranchPruner } from "../../src/core/queue/queue-store.js";
import { AutomationProcessor } from "../../src/core/queue/automation-processor.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let root: string;
let repo: string;
let dataDir: string;
let clock: number;
let store: QueueStore;
let runs: Record<string, BranchRunInfo[]>;

const g = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
const branches = (): string[] => g("branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
const commitOn = (branch: string, file: string): void => {
  g("checkout", "-q", branch);
  fs.writeFileSync(path.join(repo, file), file);
  g("add", file);
  g("commit", "-q", "-m", file);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-branches-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  dataDir = path.join(root, "data");
  clock = T0;
  store = new QueueStore(dataDir, () => clock);
  runs = {};
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const pruner = (): BranchPruner => createGitBranchPruner({ repoPath: repo, baseBranch: "main", runsOfBranch: (b) => runs[b] ?? [] });
const archive = (): Record<string, unknown>[] =>
  fs.readFileSync(path.join(dataDir, "projects", "demo", "queue-archive.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

/** Adds a command already merged (state walked through the legal path) on `branch`. */
function addMerged(id: string, branch: string | null, extra: Record<string, unknown> = {}): void {
  store.addCommands("demo", [{ id, title: `T ${id}`, body: `b ${id}`, ...extra }]);
  store.transition("demo", id, "đã duyệt");
  store.transition("demo", id, "đang chạy", { runId: `run-${id}`, branch });
  store.transition("demo", id, "đã commit");
  store.transition("demo", id, "đã gộp");
}

/** Branch with one commit, merged into main with a merge commit (like releaseRun). */
function mergedBranch(name: string): void {
  g("checkout", "-q", "-b", name, "main");
  commitOn(name, `${name.replace(/\//g, "_")}.txt`);
  g("checkout", "-q", "main");
  g("merge", "-q", "--no-ff", "-m", `merge ${name}`, name);
}

describe("prune of merged commands also deleting their branches", () => {
  it("deletes an eligible branch, records its tip in the archive line first", () => {
    mergedBranch("tnf/demo/r1");
    const tip = g("rev-parse", "tnf/demo/r1");
    addMerged("a", "tnf/demo/r1");
    clock = T0 + 8 * DAY;
    const out = store.pruneMergedWithBranches("demo", 7, pruner());
    expect(out.ids).toEqual(["a"]);
    expect(out.branchesDeleted).toEqual([{ branch: "tnf/demo/r1", sha: tip }]);
    expect(branches()).toEqual(["main"]);
    expect(archive()[0]).toMatchObject({ id: "a", branch: "tnf/demo/r1", branchSha: tip, branchAction: "xóa" });
    g("branch", "restored", tip); // the recorded sha restores the branch
    expect(branches()).toContain("restored");
  });

  it("keeps a branch that is not an ancestor of main and lists it; never forces", () => {
    g("checkout", "-q", "-b", "tnf/demo/r2", "main");
    commitOn("tnf/demo/r2", "unmerged.txt");
    g("checkout", "-q", "main");
    addMerged("a", "tnf/demo/r2");
    clock = T0 + 8 * DAY;
    const out = store.pruneMergedWithBranches("demo", 7, pruner());
    expect(out.ids).toEqual(["a"]);
    expect(out.branchesDeleted).toEqual([]);
    expect(out.branchesKept).toEqual([{ branch: "tnf/demo/r2", reason: expect.stringContaining("chưa là tổ tiên") }]);
    expect(branches()).toContain("tnf/demo/r2");
    expect(archive()[0]).toMatchObject({ branchSha: null });
  });

  it("keeps a branch another remaining command still uses (shared name / idea top branch), then deletes it with the last one", () => {
    mergedBranch("tnf/demo/r3");
    addMerged("a", "tnf/demo/r3");
    clock = T0 + 5 * DAY;
    addMerged("b", "tnf/demo/r3");
    clock = T0 + 8 * DAY; // only a is old enough
    const first = store.pruneMergedWithBranches("demo", 7, pruner());
    expect(first.ids).toEqual(["a"]);
    expect(first.branchesDeleted).toEqual([]);
    expect(branches()).toContain("tnf/demo/r3");
    clock = T0 + 13 * DAY;
    const second = store.pruneMergedWithBranches("demo", 7, pruner());
    expect(second.ids).toEqual(["b"]);
    expect(second.branchesDeleted.map((b) => b.branch)).toEqual(["tnf/demo/r3"]);
    expect(branches()).toEqual(["main"]);
  });

  it("keeps the branch while an unfinished command uses the same name", () => {
    mergedBranch("tnf/demo/r4");
    addMerged("a", "tnf/demo/r4");
    store.addCommands("demo", [{ id: "next", title: "n", body: "n" }]);
    store.transition("demo", "next", "đã duyệt");
    store.transition("demo", "next", "đang chạy", { runId: "run-next", branch: "tnf/demo/r4" });
    clock = T0 + 8 * DAY;
    expect(store.pruneMergedWithBranches("demo", 7, pruner()).branchesDeleted).toEqual([]);
    expect(branches()).toContain("tnf/demo/r4");
  });

  it("keeps a branch whose worktree still exists or whose run is active", () => {
    mergedBranch("tnf/demo/r5");
    addMerged("a", "tnf/demo/r5");
    runs["tnf/demo/r5"] = [{ worktreePath: root, active: false }]; // an existing directory = worktree not removed
    clock = T0 + 8 * DAY;
    const out = store.pruneMergedWithBranches("demo", 7, pruner());
    expect(out.branchesKept[0]?.reason).toContain("worktree");
    expect(branches()).toContain("tnf/demo/r5");

    mergedBranch("tnf/demo/r6");
    addMerged("b", "tnf/demo/r6");
    runs["tnf/demo/r6"] = [{ worktreePath: null, active: true }];
    clock = T0 + 20 * DAY;
    expect(store.pruneMergedWithBranches("demo", 7, pruner()).branchesDeleted).toEqual([]);
  });

  it("keeps a branch git still has checked out in a worktree", () => {
    mergedBranch("tnf/demo/r7");
    const wt = path.join(root, "wt7");
    g("worktree", "add", "-q", wt, "tnf/demo/r7");
    addMerged("a", "tnf/demo/r7");
    clock = T0 + 8 * DAY;
    const out = store.pruneMergedWithBranches("demo", 7, pruner());
    expect(out.branchesDeleted).toEqual([]);
    expect(branches()).toContain("tnf/demo/r7");
  });

  it("does not delete the branch (nor the command) when the archive cannot be written", () => {
    mergedBranch("tnf/demo/r8");
    addMerged("a", "tnf/demo/r8");
    fs.mkdirSync(path.join(dataDir, "projects", "demo", "queue-archive.jsonl"));
    clock = T0 + 8 * DAY;
    expect(() => store.pruneMergedWithBranches("demo", 7, pruner())).toThrow();
    expect(branches()).toContain("tnf/demo/r8");
    expect(store.list("demo")).toHaveLength(1);
  });

  it("never touches main or non-tnf branches even if a command names them", () => {
    g("branch", "feat/x", "main");
    g("branch", "release/1", "main");
    for (const [i, b] of ["main", "feat/x", "release/1"].entries()) addMerged(`c${i}`, b);
    clock = T0 + 8 * DAY;
    const out = store.pruneMergedWithBranches("demo", 7, pruner());
    expect(out.ids).toHaveLength(3);
    expect(out.branchesDeleted).toEqual([]);
    expect(branches()).toEqual(["feat/x", "main", "release/1"]);
    const p = pruner();
    expect(p.inspect("main").ok).toBe(false);
    expect(p.remove("main").ok).toBe(false);
    expect(p.remove("feat/x").ok).toBe(false);
  });

  it("leaves branches alone when no pruner is given (switch off)", () => {
    mergedBranch("tnf/demo/r9");
    addMerged("a", "tnf/demo/r9");
    clock = T0 + 8 * DAY;
    expect(store.pruneMerged("demo", 7)).toEqual(["a"]);
    expect(branches()).toContain("tnf/demo/r9");
  });

  it("the processor passes the switch down, logs kept branches and reports them", async () => {
    const logs: string[] = [];
    const kept: string[] = [];
    let seen: boolean | null = null;
    const p = new AutomationProcessor({
      now: () => T0,
      utcOffsetMinutes: () => 0,
      snapshot: () => ({ enabled: true, scheduleSpec: null, pruneDone: { enabled: true, keepDays: 7, branches: true } }),
      projects: () => ["demo"],
      hasApproved: () => false,
      isActive: () => false,
      startRunAll: async () => {},
      loadLastRunAt: () => null,
      saveLastRunAt: () => {},
      pruneMerged: (_p, _d, withBranches) => {
        seen = withBranches;
        return { ids: ["a"], branchesDeleted: [{ branch: "tnf/demo/x", sha: "abcdef1234567890" }], branchesKept: [{ branch: "tnf/demo/y", reason: "chưa là tổ tiên của main" }] };
      },
      recordPruneKept: (_p, k) => kept.push(...k.map((x) => x.branch)),
      log: (m) => logs.push(m),
    });
    const r = await p.tick();
    expect(seen).toBe(true);
    expect(r.pruned?.[0]).toMatchObject({ branchesDeleted: ["tnf/demo/x"] });
    expect(kept).toEqual(["tnf/demo/y"]);
    expect(logs.some((m) => m.includes("tnf/demo/x@abcdef1234"))).toBe(true);
    expect(logs.some((m) => m.includes("kept 1 branch") && m.includes("chưa là tổ tiên"))).toBe(true);
  });
});
