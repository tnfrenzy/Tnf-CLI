import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUEUE_STATUSES, QueueStore, type QueueStatus } from "../../src/core/queue/queue-store.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);

let dir: string;
let clock: number;
let store: QueueStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-prune-"));
  clock = T0;
  store = new QueueStore(dir, () => clock);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const cmd = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, body: `body ${id}`, ...extra });

/** Walks a command along the legal path until it reaches `to` (all steps stamped at the current clock). */
function reach(id: string, to: QueueStatus): void {
  const path: Record<string, QueueStatus[]> = {
    "chờ duyệt": [],
    "đã duyệt": ["đã duyệt"],
    "đang chạy": ["đã duyệt", "đang chạy"],
    "đã commit": ["đã duyệt", "đang chạy", "đã commit"],
    "đã gộp": ["đã duyệt", "đang chạy", "đã commit", "đã gộp"],
    "lỗi": ["đã duyệt", "đang chạy", "lỗi"],
    "bỏ qua": ["bỏ qua"],
  };
  for (const s of path[to] ?? []) store.transition("demo", id, s, s === "đang chạy" ? { runId: `r-${id}`, branch: `tnf/${id}` } : {});
}

describe("QueueStore.pruneMerged", () => {
  it("deletes only merged commands, whatever the other statuses and ages", () => {
    store.addCommands("demo", QUEUE_STATUSES.map((s) => cmd(`c-${s}`.replace(/\s/g, "_"))));
    for (const s of QUEUE_STATUSES) reach(`c-${s}`.replace(/\s/g, "_"), s);
    clock = T0 + 100 * DAY;
    const removed = store.pruneMerged("demo", 7);
    expect(removed).toEqual(["c-đã_gộp"]);
    const left = store.list("demo").map((c) => c.status).sort();
    expect(left).toEqual(QUEUE_STATUSES.filter((s) => s !== "đã gộp").sort());
  });

  it("respects the age window: kept just before, deleted at the boundary", () => {
    store.addCommands("demo", [cmd("a")]);
    reach("a", "đã gộp");
    clock = T0 + 7 * DAY - 1;
    expect(store.pruneMerged("demo", 7)).toEqual([]);
    expect(store.list("demo")).toHaveLength(1);
    clock = T0 + 7 * DAY;
    expect(store.pruneMerged("demo", 7)).toEqual(["a"]);
    expect(store.list("demo")).toHaveLength(0);
  });

  it("keeps a merged command while an unfinished command still depends on it", () => {
    store.addCommands("demo", [cmd("a"), cmd("b", { dependsOn: ["a"] }), cmd("c"), cmd("d", { dependsOn: ["c"] })]);
    reach("a", "đã gộp");
    reach("c", "đã gộp");
    reach("d", "đã gộp");
    clock = T0 + 30 * DAY;
    // b (chờ duyệt) still needs a; d is merged itself so it does not protect c.
    expect(store.pruneMerged("demo", 7).sort()).toEqual(["c", "d"]);
    expect(store.list("demo").map((c) => c.id).sort()).toEqual(["a", "b"]);
    // Once b is merged and old, both go.
    reach("b", "đã gộp");
    clock += 8 * DAY;
    expect(store.pruneMerged("demo", 7).sort()).toEqual(["a", "b"]);
  });

  it("drops idea meta only when the idea has no command left", () => {
    store.addCommands("demo", [cmd("a", { sourceRef: "idea-1" }), cmd("b", { sourceRef: "idea-1" }), cmd("x", { sourceRef: "idea-2" })]);
    store.setIdeaMeta("demo", "idea-1", { warnings: ["w"] });
    store.setIdeaMeta("demo", "idea-2", { warnings: ["w2"] });
    reach("a", "đã gộp");
    reach("x", "đã gộp");
    clock = T0 + 30 * DAY;
    expect(store.pruneMerged("demo", 7).sort()).toEqual(["a", "x"]);
    expect(store.getIdeaMeta("demo", "idea-1")).not.toBeNull(); // b is still there
    expect(store.getIdeaMeta("demo", "idea-2")).toBeNull();
    reach("b", "đã gộp");
    clock += 8 * DAY;
    expect(store.pruneMerged("demo", 7)).toEqual(["b"]);
    expect(store.getIdeaMeta("demo", "idea-1")).toBeNull();
  });

  it("does not write the queue file when nothing is removed", () => {
    store.addCommands("demo", [cmd("a")]);
    const file = path.join(dir, "projects", "demo", "queue.json");
    const before = fs.statSync(file).mtimeMs;
    const content = fs.readFileSync(file, "utf8");
    clock = T0 + 30 * DAY;
    expect(store.pruneMerged("demo", 7)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it("rejects the default project and bad day counts", () => {
    expect(() => store.pruneMerged("default", 7)).toThrow();
    expect(() => store.pruneMerged("demo", -1)).toThrow();
    expect(() => store.pruneMerged("demo", Number.NaN)).toThrow();
  });
});

describe("QueueStore.pruneMerged archive and mergedAt", () => {
  const archiveFile = () => path.join(dir, "projects", "demo", "queue-archive.jsonl");

  it("stamps mergedAt on the move to đã gộp", () => {
    store.addCommands("demo", [cmd("a")]);
    reach("a", "đã gộp");
    expect(store.get("demo", "a")?.mergedAt).toBe(T0);
  });

  it("appends one JSON line per deleted command and never rewrites earlier lines", () => {
    store.addCommands("demo", [cmd("a", { ideaTitle: "Idea" }), cmd("b")]);
    reach("a", "đã gộp");
    clock = T0 + 10 * DAY;
    expect(store.pruneMerged("demo", 7)).toEqual(["a"]);
    reach("b", "đã gộp");
    clock += 10 * DAY;
    expect(store.pruneMerged("demo", 7)).toEqual(["b"]);
    const lines = fs.readFileSync(archiveFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l["id"])).toEqual(["a", "b"]);
    expect(lines[0]).toMatchObject({ title: "T a", ideaTitle: "Idea", status: "đã gộp", runId: "r-a", branch: "tnf/a", mergedAt: T0, archivedAt: T0 + 10 * DAY });
  });

  it("writes no archive when nothing is deleted", () => {
    store.addCommands("demo", [cmd("a")]);
    clock = T0 + 30 * DAY;
    store.pruneMerged("demo", 7);
    expect(fs.existsSync(archiveFile())).toBe(false);
  });

  it("deletes nothing when the archive cannot be written", () => {
    store.addCommands("demo", [cmd("a")]);
    reach("a", "đã gộp");
    fs.mkdirSync(archiveFile()); // a directory where the file should be: append fails
    clock = T0 + 30 * DAY;
    expect(() => store.pruneMerged("demo", 7)).toThrow();
    expect(store.list("demo").map((c) => c.id)).toEqual(["a"]);
  });

  it("ages a legacy merged command (no mergedAt) from updatedAt", () => {
    store.addCommands("demo", [cmd("a")]);
    reach("a", "đã gộp");
    const file = path.join(dir, "projects", "demo", "queue.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { commands: Record<string, unknown>[] };
    delete raw.commands[0]!["mergedAt"];
    fs.writeFileSync(file, JSON.stringify(raw));
    clock = T0 + 7 * DAY - 1;
    expect(store.pruneMerged("demo", 7)).toEqual([]);
    clock = T0 + 7 * DAY;
    expect(store.pruneMerged("demo", 7)).toEqual(["a"]);
  });
});
