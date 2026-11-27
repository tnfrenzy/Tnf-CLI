import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  RoleLibrary,
  MAX_ITEM_BYTES,
  appendVersion,
  findVersion,
  listVersions,
  makeVersion,
  normalizeVersions,
  versionBytes,
  type LibraryItem,
  type LibraryRole,
  type LibraryVersion,
} from "../../src/core/roles/role-library.js";

const item = (id: string, content = "x"): LibraryItem => ({ id, name: id, type: "skill", content, roleIds: [], createdAt: 1 });
const role = (id: string, prompt = "p"): LibraryRole => ({ id, description: "d", prompt } as LibraryRole);
const ver = (entryId: string, at: number, kind: "item" | "role" = "item"): LibraryVersion =>
  kind === "item"
    ? { id: `${entryId}-${at}`, kind, entryId, at, note: "", item: item(entryId) }
    : { id: `${entryId}-${at}`, kind, entryId, at, note: "", role: role(entryId) };

describe("library versions", () => {
  it("appendVersion keeps at most 10 per entry and does not mutate input", () => {
    let list: LibraryVersion[] = [ver("other", 0)];
    for (let i = 1; i <= 12; i++) list = appendVersion(list, ver("a", i));
    const a = list.filter((v) => v.entryId === "a");
    expect(a.length).toBe(10);
    expect(Math.min(...a.map((v) => v.at))).toBe(3);
    expect(list.some((v) => v.entryId === "other")).toBe(true);
    const input = [ver("a", 1)];
    const copy = [...input];
    appendVersion(input, ver("a", 2));
    expect(input).toEqual(copy);
  });

  it("drops globally oldest under a small byte cap but keeps v", () => {
    const list = [ver("a", 1), ver("b", 2)];
    const v = ver("c", 3);
    const out = appendVersion(list, v, { maxTotalBytes: versionBytes(v) + 10 });
    expect(out).toEqual([v]);
    expect(appendVersion([], v, { maxTotalBytes: 1 })).toEqual([v]);
  });

  it("makeVersion truncates item content on UTF-8 boundary", () => {
    const big = "đ".repeat(MAX_ITEM_BYTES);
    const v = makeVersion("item", item("a", big), "n", 5, []);
    expect(v.truncated).toBe(true);
    expect(v.item!.content).not.toContain("�");
    expect(Buffer.byteLength(v.item!.content, "utf8")).toBeLessThanOrEqual(MAX_ITEM_BYTES);
    const e = makeVersion("item", item("a", "😀".repeat(MAX_ITEM_BYTES)), "n", 5, []);
    expect(e.item!.content).not.toContain("�");
    expect(Buffer.byteLength(e.item!.content, "utf8")).toBeLessThanOrEqual(MAX_ITEM_BYTES);
    const r = makeVersion("role", role("r", "😀".repeat(MAX_ITEM_BYTES)), "n", 5, []);
    expect(r.truncated).toBe(true);
    expect(r.role!.prompt).not.toContain("�");
    expect(r.item).toBeUndefined();
  });

  it("makeVersion cleans note, deep copies, unique id", () => {
    const it0 = item("a", "hello");
    const v = makeVersion("item", it0, `  a \n\t b ${"z".repeat(300)}`, 1, []);
    expect(v.note.startsWith("a b z")).toBe(true);
    expect(v.note.length).toBe(200);
    expect(v.truncated).toBeUndefined();
    it0.content = "changed";
    it0.roleIds.push("q");
    expect(v.item!.content).toBe("hello");
    expect(v.item!.roleIds).toEqual([]);
    const ids = new Set<string>();
    const all: LibraryVersion[] = [];
    for (let i = 0; i < 20; i++) {
      const n = makeVersion("item", it0, "", i, all);
      expect(ids.has(n.id)).toBe(false);
      ids.add(n.id);
      all.push(n);
    }
  });

  it("normalizeVersions tolerates bad data and cleans notes", () => {
    expect(normalizeVersions(undefined)).toEqual([]);
    expect(normalizeVersions("x")).toEqual([]);
    expect(normalizeVersions({})).toEqual([]);
    const good = { ...ver("a", 1), note: "  a   b " };
    const out = normalizeVersions([good, null, 3, { ...ver("a", 2), kind: "weird" }, { ...ver("a", 3), at: "x" }, { ...ver("a", 4), item: undefined }, good]);
    expect(out.length).toBe(1);
    expect(out[0]!.note).toBe("a b");
    const many = Array.from({ length: 15 }, (_, i) => ver("a", i));
    expect(normalizeVersions(many).length).toBe(10);
  });

  it("listVersions newest first; findVersion exact", () => {
    const list = [ver("a", 1), ver("a", 3), ver("a", 2), ver("b", 9), ver("a", 5, "role")];
    expect(listVersions(list, "item", "a").map((v) => v.at)).toEqual([3, 2, 1]);
    expect(findVersion(list, "item", "a", "a-2")?.at).toBe(2);
    expect(findVersion(list, "role", "a", "a-2")).toBeUndefined();
    expect(findVersion(list, "item", "a", "nope")).toBeUndefined();
  });
});

describe("RoleLibrary persistence of versions", () => {
  const setup = (data: unknown): { lib: RoleLibrary; file: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-libver-"));
    const file = path.join(dir, "library.json");
    fs.writeFileSync(file, JSON.stringify(data), "utf8");
    return { lib: new RoleLibrary(dir, () => ["analyst"]), file };
  };
  const base = { roles: [{ id: "r1", description: "d", prompt: "p" }], items: [item("i1")], seeded: ["s1"] };

  it("old file without versions reads roles/items/seeded and writes no versions key", () => {
    const { lib, file } = setup(base);
    const l = lib.list();
    expect(l.roles).toHaveLength(1);
    expect(l.items).toHaveLength(1);
    expect(l.seeded).toEqual(["s1"]);
    expect("versions" in l).toBe(false);
    lib.createItem({ name: "n2", type: "prompt", content: "c" });
    expect("versions" in JSON.parse(fs.readFileSync(file, "utf8"))).toBe(false);
  });

  it("list() hides versions but writes keep them on disk", () => {
    const { lib, file } = setup({ ...base, versions: [ver("i1", 5)] });
    expect("versions" in lib.list()).toBe(false);
    lib.createItem({ name: "n2", type: "prompt", content: "c" });
    lib.createRole({ id: "r2", description: "d", prompt: "p" });
    lib.deleteItem("i1");
    lib.deleteRole("r2");
    lib.seedTemplates([{ id: "t9", name: "T", content: "c" }]);
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(disk.versions).toHaveLength(1);
    expect(disk.versions[0].id).toBe("i1-5");
  });

  it("garbage versions do not break reading", () => {
    for (const bad of ["x", 5, { a: 1 }, [null, 3, { kind: "item" }]]) {
      const { lib, file } = setup({ ...base, versions: bad });
      const l = lib.list();
      expect(l.roles).toHaveLength(1);
      expect(l.items).toHaveLength(1);
      expect("versions" in l).toBe(false);
      lib.createItem({ name: "n2", type: "prompt", content: "c" });
      expect("versions" in JSON.parse(fs.readFileSync(file, "utf8"))).toBe(false);
    }
  });
});
