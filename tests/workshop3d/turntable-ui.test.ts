import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setCurLang } from "../../ui/src/lib/lang";
import { dicts } from "../../ui/src/i18n";
import {
  DEFAULT_TURNTABLE_FORM, clampDuration, turntableBlockReason, turntableBody, turntableCanStart, turntableFile, turntableRunning, turntableStatus,
} from "../../ui/src/components/workshop3d/turntable-logic";

const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");

describe("turntable UI logic", () => {
  it("clamps the duration to 4..12 whole seconds", () => {
    expect(clampDuration(1)).toBe(4);
    expect(clampDuration(99)).toBe(12);
    expect(clampDuration("7.4")).toBe(7);
    expect(clampDuration("abc")).toBe(8);
  });
  it("builds the request body: brand colour omits background, transparent sends null", () => {
    expect(turntableBody(DEFAULT_TURNTABLE_FORM)).toEqual({ width: 540, height: 540, durationSec: 8 });
    expect(turntableBody({ transparent: true, size: 1080, durationSec: 20 })).toEqual({ width: 1080, height: 1080, durationSec: 12, background: null });
  });
  it("derives the progress bar state", () => {
    const base = { phase: "render" as const, total: 0, done: 0 };
    expect(turntableStatus(null)).toEqual({ kind: "idle" });
    expect(turntableStatus({ ...base, running: false })).toEqual({ kind: "idle" });
    expect(turntableStatus({ ...base, running: true })).toEqual({ kind: "preparing" });
    expect(turntableStatus({ ...base, running: true, total: 40, done: 20 })).toEqual({ kind: "render", done: 20, total: 40, percent: 48 });
    expect(turntableStatus({ ...base, running: true, total: 40, done: 90 })).toMatchObject({ done: 40, percent: 95 });
    expect(turntableStatus({ ...base, running: true, phase: "encode", total: 40, done: 40 })).toMatchObject({ kind: "encode" });
    expect(turntableRunning({ ...base, running: true })).toBe(true);
    expect(turntableRunning(undefined)).toBe(false);
  });
  it("finds the finished video (mp4 first)", () => {
    expect(turntableFile(["outputs/model.glb"])).toBeNull();
    expect(turntableFile(["outputs/turntable.webm"])).toBe("outputs/turntable.webm");
    expect(turntableFile(["outputs/turntable.webm", "outputs/turntable.mp4"])).toBe("outputs/turntable.mp4");
    expect(turntableFile(undefined)).toBeNull();
  });
  it("enables the button only with a GLB and nothing running", () => {
    expect(turntableCanStart(["outputs/model.glb"], false, false)).toBe(true);
    expect(turntableCanStart(["outputs/model-blender.glb"], false, false)).toBe(true);
    expect(turntableCanStart(["outputs/model.stl"], false, false)).toBe(false);
    expect(turntableCanStart(["outputs/model.glb"], true, false)).toBe(false);
    expect(turntableCanStart(["outputs/model.glb"], false, true)).toBe(false);
    expect(turntableCanStart(undefined, false, false)).toBe(false);
  });
  it("turntableReady=false disables the button, undefined (older server) keeps the old behaviour", () => {
    expect(turntableCanStart(["outputs/model.glb"], false, false, false)).toBe(false);
    expect(turntableCanStart(["outputs/model.glb"], false, false, true)).toBe(true);
    expect(turntableCanStart(["outputs/model.glb"], false, false, undefined)).toBe(true);
  });
  it("explains why: server text in Vietnamese, generic sentence in English, nothing when ready or unknown", () => {
    const g = "generic sentence";
    expect(turntableBlockReason(true, undefined, g)).toBeNull();
    expect(turntableBlockReason(undefined, "x", g)).toBeNull();
    setCurLang("vi");
    expect(turntableBlockReason(false, "Chưa tìm thấy Blender.", g)).toBe("Chưa tìm thấy Blender.");
    expect(turntableBlockReason(false, undefined, g)).toBe(g);
    setCurLang("en");
    const en = turntableBlockReason(false, "Chưa tìm thấy Blender.", g);
    setCurLang("vi");
    expect(en).toBe(g);
    expect(dicts.en["w3t_blocked"]).toMatch(/^The turntable video/);
  });
});

describe("turntable UI wiring", () => {
  it("api client posts/deletes /turntable with the token header via req", () => {
    const api = read("ui/src/api.ts");
    expect(api).toMatch(/workshop3dTurntable: .*\/turntable`, \{ method: "POST"/);
    expect(api).toMatch(/workshop3dTurntableCancel: .*\/turntable`, \{ method: "DELETE"/);
  });
  it("all w3t_ strings exist in both languages and English has no Vietnamese", () => {
    const keys = (l: "vi" | "en") => Object.keys(dicts[l]).filter((k) => k.startsWith("w3t_")).sort();
    expect(keys("en")).toEqual(keys("vi"));
    expect(keys("en").length).toBeGreaterThan(10);
    expect(Object.entries(dicts.en).filter(([k, v]) => k.startsWith("w3t_") && /[àáảãạăâèéêìíòóôơùúưỳýđ]/i.test(v))).toEqual([]);
  });
  it("the panel is mounted in the renders tab", () => {
    expect(read("ui/src/components/workshop3d/Workshop3DRenders.tsx")).toMatch(/<TurntablePanel /);
  });
});
