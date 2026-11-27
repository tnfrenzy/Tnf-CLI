import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoleEvalStore } from "../../src/core/roles/role-eval-store.js";
import { LibraryError } from "../../src/core/roles/role-library.js";
import { validateRoleEvalCases, type RoleEvalRunResult } from "../../src/core/roles/role-eval.js";

let root: string;
let dir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "role-eval-store-"));
  dir = path.join(root, "evals");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const mkCase = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  title: "Ca một",
  prompt: "Làm gì đó",
  checks: [{ type: "contains", value: "ok" }],
  ...over,
});

const mkResult = (roleId: string, n: number): RoleEvalRunResult => ({
  id: `r${n}`,
  roleId,
  version: "v1",
  at: new Date(n * 1000).toISOString(),
  repeats: 1,
  cases: [],
  score: n,
  passed: true,
  costUsd: 0,
  runIds: [],
});

function status400(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LibraryError);
    expect((e as LibraryError).status).toBe(400);
    return;
  }
  throw new Error("expected LibraryError");
}

describe("RoleEvalStore", () => {
  it("setCases then getCases, and persists across instances", () => {
    const s = new RoleEvalStore(dir);
    const out = s.setCases("dev", [mkCase()]);
    expect(out).toHaveLength(1);
    expect(s.getCases("dev")).toEqual(out);
    expect(new RoleEvalStore(dir).getCases("dev")).toEqual(out);
  });

  it("rejects invalid cases with 400 and first error, leaving old cases", () => {
    const s = new RoleEvalStore(dir);
    const old = s.setCases("dev", [mkCase()]);
    try {
      s.setCases("dev", []);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LibraryError);
      expect((e as LibraryError).status).toBe(400);
      expect((e as LibraryError).message).toBe(
        validateRoleEvalCases([]).errors[0]
      );
    }
    expect(s.getCases("dev")).toEqual(old);
  });

  it("keeps only the 50 newest results, newest first", () => {
    const s = new RoleEvalStore(dir);
    for (let i = 1; i <= 60; i++) s.appendResult(mkResult("dev", i));
    const list = s.listResults("dev", 100);
    expect(list).toHaveLength(50);
    expect(list[0].id).toBe("r60");
    expect(list[49].id).toBe("r11");
  });

  it("listResults default 20, explicit limit, NaN and negative", () => {
    const s = new RoleEvalStore(dir);
    for (let i = 1; i <= 30; i++) s.appendResult(mkResult("dev", i));
    expect(s.listResults("dev")).toHaveLength(20);
    expect(s.listResults("dev", 5)).toHaveLength(5);
    expect(s.listResults("dev", Number.NaN)).toHaveLength(20);
    expect(s.listResults("dev", -3)).toHaveLength(0);
  });

  it("rejects bad roleIds everywhere and creates nothing outside dir", () => {
    const s = new RoleEvalStore(dir);
    for (const id of ["a.b", "../x", "a/b", "", "a".repeat(41)]) {
      status400(() => s.getCases(id));
      status400(() => s.setCases(id, [mkCase()]));
      status400(() => s.appendResult(mkResult(id, 1)));
      status400(() => s.listResults(id));
      status400(() => s.remove(id));
    }
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("remove deletes the file and is silent when missing", () => {
    const s = new RoleEvalStore(dir);
    s.setCases("dev", [mkCase()]);
    const file = path.join(dir, "dev.json");
    expect(fs.existsSync(file)).toBe(true);
    s.remove("dev");
    expect(fs.existsSync(file)).toBe(false);
    expect(s.getCases("dev")).toEqual([]);
    expect(() => s.remove("never-existed")).not.toThrow();
  });

  it("reads a corrupt file as empty", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "dev.json"), "{oops", "utf8");
    const s = new RoleEvalStore(dir);
    expect(s.getCases("dev")).toEqual([]);
    expect(s.listResults("dev")).toEqual([]);
  });

  it("setCases keeps existing results; appendResult keeps cases", () => {
    const s = new RoleEvalStore(dir);
    s.appendResult(mkResult("dev", 1));
    s.setCases("dev", [mkCase()]);
    expect(s.listResults("dev")).toHaveLength(1);
    s.appendResult(mkResult("dev", 2));
    expect(s.getCases("dev")).toHaveLength(1);
    expect(s.listResults("dev")).toHaveLength(2);
  });
});
