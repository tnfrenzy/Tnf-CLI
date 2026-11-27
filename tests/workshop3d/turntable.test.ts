import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBlender, type BlenderRun } from "../../src/core/workshop3d/blender.js";
import { createW3DStore } from "../../src/core/workshop3d/store.js";
import {
  buildTurntableFfmpegArgs, buildTurntableJob, cleanTurntableError, normalizeTurntable, readTurntableProgress, renderTurntable, turntableGlb,
  type FfmpegRun,
} from "../../src/core/workshop3d/turntable.js";
import { findFfmpeg } from "../../src/core/codevideo/render/index.js";
import { turntableOptionsFromBody } from "../../src/server/routes/workshop3d.js";

const SLUG = "20261125-000000-abcdef";
const TINY = path.resolve(__dirname, "..", "fixtures", "workshop3d", "tiny-cabin.glb");
let dataDir = "";

function session(withGlb: boolean, baked = false): { dir: string; store: ReturnType<typeof createW3DStore> } {
  const store = createW3DStore(dataDir);
  const dir = store.dir(SLUG);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "outputs"), { recursive: true });
  if (withGlb) fs.copyFileSync(TINY, path.join(dir, "outputs", baked ? "model-blender.glb" : "model.glb"));
  return { dir, store };
}

/** Fake Blender: writes the frames the job asks for and prints the result line. */
const fakeBlender = (calls: Array<Record<string, unknown>>, failEevee = false): BlenderRun => async (_exe, args) => {
  const job = JSON.parse(fs.readFileSync(args[args.length - 1]!, "utf8")) as Record<string, unknown> & { out_dir: string; frames: number; engine: string };
  calls.push(job);
  if (failEevee && job.engine === "eevee") return { code: 1, stdout: "", stderr: "crash", timedOut: false, aborted: false };
  for (let i = 1; i <= job.frames; i++) fs.writeFileSync(path.join(job.out_dir, `frame_${String(i).padStart(4, "0")}.png`), "x");
  return { code: 0, stdout: `W3D_RESULT ${JSON.stringify({ ok: true, frames: job.frames, secondsPerFrame: 1.5 })}\n`, stderr: "", timedOut: false, aborted: false };
};
const fakeFf = (argsSeen: string[][]): FfmpegRun => async (_exe, args) => {
  argsSeen.push(args);
  fs.writeFileSync(args[args.length - 1]!, "video");
  return { code: 0, stderr: "", aborted: false };
};

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-turntable-"));
});
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("turntable (pure)", () => {
  it("normalizes options: even sizes, clamped ranges, default brand blue, bad colour = transparent", () => {
    const d = normalizeTurntable();
    expect(d).toMatchObject({ width: 1080, height: 1080, fps: 24, renderFps: 12, frames: 96, engine: "cycles", pedestal: true, background: "#0b2a6f" });
    const s = normalizeTurntable({ width: 541, height: 99999, durationSec: 100, fps: 500, background: "#ABCDEF", engine: "eevee", pedestal: false });
    expect(s.width % 2).toBe(0);
    expect(s).toMatchObject({ height: 3840, fps: 60, durationSec: 20, background: "#abcdef", engine: "eevee", pedestal: false });
    expect(normalizeTurntable({ background: null }).background).toBeNull();
    expect(normalizeTurntable({ background: "red" }).background).toBeNull();
  });

  it("builds the job.json for the Blender script", () => {
    const s = normalizeTurntable({ width: 540, height: 540, durationSec: 1.5, fps: 12, samples: 8, background: null });
    expect(buildTurntableJob(s, "a.glb", "out")).toEqual({
      glb: "a.glb", out_dir: "out", width: 540, height: 540, frames: 18, fps: 12, samples: 8, engine: "cycles",
      background: { color: null }, pedestal: true, orbit: { elevation_deg: 12, turns: 1 }, libraryDir: null, polyhavenDir: null,
    });
  });

  it("ffmpeg: colour background = H.264 yuv420p over the colour; transparent = VP9 with alpha", () => {
    const solid = buildTurntableFfmpegArgs(normalizeTurntable({ background: "#0b2a6f", fps: 24 }), "w", "o.mp4").join(" ");
    expect(solid).toContain("color=c=0x0b2a6f");
    expect(solid).toContain("overlay");
    expect(solid).toContain("libx264");
    expect(solid).toContain("yuv420p");
    expect(solid).toContain("-start_number 1");
    expect(solid).toContain("framerate=fps=24");
    expect(buildTurntableFfmpegArgs(normalizeTurntable({ fps: 12 }), "w", "o.mp4").join(" ")).not.toContain("framerate=fps");
    expect(solid).toMatch(/frame_%04d\.png/);
    const alpha = buildTurntableFfmpegArgs(normalizeTurntable({ background: null }), "w", "o.webm").join(" ");
    expect(alpha).toContain("libvpx-vp9");
    expect(alpha).toContain("yuva420p");
  });

  it("prefers the Blender-baked GLB", () => {
    const { dir } = session(true);
    expect(turntableGlb(dir)).toEqual({ abs: path.join(dir, "outputs", "model.glb"), baked: false });
    fs.copyFileSync(TINY, path.join(dir, "outputs", "model-blender.glb"));
    expect(turntableGlb(dir)).toEqual({ abs: path.join(dir, "outputs", "model-blender.glb"), baked: true });
  });

  it("hides local paths in error text", () => {
    expect(cleanTurntableError(`failed at ${os.tmpdir()}\\x\\y`, [])).not.toContain(os.tmpdir());
  });

  it("validates the request body of the route", () => {
    expect(turntableOptionsFromBody({ width: 540, background: null, engine: "cycles", pedestal: false })).toEqual({ width: 540, background: null, engine: "cycles", pedestal: false });
    expect(() => turntableOptionsFromBody({ width: "x" })).toThrow();
    expect(() => turntableOptionsFromBody({ background: "red" })).toThrow();
    expect(() => turntableOptionsFromBody({ engine: "x" })).toThrow();
  });
});

describe("renderTurntable (fakes)", () => {
  it("refuses without Blender, without a model, with a bad session", async () => {
    const { store } = session(true);
    const r1 = await renderTurntable(store, SLUG, {}, { blender: null, ffmpeg: "ff" });
    expect(r1).toMatchObject({ ok: false });
    expect(r1.ok === false && r1.error).toContain("Blender");
    session(false);
    const r2 = await renderTurntable(store, SLUG, {}, { blender: "b", ffmpeg: "ff" });
    expect(r2.ok === false && r2.error).toContain("model.glb");
    const r3 = await renderTurntable(store, "../x", {}, { blender: "b", ffmpeg: "ff" });
    expect(r3).toMatchObject({ ok: false });
    const r4 = await renderTurntable(store, SLUG, {}, { blender: "b", ffmpeg: null });
    expect(r4.ok === false && r4.error).toContain("ffmpeg");
  });

  it("renders frames, encodes, cleans the work folder and writes progress", async () => {
    const { dir, store } = session(true);
    const calls: Array<Record<string, unknown>> = [];
    const ffs: string[][] = [];
    const seen: string[] = [];
    const r = await renderTurntable(store, SLUG, { durationSec: 1, fps: 10, width: 64, height: 64, onProgress: (p) => seen.push(p.phase) }, { blender: "b", ffmpeg: "ff", run: fakeBlender(calls), ffRun: fakeFf(ffs) });
    expect(r).toMatchObject({ ok: true, file: "outputs/turntable.mp4", frames: 10, secondsPerFrame: 1.5 });
    expect(fs.existsSync(path.join(dir, "outputs", "turntable.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "renders", "turntable", "work"))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(ffs).toHaveLength(1);
    expect(readTurntableProgress(dir)).toMatchObject({ running: false, phase: "done", file: "outputs/turntable.mp4" });
    expect(seen).toContain("encode");
    expect(seen[seen.length - 1]).toBe("done");
  });

  it("transparent background writes outputs/turntable.webm and removes an old mp4", async () => {
    const { dir, store } = session(true);
    fs.writeFileSync(path.join(dir, "outputs", "turntable.mp4"), "old");
    const r = await renderTurntable(store, SLUG, { durationSec: 1, fps: 10, background: null }, { blender: "b", ffmpeg: "ff", run: fakeBlender([]), ffRun: fakeFf([]) });
    expect(r).toMatchObject({ ok: true, file: "outputs/turntable.webm" });
    expect(fs.existsSync(path.join(dir, "outputs", "turntable.mp4"))).toBe(false);
  });

  it("falls back to Cycles when EEVEE fails", async () => {
    const { store } = session(true);
    const calls: Array<Record<string, unknown>> = [];
    const r = await renderTurntable(store, SLUG, { durationSec: 1, fps: 10, engine: "eevee" }, { blender: "b", ffmpeg: "ff", run: fakeBlender(calls, true), ffRun: fakeFf([]) });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c["engine"])).toEqual(["eevee", "cycles"]);
  });

  it("Blender failure: Vietnamese error without the session path, work folder removed", async () => {
    const { dir, store } = session(true);
    const run: BlenderRun = async () => ({ code: 1, stdout: `W3D_RESULT ${JSON.stringify({ ok: false, error: `lỗi tại ${dir}\\x` })}`, stderr: "", timedOut: false, aborted: false });
    const r = await renderTurntable(store, SLUG, { durationSec: 1, fps: 10 }, { blender: "b", ffmpeg: "ff", run, ffRun: fakeFf([]) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Blender không render được");
      expect(r.error).not.toContain(dir);
    }
    expect(fs.existsSync(path.join(dir, "renders", "turntable", "work"))).toBe(false);
    expect(readTurntableProgress(dir)).toMatchObject({ running: false, phase: "failed" });
  });

  it("cancel (abort) is reported as cancelled", async () => {
    const { store } = session(true);
    const ac = new AbortController();
    const run: BlenderRun = async () => {
      ac.abort();
      return { code: null, stdout: "", stderr: "", timedOut: false, aborted: true };
    };
    const r = await renderTurntable(store, SLUG, { durationSec: 1, fps: 10, signal: ac.signal }, { blender: "b", ffmpeg: "ff", run, ffRun: fakeFf([]) });
    expect(r).toMatchObject({ ok: false, cancelled: true });
  });
});

const blender = findBlender();
const ffmpeg = findFfmpeg();
const ffprobe = ffmpeg ? path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe") : null;
const canRun = !!blender && !!ffmpeg && !!ffprobe && fs.existsSync(ffprobe) && fs.existsSync(TINY);

describe.skipIf(!canRun)("renderTurntable (real Blender + ffmpeg)", () => {
  it(
    "renders 1.5 s at 540x540, 12 fps, low samples, with the right number of frames",
    async () => {
      const { dir, store } = session(true);
      const t0 = Date.now();
      const r = await renderTurntable(store, SLUG, { width: 540, height: 540, durationSec: 1.5, fps: 12, samples: 4, background: "#0b2a6f" }, { blender: blender as string, ffmpeg: ffmpeg as string });
      const sec = (Date.now() - t0) / 1000;
      expect(r).toMatchObject({ ok: true, frames: 18 });
      const out = path.join(dir, "outputs", "turntable.mp4");
      const p = spawnSync(ffprobe as string, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,pix_fmt,codec_name", "-of", "json", out], { encoding: "utf8", shell: false });
      const s = (JSON.parse(p.stdout) as { streams: Array<Record<string, string | number>> }).streams[0]!;
      expect(Number(s["nb_read_frames"])).toBe(18);
      expect(s).toMatchObject({ width: 540, height: 540, pix_fmt: "yuv420p", codec_name: "h264" });
      console.log(`turntable real: ${sec.toFixed(1)} s total, ${r.ok ? r.secondsPerFrame : "?"} s/frame (Blender render only)`);
      if (process.env["TNF_KEEP_TURNTABLE"]) fs.copyFileSync(out, process.env["TNF_KEEP_TURNTABLE"]);
    },
    1_800_000,
  );
});
