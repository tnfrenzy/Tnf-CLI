import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTurntable, listModels3d, type Models3dEngine } from "../../src/core/codevideo/models3d.js";

let tmp = "";
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-models3d-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

interface Fake extends Models3dEngine {
  calls: string[];
}
function fakeEngine(files: Record<string, string[]>, opts: { render?: "ok" | "fail" | "none" } = {}): Fake {
  const sessionFiles = new Map(Object.entries(files));
  const dir = path.join(tmp, "sessions");
  const calls: string[] = [];
  const eng: Fake = {
    calls,
    listForApi: () => Object.keys(files).map((slug, i) => ({ slug, title: `Phiên ${slug}`, updatedAt: 1_700_000_000_000 + i * 1000 })),
    detail: (slug) => (sessionFiles.has(slug) ? { files: sessionFiles.get(slug)!, turntable: { running: true, phase: "render", done: 3, total: 10 } } : null),
    filePath: (slug, rel) => ({ abs: path.join(dir, slug, rel) }),
  };
  if (opts.render !== "none") {
    eng.turntable = async (slug, o) => {
      calls.push(`turntable:${slug}:${o?.background ?? "-"}`);
      if (opts.render === "fail") return { ok: false, error: "Không tìm thấy Blender." };
      const f = path.join(dir, slug, "outputs");
      fs.mkdirSync(f, { recursive: true });
      fs.writeFileSync(path.join(f, "turntable.mp4"), "rendered");
      sessionFiles.set(slug, [...(sessionFiles.get(slug) ?? []), "outputs/turntable.mp4"]);
      return { ok: true, file: "outputs/turntable.mp4" };
    };
  }
  return eng;
}

describe("listModels3d", () => {
  it("lists only sessions with a GLB, prefers the baked one, flags turntables, newest first", () => {
    const eng = fakeEngine({
      a: ["outputs/model.glb"],
      b: ["outputs/model.glb", "outputs/model-blender.glb", "outputs/turntable.mp4"],
      c: ["outputs/spec.json"],
    });
    const l = listModels3d(eng);
    expect(l.map((x) => x.session)).toEqual(["b", "a"]);
    expect(l[0]).toMatchObject({ glb: "outputs/model-blender.glb", hasTurntable: true, title: "Phiên b" });
    expect(l[1]).toMatchObject({ glb: "outputs/model.glb", hasTurntable: false });
    expect(Number.isNaN(Date.parse(l[0]!.updatedAt))).toBe(false);
  });

  it("never throws when the engine fails", () => {
    expect(listModels3d({ ...fakeEngine({}), listForApi: () => { throw new Error("x"); } })).toEqual([]);
  });
});

describe("ensureTurntable", () => {
  it("copies an existing turntable without rendering", async () => {
    const eng = fakeEngine({ s1: ["outputs/model.glb", "outputs/turntable.mp4"] });
    fs.mkdirSync(path.join(tmp, "sessions", "s1", "outputs"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "sessions", "s1", "outputs", "turntable.mp4"), "existing");
    const proj = path.join(tmp, "p1");
    const r = await ensureTurntable(eng, "s1", proj);
    expect(r).toEqual({ ok: true, file: "assets/cabin-turntable.mp4", rendered: false });
    expect(eng.calls).toEqual([]);
    expect(fs.readFileSync(path.join(proj, "assets", "cabin-turntable.mp4"), "utf8")).toBe("existing");
  });

  it("asks the 3D workshop to render when missing, then copies", async () => {
    const eng = fakeEngine({ s2: ["outputs/model.glb"] });
    const proj = path.join(tmp, "p2");
    const r = await ensureTurntable(eng, "s2", proj, { background: "#0b2a6f", onProgress: () => undefined });
    expect(r).toEqual({ ok: true, file: "assets/cabin-turntable.mp4", rendered: true });
    expect(eng.calls).toEqual(["turntable:s2:#0b2a6f"]);
    expect(fs.readFileSync(path.join(proj, "assets", "cabin-turntable.mp4"), "utf8")).toBe("rendered");
  });

  it("reports progress from the engine while waiting", async () => {
    const eng = fakeEngine({ s3: ["outputs/model.glb"] });
    const slow = eng.turntable!;
    eng.turntable = async (slug, o) => {
      await new Promise((r) => setTimeout(r, 1700));
      return slow(slug, o);
    };
    const seen: number[] = [];
    const r = await ensureTurntable(eng, "s3", path.join(tmp, "p3"), { onProgress: (p) => seen.push(p.done) });
    expect(r.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(3);
  });

  it("errors are Vietnamese results, not exceptions", async () => {
    expect(await ensureTurntable(fakeEngine({}), "zz", path.join(tmp, "p4"))).toMatchObject({ ok: false, error: "Không tìm thấy phiên dựng 3D." });
    expect(await ensureTurntable(fakeEngine({ s: ["outputs/spec.json"] }), "s", path.join(tmp, "p5"))).toMatchObject({ ok: false });
    expect(await ensureTurntable(fakeEngine({ s: ["outputs/model.glb"] }, { render: "fail" }), "s", path.join(tmp, "p6"))).toEqual({ ok: false, error: "Không tìm thấy Blender." });
    const none = await ensureTurntable(fakeEngine({ s: ["outputs/model.glb"] }, { render: "none" }), "s", path.join(tmp, "p7"));
    expect(none.ok).toBe(false);
  });

  it("an aborted signal is reported as cancelled", async () => {
    const ac = new AbortController();
    const eng = fakeEngine({ s: ["outputs/model.glb"] }, { render: "fail" });
    ac.abort();
    const r = await ensureTurntable(eng, "s", path.join(tmp, "p8"), { signal: ac.signal });
    expect(r).toMatchObject({ ok: false, cancelled: true });
  });
});
