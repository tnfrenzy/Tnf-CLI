import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibraryError, MAX_ITEM_BYTES, MAX_LIBRARY_ITEMS, MAX_LIBRARY_ROLES, RoleLibrary } from "../../src/core/roles/role-library.js";

let dir: string;
let lib: RoleLibrary;
const file = () => path.join(dir, "library", "library.json");
const raw = () => fs.readFileSync(file(), "utf8");
const mk = (prompt: string, id = "wording") => ({ id, description: "Soát câu chữ", prompt, tools: ["Read"] });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-restore-"));
  lib = new RoleLibrary(path.join(dir, "library"), () => ["coder", "reviewer"]);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LibraryError);
    return (e as LibraryError).status;
  }
  throw new Error("expected an error");
};

describe("restoreVersion - role", () => {
  it("restores old data and snapshots the current one", () => {
    lib.createRole(mk("A"));
    lib.updateRole("wording", { prompt: "B" });
    const h = lib.history("role", "wording");
    expect(h).toHaveLength(1);
    const out = lib.restoreVersion("role", "wording", h[0]!.id);
    expect(out.role?.prompt).toBe("A");
    expect(lib.getRole("wording")?.prompt).toBe("A");
    const h2 = lib.history("role", "wording");
    expect(h2.length).toBeGreaterThan(1);
    expect(h2[0]!.note).toContain("Trước khi khôi phục");
    expect(h2[0]!.note).toContain(h[0]!.id);
    expect(h2[0]!.role?.prompt).toBe("B");
  });

  it("uses the given note", () => {
    lib.createRole(mk("A"));
    lib.updateRole("wording", { prompt: "B" });
    const h = lib.history("role", "wording");
    lib.restoreVersion("role", "wording", h[0]!.id, "  quay lại  ");
    expect(lib.history("role", "wording")[0]!.note).toBe("quay lại");
  });

  it("recreates a deleted role and keeps history", () => {
    lib.createRole(mk("A"));
    lib.updateRole("wording", { prompt: "B" });
    const h = lib.history("role", "wording");
    lib.deleteRole("wording");
    lib.restoreVersion("role", "wording", h[0]!.id);
    expect(lib.list().roles.find((r) => r.id === "wording")?.prompt).toBe("A");
    expect(lib.history("role", "wording").map((v) => v.id)).toEqual(h.map((v) => v.id));
  });

  it("404 for unknown version id", () => {
    lib.createRole(mk("A"));
    expect(status(() => lib.restoreVersion("role", "wording", "nope"))).toBe(404);
  });

  it("409 for builtin id and file untouched", () => {
    lib.createRole(mk("A"));
    const j = JSON.parse(raw()) as Record<string, unknown>;
    j["versions"] = [{ id: "v1", kind: "role", entryId: "coder", at: 1, note: "", role: mk("X", "coder") }];
    fs.writeFileSync(file(), JSON.stringify(j), "utf8");
    const before = raw();
    expect(status(() => lib.restoreVersion("role", "coder", "v1"))).toBe(409);
    expect(raw()).toBe(before);
  });

  it("400 when library is full and file untouched", () => {
    lib.createRole(mk("A"));
    lib.updateRole("wording", { prompt: "B" });
    const h = lib.history("role", "wording");
    lib.deleteRole("wording");
    for (let n = 0; n < MAX_LIBRARY_ROLES; n++) lib.createRole(mk("P", `r${n}`));
    const before = raw();
    expect(status(() => lib.restoreVersion("role", "wording", h[0]!.id))).toBe(400);
    expect(raw()).toBe(before);
  });
});

describe("restoreVersion - item", () => {
  const mi = (content: string, name = "Mau", extra: Record<string, unknown> = {}) => ({ name, type: "prompt", content, ...extra });

  it("restores content, keeps createdAt, snapshots current", () => {
    const it0 = lib.createItem(mi("A"));
    lib.updateItem(it0.id, { content: "B" });
    const h = lib.history("item", it0.id);
    const out = lib.restoreVersion("item", it0.id, h[0]!.id);
    expect(out.item?.content).toBe("A");
    expect(out.item?.createdAt).toBe(it0.createdAt);
    const h2 = lib.history("item", it0.id);
    expect(h2.length).toBeGreaterThan(1);
    expect(h2[0]!.note).toContain("Trước khi khôi phục");
    expect(h2[0]!.item?.content).toBe("B");
  });

  it("recreates a deleted item with the same id", () => {
    const it0 = lib.createItem(mi("A"));
    lib.updateItem(it0.id, { content: "B" });
    const h = lib.history("item", it0.id);
    lib.deleteItem(it0.id);
    lib.restoreVersion("item", it0.id, h[0]!.id);
    const got = lib.list().items.find((x) => x.id === it0.id);
    expect(got?.content).toBe("A");
  });

  it("404 for unknown version id", () => {
    const it0 = lib.createItem(mi("A"));
    expect(status(() => lib.restoreVersion("item", it0.id, "nope"))).toBe(404);
  });

  it("400 when library is full and file untouched", () => {
    const it0 = lib.createItem(mi("A"));
    lib.updateItem(it0.id, { content: "B" });
    const h = lib.history("item", it0.id);
    lib.deleteItem(it0.id);
    for (let n = 0; n < MAX_LIBRARY_ITEMS; n++) lib.createItem(mi("P", `Muc ${n}`));
    const before = raw();
    expect(status(() => lib.restoreVersion("item", it0.id, h[0]!.id))).toBe(400);
    expect(raw()).toBe(before);
  });

  it("filters roleIds of deleted roles, keeps builtin", () => {
    lib.createRole(mk("A", "gone"));
    const it0 = lib.createItem(mi("A", "Mau", { roleIds: ["gone", "coder"] }));
    lib.updateItem(it0.id, { content: "B" });
    const h = lib.history("item", it0.id);
    lib.deleteRole("gone");
    lib.deleteItem(it0.id);
    const out = lib.restoreVersion("item", it0.id, h[0]!.id);
    expect(out.item?.roleIds).toEqual(["coder"]);
  });

  it("400 for oversize snapshot content and file untouched", () => {
    lib.createItem(mi("A"));
    const j = JSON.parse(raw()) as Record<string, unknown>;
    const big = { id: "big", name: "Big", type: "prompt", content: "x".repeat(MAX_ITEM_BYTES + 10), roleIds: [], createdAt: 1 };
    j["versions"] = [{ id: "v1", kind: "item", entryId: "big", at: 1, note: "", item: big }];
    fs.writeFileSync(file(), JSON.stringify(j), "utf8");
    const before = raw();
    expect(status(() => lib.restoreVersion("item", "big", "v1"))).toBe(400);
    expect(raw()).toBe(before);
  });
});
