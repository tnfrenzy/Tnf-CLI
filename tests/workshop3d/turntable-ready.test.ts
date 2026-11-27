import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHqDeps, makeWorkshop3DEngine } from "../../src/core/workshop3d/index.js";
import { createW3DStore } from "../../src/core/workshop3d/store.js";
import type { W3DRunner } from "../../src/core/workshop3d/runner.js";
import { W3D_BLENDER_DEFAULTS } from "../../src/core/app/config.js";

let tmp: string;
let store: ReturnType<typeof createW3DStore>;
let slug: string;

const runner = {} as unknown as W3DRunner;
const hqOf = (blender: string | null, enabled = true) =>
  createHqDeps({ config: { workshop3d: { blender: { ...W3D_BLENDER_DEFAULTS, enabled } }, tools: { cad: { python: null } } }, dataDir: tmp, store, blender });
const ok = async () => ({ ok: true as const, file: "outputs/turntable.mp4", frames: 1, seconds: 0, secondsPerFrame: null });

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-w3d-ready-"));
  store = createW3DStore(path.join(tmp, "data"));
  slug = store.create({ title: "ready", object: "box", params: {}, detail: "standard", attachments: [] });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("turntableReady flag of the session detail", () => {
  it("is true when the step is wired and Blender is found and enabled", () => {
    const hq = hqOf("blender.exe");
    const d = makeWorkshop3DEngine({ store, runner, turntable: hq.turntable, turntableReady: hq.turntableReady }).detail(slug)!;
    expect(d.turntableReady).toBe(true);
    expect(d.turntableWhy).toBeUndefined();
  });
  it("is false with a Vietnamese reason when Blender is not found", () => {
    const hq = hqOf(null);
    const d = makeWorkshop3DEngine({ store, runner, turntable: hq.turntable, turntableReady: hq.turntableReady }).detail(slug)!;
    expect(d.turntableReady).toBe(false);
    expect(d.turntableWhy).toContain("Chưa tìm thấy Blender");
  });
  it("is false when Blender is turned off in the settings", () => {
    const hq = hqOf("blender.exe", false);
    const d = makeWorkshop3DEngine({ store, runner, turntable: hq.turntable, turntableReady: hq.turntableReady }).detail(slug)!;
    expect(d.turntableReady).toBe(false);
    expect(d.turntableWhy).toContain("Blender đang tắt");
  });
  it("is false without a turntable step, and true for a step without a readiness probe", () => {
    expect(makeWorkshop3DEngine({ store, runner }).detail(slug)!.turntableReady).toBe(false);
    expect(makeWorkshop3DEngine({ store, runner, turntable: ok }).detail(slug)!.turntableReady).toBe(true);
  });
});
