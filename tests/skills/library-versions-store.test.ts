import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryError, RoleLibrary } from "../../src/core/roles/role-library.js";

let dir: string;
let lib: RoleLibrary;
let clock: number;

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (clock += 10));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-libver-"));
  lib = new RoleLibrary(path.join(dir, "library"), () => ["analyst", "qa"]);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const role = { id: "wording", description: "Soát câu chữ", prompt: "p0", tools: ["Read", "Grep"] };
const item = { name: "Quy tắc", type: "prompt", content: "c0", roleIds: ["analyst"] };

const fails = (fn: () => unknown, status: number) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LibraryError);
    expect((e as LibraryError).status).toBe(status);
    return;
  }
  throw new Error("expected an error");
};

describe("role version history in the store", () => {
  it("caps at 10 versions, newest first", () => {
    lib.createRole(role);
    for (let n = 1; n <= 12; n++) lib.updateRole("wording", { prompt: `p${n}` });
    const h = lib.history("role", "wording");
    expect(h).toHaveLength(10);
    for (let k = 1; k < h.length; k++) expect(h[k - 1]!.at).toBeGreaterThan(h[k]!.at);
    expect(h[0]!.role!.prompt).toBe("p11");
  });

  it("keeps note on the version and out of the role", () => {
    lib.createRole(role);
    const r = lib.updateRole("wording", { prompt: "p1", note: "đổi lời nhắc" });
    expect("note" in r).toBe(false);
    expect(lib.history("role", "wording")[0]!.note).toBe("đổi lời nhắc");
    expect("note" in lib.list().roles[0]!).toBe(false);
  });

  it("no-op save creates no version, even with different key order", () => {
    lib.createRole(role);
    lib.updateRole("wording", { tools: ["Read", "Grep"], prompt: "p0", description: "Soát câu chữ" });
    lib.updateRole("wording", {});
    expect(lib.history("role", "wording")).toEqual([]);
  });

  it("role never edited returns [] not 404", () => {
    lib.createRole(role);
    expect(lib.history("role", "wording")).toEqual([]);
  });

  it("deleteRole keeps history", () => {
    lib.createRole(role);
    lib.updateRole("wording", { prompt: "p1" });
    lib.deleteRole("wording");
    const h = lib.history("role", "wording");
    expect(h).toHaveLength(1);
    expect(h[0]!.role!.prompt).toBe("p0");
  });
});

describe("item version history in the store", () => {
  it("snapshots old item, two edits give two versions newest first", () => {
    const it0 = lib.createItem(item);
    lib.updateItem(it0.id, { content: "c1" });
    lib.updateItem(it0.id, { content: "c2", note: "lần hai" });
    const h = lib.history("item", it0.id);
    expect(h).toHaveLength(2);
    expect(h[0]!.item!.content).toBe("c1");
    expect(h[0]!.note).toBe("lần hai");
    expect(h[1]!.item!.content).toBe("c0");
    expect(h[1]!.item!.roleIds).toEqual(["analyst"]);
    expect("note" in lib.list().items[0]!).toBe(false);
  });

  it("no-op item save creates no version", () => {
    const it0 = lib.createItem(item);
    lib.updateItem(it0.id, { roleIds: ["analyst"], content: "c0" });
    expect(lib.history("item", it0.id)).toEqual([]);
  });

  it("deleteItem keeps history", () => {
    const it0 = lib.createItem(item);
    lib.updateItem(it0.id, { content: "c1" });
    lib.deleteItem(it0.id);
    expect(lib.history("item", it0.id)).toHaveLength(1);
  });
});

describe("history errors and storage", () => {
  it("404 for unknown entries", () => {
    fails(() => lib.history("role", "khong-co"), 404);
    fails(() => lib.history("item", "khong-co"), 404);
  });

  it("list() hides versions but library.json keeps them", () => {
    lib.createRole(role);
    lib.updateRole("wording", { prompt: "p1" });
    expect("versions" in lib.list()).toBe(false);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "library", "library.json"), "utf8")) as { versions?: unknown[] };
    expect(raw.versions).toHaveLength(1);
  });
});
