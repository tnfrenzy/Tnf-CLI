import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DANGER_KEYWORDS } from "../../src/core/roles/agent-md.js";
import { previewRestore, restoreWithCheck, versionToImportText } from "../../src/core/roles/library-restore.js";
import { LibraryError, MAX_LIBRARY_ITEMS, MAX_LIBRARY_ROLES, RoleLibrary } from "../../src/core/roles/role-library.js";

let dir: string;
let lib: RoleLibrary;
const file = () => path.join(dir, "library", "library.json");
const raw = () => fs.readFileSync(file(), "utf8");
const mk = (prompt: string, id = "wording", extra: Record<string, unknown> = {}) => ({
  id,
  description: "Soát câu chữ",
  prompt,
  tools: ["Read"],
  ...extra,
});
const mi = (content: string, name = "Mau", type = "prompt") => ({ name, type, content });
const DANGER = DANGER_KEYWORDS[0];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-restore2-"));
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

describe("danger keyword guard", () => {
  it("blocks without confirm, restores with confirm", () => {
    lib.createRole(mk(`hãy ${DANGER} mọi thứ`));
    lib.updateRole("wording", { prompt: "sạch" });
    const h = lib.history("role", "wording");
    const vid = h[0]!.id;
    const { preview } = previewRestore(lib, "role", "wording", vid);
    expect(preview.dangerKeywords.length).toBeGreaterThan(0);
    const before = raw();
    expect(status(() => restoreWithCheck(lib, "role", "wording", vid, {}))).toBe(400);
    expect(raw()).toBe(before);
    const out = restoreWithCheck(lib, "role", "wording", vid, { confirm: true });
    expect(out.role?.prompt).toContain(DANGER);
    expect(lib.getRole("wording")?.prompt).toContain(DANGER);
  });
});

describe("frontmatter-looking and multiline", () => {
  it("prompt starting with --- is read as body", () => {
    const p = "---\nnội dung giả frontmatter\n---\nphần còn lại";
    lib.createRole(mk(p));
    lib.updateRole("wording", { prompt: "B" });
    const vid = lib.history("role", "wording")[0]!.id;
    const { preview } = previewRestore(lib, "role", "wording", vid);
    expect(preview.prompt).toBe(p.trim());
    expect(preview.description).toBe("Soát câu chữ");
    expect(preview.blocked).not.toBe("empty");
  });

  it("multiline description with quotes becomes one line", () => {
    lib.createRole(mk("A", "wording", { description: 'Dòng một\n  dòng "hai"\r\nba' }));
    lib.updateRole("wording", { prompt: "B" });
    const vid = lib.history("role", "wording")[0]!.id;
    const { preview } = previewRestore(lib, "role", "wording", vid);
    expect(preview.description).toBe("Dòng một dòng hai ba");
  });
});

describe("clean restore", () => {
  it("role restores without confirm", () => {
    lib.createRole(mk("A"));
    lib.updateRole("wording", { prompt: "B" });
    const vid = lib.history("role", "wording")[0]!.id;
    const out = restoreWithCheck(lib, "role", "wording", vid, {});
    expect(out.role?.prompt).toBe("A");
    expect(out.preview.dangerKeywords).toEqual([]);
  });

  it("item restores without confirm", () => {
    const it0 = lib.createItem(mi("A"));
    lib.updateItem(it0.id, { content: "B" });
    const vid = lib.history("item", it0.id)[0]!.id;
    const out = restoreWithCheck(lib, "item", it0.id, vid, { note: "ok" });
    expect(out.item?.content).toBe("A");
  });

  it("role restores in place when library is full", () => {
    lib.createRole(mk("A"));
    lib.updateRole("wording", { prompt: "B" });
    for (let n = 1; n < MAX_LIBRARY_ROLES; n++) lib.createRole(mk("P", `r${n}`));
    expect(lib.list().roles).toHaveLength(MAX_LIBRARY_ROLES);
    const vid = lib.history("role", "wording")[0]!.id;
    expect(restoreWithCheck(lib, "role", "wording", vid, {}).role?.prompt).toBe("A");
  });

  it("item restores in place when library is full", () => {
    const it0 = lib.createItem(mi("A"));
    lib.updateItem(it0.id, { content: "B" });
    for (let n = 1; n < MAX_LIBRARY_ITEMS; n++) lib.createItem(mi("P", `Muc ${n}`));
    expect(lib.list().items).toHaveLength(MAX_LIBRARY_ITEMS);
    const vid = lib.history("item", it0.id)[0]!.id;
    expect(restoreWithCheck(lib, "item", it0.id, vid, {}).item?.content).toBe("A");
  });
});

describe("errors", () => {
  it("404 for unknown version", () => {
    lib.createRole(mk("A"));
    expect(status(() => previewRestore(lib, "role", "wording", "nope"))).toBe(404);
    expect(status(() => restoreWithCheck(lib, "role", "wording", "nope", {}))).toBe(404);
  });

  it("400 for empty snapshot", () => {
    lib.createRole(mk("A"));
    const j = JSON.parse(raw()) as Record<string, unknown>;
    j["versions"] = [{ id: "v1", kind: "role", entryId: "wording", at: 1, note: "", role: mk("   ") }];
    fs.writeFileSync(file(), JSON.stringify(j), "utf8");
    const before = raw();
    expect(status(() => restoreWithCheck(lib, "role", "wording", "v1", {}))).toBe(400);
    expect(raw()).toBe(before);
  });
});

describe("versionToImportText", () => {
  it("skill/prompt have no tools line", () => {
    for (const type of ["skill", "prompt"]) {
      const it0 = lib.createItem(mi("A", `M ${type}`, type));
      lib.updateItem(it0.id, { content: "B" });
      const v = lib.history("item", it0.id)[0]!;
      const text = versionToImportText(v);
      expect(text).not.toMatch(/^tools:/m);
      expect(text.endsWith("\nA")).toBe(true);
    }
  });

  it("role with tools has tools line and verbatim body", () => {
    lib.createRole(mk("Thân\n\nvăn bản"));
    lib.updateRole("wording", { prompt: "B" });
    const text = versionToImportText(lib.history("role", "wording")[0]!);
    expect(text).toContain("tools: [Read]");
    expect(text.startsWith("---\nname: ")).toBe(true);
    expect(text.endsWith("---\nThân\n\nvăn bản")).toBe(true);
  });
});
