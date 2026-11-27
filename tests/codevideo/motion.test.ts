import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const root = resolve(__dirname, "..", "..");
const libPath = join(root, "config", "codevideo", "lib", "tnf-motion.js");
const templateDir = join(root, "config", "codevideo", "template");

type Fn = (...a: number[]) => number;
interface TnfPure {
  ease: Record<string, Fn>;
  tween: (t: number, from: number | number[], to: number | number[], t0: number, t1: number, e?: string) => number | number[];
  rng: (seed: number) => (() => number) & { range: Fn; int: Fn };
  hash: Fn;
  typewriter: (text: string, t: number, t0: number, cps: number, o?: { cursor?: string }) => string;
  counter: (from: number, to: number, t: number, t0: number, t1: number, o?: Record<string, unknown>) => string;
  pulse: Fn;
  clamp: Fn;
  scene: (d: Record<string, unknown>) => { id: string; start: number; end: number };
  sceneState: (s: unknown, t: number) => { active: boolean; p: number; time: number; enter: number; exit: number };
  color: { mix: (a: string, b: string, k: number) => string; rgba: (h: string, a: number) => string };
  iso: {
    project: (x: number, y: number, z: number, o: { ox: number; oy: number; s: number }) => number[];
    connector: (pts: number[][], o: Record<string, unknown>) => string;
    sortBack: (items: Array<{ x: number; y: number; w?: number; d?: number; z?: number; id?: string }>) => Array<{ id?: string }>;
  };
}

function loadPure(): TnfPure {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(libPath, "utf8"), ctx, { filename: "tnf-motion.js" });
  return (ctx as unknown as { TNF: TnfPure }).TNF;
}

describe("tnf-motion pure functions (node:vm)", () => {
  const T = loadPure();

  it("easings hit exact boundaries", () => {
    for (const name of Object.keys(T.ease)) {
      expect(T.ease[name](0), name).toBe(0);
      expect(T.ease[name](1), name).toBe(1);
    }
    expect(T.ease.linear(0.25)).toBe(0.25);
    expect(T.ease.outBack(0.8)).toBeGreaterThan(1); // overshoot
    expect(T.ease.easeInOut(0.5)).toBeCloseTo(0.5, 10);
  });

  it("tween clamps outside [t0,t1] and interpolates", () => {
    expect(T.tween(0, 10, 20, 1, 2)).toBe(10);
    expect(T.tween(1, 10, 20, 1, 2)).toBe(10);
    expect(T.tween(1.5, 10, 20, 1, 2)).toBe(15);
    expect(T.tween(2, 10, 20, 1, 2)).toBe(20);
    expect(T.tween(9, 10, 20, 1, 2)).toBe(20);
    expect(T.tween(1.5, [0, 100], [10, 200], 1, 2)).toEqual([5, 150].map((x) => x));
    expect(T.tween(5, 1, 2, 3, 3)).toBe(2); // zero-length range
    expect(T.tween(1.5, 0, 1, 1, 2, "outCubic")).toBeCloseTo(0.875, 10);
  });

  it("seeded PRNG is stable and seed-dependent", () => {
    const a = T.rng(42), b = T.rng(42), c = T.rng(43);
    const sa = Array.from({ length: 5 }, () => a()), sb = Array.from({ length: 5 }, () => b()), sc = Array.from({ length: 5 }, () => c());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(T.rng(1)()).toBeCloseTo(0.6270739405881613, 12); // golden value: guards against accidental algorithm change
    expect(T.hash(5, 9)).toBe(T.hash(5, 9));
    expect(T.hash(5, 9)).not.toBe(T.hash(6, 9));
    const r = T.rng(3);
    for (let i = 0; i < 100; i++) { const v = r.int(2, 4); expect(v >= 2 && v <= 4).toBe(true); }
  });

  it("typewriter keeps Vietnamese diacritics intact and counter formats numbers", () => {
    expect(T.typewriter("Thang máy", 0, 0, 10)).toBe("");
    expect(T.typewriter("Thang máy", 0.5, 0, 10)).toBe("Thang");
    expect(T.typewriter("Việt", 100, 0, 10)).toBe("Việt");
    expect(T.typewriter("Việt", 0.2, 0, 10)).toBe("Vi");
    expect(T.counter(0, 1250, 0, 0, 1)).toBe("0");
    expect(T.counter(0, 1250, 5, 0, 1, { suffix: "+" })).toBe("1.250+");
    expect(T.counter(0, 2.5, 5, 0, 1, { decimals: 1 })).toBe("2,5");
  });

  it("scene timeline state is pure and bounded", () => {
    const s = T.scene({ id: "a", start: 2, end: 4, enter: { type: "fade", dur: 0.5 }, exit: { type: "fade", dur: 1 } });
    expect(T.sceneState(s, 1.99).active).toBe(false);
    expect(T.sceneState(s, 4).active).toBe(false);
    const mid = T.sceneState(s, 2.25);
    expect(mid.active).toBe(true);
    expect(mid.enter).toBeCloseTo(0.5, 10);
    expect(mid.exit).toBe(0);
    expect(T.sceneState(s, 3.5).exit).toBeCloseTo(0.5, 10);
    expect(T.sceneState(s, 3).p).toBe(0.5);
    expect(() => T.scene({ id: "x", start: 3, end: 3 })).toThrow();
  });

  it("pulse, color and iso helpers are deterministic", () => {
    expect(T.pulse(0, 1, 0)).toBeCloseTo(0.5, 10);
    expect(T.pulse(0.25, 1, 0)).toBeCloseTo(1, 10);
    expect(T.color.mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(T.color.rgba("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)");
    const p = T.iso.project(10, 0, 0, { ox: 100, oy: 100, s: 2 });
    expect(p[0]).toBeCloseTo(100 + 10 * 0.8660254 * 2, 6);
    expect(p[1]).toBeCloseTo(110, 6);
    const view = { ox: 0, oy: 0, s: 1 };
    const a = T.iso.connector([[0, 0, 0], [100, 0, 0]], { view, t: 1 });
    expect(a).toBe(T.iso.connector([[0, 0, 0], [100, 0, 0]], { view, t: 1 }));
    expect(a).not.toBe(T.iso.connector([[0, 0, 0], [100, 0, 0]], { view, t: 2 }));
    expect(T.iso.connector([[0, 0, 0], [100, 0, 0]], { view, progress: 0 })).toBe("");
  });

  it("iso.sortBack orders far to near and keeps ties stable", () => {
    const items = [
      { id: "near", x: 140, y: 140, w: 120, d: 120 },
      { id: "centre", x: -60, y: -60, w: 120, d: 120 },
      { id: "farL", x: -260, y: -260, w: 120, d: 120 },
      { id: "tieA", x: 0, y: 300, w: 10, d: 10 },
      { id: "tieB", x: 300, y: 0, w: 10, d: 10 },
    ];
    expect(T.iso.sortBack(items).map((o) => o.id)).toEqual(["farL", "centre", "tieA", "tieB", "near"]);
    expect(items[0]!.id).toBe("near");
  });

  it("library source obeys the determinism rules", () => {
    const src = readFileSync(libPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const bad of ["requestAnimationFrame", "Date.now", "Math.random", "performance.now", "setInterval", "fetch(", "XMLHttpRequest", "new Date"]) {
      expect(src.includes(bad), bad).toBe(false);
    }
  });
});

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const hasEdge = process.platform === "win32" && existsSync(EDGE);

describe.skipIf(!hasEdge)("template in Edge headless", () => {
  let work = "";
  const page = () => pathToFileURL(join(work, "index.html")).href;

  function edge(args: string[]): string {
    const r = spawnSync(
      EDGE,
      ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1080,1920",
        "--no-first-run", "--disable-extensions", `--user-data-dir=${join(work, "profile")}`, ...args],
      { encoding: "utf8", timeout: 90_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    return (r.stdout ?? "") + (r.stderr ?? "");
  }
  function shot(t: number, name: string): Buffer {
    const out = join(work, name);
    edge([`--screenshot=${out}`, "--virtual-time-budget=6000", `${page()}?t=${t}`]);
    return readFileSync(out);
  }

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "tnf-motion-"));
    cpSync(templateDir, work, { recursive: true });
    mkdirSync(join(work, "lib"), { recursive: true });
    writeFileSync(join(work, "lib", "tnf-motion.js"), readFileSync(libPath));
  });
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  it("__seek gives identical DOM+canvas for the same t, even after out-of-order seeks", () => {
    const dom = edge(["--dump-dom", "--virtual-time-budget=8000", `${page()}?selftest=1.5,4.2,1.5,10.1,4.2,1.5`]);
    const m = /<pre id="tnf-selftest">([\s\S]*?)<\/pre>/.exec(dom);
    expect(m, dom.slice(0, 400)).not.toBeNull();
    const rows = JSON.parse((m as RegExpExecArray)[1].replace(/&quot;/g, '"')) as { t: number; snap: string }[];
    expect(rows).toHaveLength(6);
    const by = new Map<number, Set<string>>();
    for (const r of rows) by.set(r.t, (by.get(r.t) ?? new Set()).add(r.snap));
    for (const s of by.values()) expect(s.size).toBe(1);
    const distinct = new Set(rows.map((r) => r.snap));
    expect(distinct.size).toBe(3);
  });

  it("screenshots: same t is byte-identical, different t differs", () => {
    const a1 = shot(1.5, "a1.png"), a2 = shot(1.5, "a2.png"), b = shot(7.2, "b.png");
    expect(a1.length).toBeGreaterThan(5000);
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
  });
});
