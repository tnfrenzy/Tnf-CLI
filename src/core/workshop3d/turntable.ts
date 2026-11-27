/**
 * Video quay tròn (turntable) của một phiên Xưởng 3D: outputs/turntable.mp4 (hoặc .webm khi nền trong suốt).
 *
 * - Blender (tools/workshop3d/blender/render_turntable.py) dựng cảnh studio, bệ tròn trắng, quay bàn xoay 360 độ và ghi chuỗi PNG RGBA.
 *   Chạy qua runBlenderProcess (một Blender một lúc, không shell, hủy được).
 * - ffmpeg ghép PNG thành MP4 H.264 yuv420p; màu nền thương hiệu được đặt ở bước này (chính xác từng mã màu).
 *   Nền trong suốt (background = null) xuất WebM VP9 có kênh alpha vì MP4 không chứa được alpha.
 * - Thư mục làm việc renders/turntable/work nằm trong phiên, được dọn sau khi xong; tiến độ ở renders/turntable/progress.json.
 * - Không ném lỗi: kết quả {ok:false,error} với thông báo tiếng Việt, không chứa đường dẫn trên máy.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { killTree } from "../design3d/cad-tools.js";
import { findFfmpeg } from "../codevideo/render/browser.js";
import { BLENDER_MISSING_MSG, BLENDER_TOOLS_DIR, parseBlenderResult, runBlenderProcess, type BlenderRun } from "./blender.js";
import type { W3DStore } from "./store.js";

export const TURNTABLE_MP4 = "outputs/turntable.mp4";
export const TURNTABLE_WEBM = "outputs/turntable.webm";
export const TURNTABLE_DIR = "renders/turntable";
export const TURNTABLE_PROGRESS = `${TURNTABLE_DIR}/progress.json`;
const WORK_DIR = `${TURNTABLE_DIR}/work`;
const MODEL_GLB = "outputs/model.glb";
const BLENDER_GLB_REL = "outputs/model-blender.glb";
const BLENDER_TIMEOUT_MS = 1_800_000;
const FFMPEG_TIMEOUT_MS = 600_000;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface TurntableOptions {
  width?: number;
  height?: number;
  durationSec?: number;
  /** Output frame rate. */
  fps?: number;
  /** Frames Blender renders per second of video (default min(fps, 12)): fewer frames = much faster on a CPU-only PC; ffmpeg blends up to `fps`. */
  renderFps?: number;
  /** "#rrggbb" = màu nền; null = trong suốt (WebM alpha). Mặc định xanh đậm thương hiệu. */
  background?: string | null;
  engine?: "eevee" | "cycles";
  samples?: number;
  elevationDeg?: number;
  turns?: number;
  pedestal?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: TurntableProgress) => void;
}

export interface TurntableProgress {
  running: boolean;
  phase: "render" | "encode" | "done" | "failed" | "cancelled";
  total: number;
  done: number;
  startedAt: string;
  updatedAt: string;
  file?: string;
  error?: string;
  secondsPerFrame?: number;
}

export type TurntableResult =
  | { ok: true; file: string; frames: number; seconds: number; secondsPerFrame: number | null }
  | { ok: false; error: string; cancelled?: boolean };

export type FfmpegRun = (exe: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal | undefined }) => Promise<{ code: number | null; stderr: string; aborted: boolean }>;

export interface TurntableDeps {
  /** blender.exe, hoặc null khi chưa cài. */
  blender: string | null;
  ffmpeg?: string | null;
  run?: BlenderRun;
  ffRun?: FfmpegRun;
  scriptsDir?: string;
  libraryDir?: string | null;
  polyhavenDir?: string | null;
  pollMs?: number;
  now?: () => number;
}

export const DEFAULT_TURNTABLE_BACKGROUND = "#0b2a6f";

export interface TurntableSettings {
  width: number;
  height: number;
  fps: number;
  renderFps: number;
  frames: number;
  durationSec: number;
  samples: number;
  engine: "eevee" | "cycles";
  elevationDeg: number;
  turns: number;
  pedestal: boolean;
  /** "#rrggbb" thường hoặc null. */
  background: string | null;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const even = (n: number): number => Math.round(n / 2) * 2;

/** Chuẩn hóa tùy chọn: kích thước chẵn trong 64..3840, fps 1..60, tối đa 20 giây. */
export function normalizeTurntable(o: TurntableOptions = {}): TurntableSettings {
  const fps = Math.round(clamp(num(o.fps, 24), 1, 60));
  const durationSec = clamp(num(o.durationSec, 8), 0.5, 20);
  const renderFps = Math.round(clamp(num(o.renderFps, Math.min(fps, 12)), 1, fps));
  const bg = o.background === undefined ? DEFAULT_TURNTABLE_BACKGROUND : o.background;
  return {
    width: even(clamp(num(o.width, 1080), 64, 3840)),
    height: even(clamp(num(o.height, 1080), 64, 3840)),
    fps,
    renderFps,
    frames: Math.max(1, Math.round(durationSec * renderFps)),
    durationSec,
    samples: Math.round(clamp(num(o.samples, 24), 1, 512)),
    engine: o.engine === "eevee" ? "eevee" : "cycles",
    elevationDeg: clamp(num(o.elevationDeg, 12), -10, 70),
    turns: clamp(num(o.turns, 1), 0.1, 4),
    pedestal: o.pedestal !== false,
    background: typeof bg === "string" && HEX_RE.test(bg) ? bg.toLowerCase() : null,
  };
}

/** GLB dùng để render: bản Blender đã nướng vật liệu nếu có, không thì model.glb. null nếu phiên chưa có GLB. */
export function turntableGlb(sessionDir: string): { abs: string; baked: boolean } | null {
  const baked = path.join(sessionDir, BLENDER_GLB_REL);
  if (fs.existsSync(baked)) return { abs: baked, baked: true };
  const plain = path.join(sessionDir, MODEL_GLB);
  return fs.existsSync(plain) ? { abs: plain, baked: false } : null;
}

/** job.json của render_turntable.py. */
export function buildTurntableJob(s: TurntableSettings, glb: string, outDir: string, extra: { materials?: string | null; libraryDir?: string | null; polyhavenDir?: string | null } = {}): Record<string, unknown> {
  return {
    glb, out_dir: outDir, width: s.width, height: s.height, frames: s.frames, fps: s.renderFps, samples: s.samples, engine: s.engine,
    background: { color: s.background }, pedestal: s.pedestal, orbit: { elevation_deg: s.elevationDeg, turns: s.turns },
    ...(extra.materials ? { materials: extra.materials } : {}), libraryDir: extra.libraryDir ?? null, polyhavenDir: extra.polyhavenDir ?? null,
  };
}

/** Lệnh ffmpeg ghép frame_%04d.png (bắt đầu từ 1). Có màu nền: trộn lên màu đó; không: WebM VP9 giữ alpha. */
export function buildTurntableFfmpegArgs(s: TurntableSettings, framesDir: string, outFile: string): string[] {
  const input = ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(s.renderFps), "-start_number", "1", "-i", path.join(framesDir, "frame_%04d.png")];
  const blend = s.renderFps < s.fps ? `framerate=fps=${s.fps}` : null;
  if (s.background) {
    const c = `0x${s.background.slice(1)}`;
    return [
      ...input, "-f", "lavfi", "-i", `color=c=${c}:s=${s.width}x${s.height}:r=${s.fps}`,
      "-filter_complex", `${blend ? `[0:v]${blend}[a];[1:v][a]` : "[1:v][0:v]"}overlay=format=auto:shortest=1,format=yuv420p[v]`, "-map", "[v]",
      "-r", String(s.fps), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", outFile,
    ];
  }
  return [...input, ...(blend ? ["-vf", blend] : []), "-r", String(s.fps), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30", "-auto-alt-ref", "0", "-an", outFile];
}

export const defaultFfRun: FfmpegRun = (exe, args, opts) =>
  new Promise((resolve) => {
    let stderr = "";
    let done = false;
    let aborted = false;
    const child = spawn(exe, args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ code, stderr, aborted });
    };
    const timer = setTimeout(() => {
      killTree(child);
      setTimeout(() => finish(null), 5000).unref();
    }, opts.timeoutMs);
    const poll = setInterval(() => {
      if (opts.signal?.aborted && !aborted) {
        aborted = true;
        killTree(child);
        setTimeout(() => finish(null), 5000).unref();
      }
    }, 500);
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-4000)));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });

/** Bỏ đường dẫn nhạy cảm khỏi thông báo lỗi. */
export function cleanTurntableError(text: string, paths: string[] = []): string {
  let out = text;
  for (const r of [...paths, os.homedir(), os.tmpdir()].filter((p) => p && p.length > 3).sort((a, b) => b.length - a.length)) {
    for (const v of new Set([r, r.replace(/\\/g, "/")])) out = out.split(v).join("<đường-dẫn>");
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

const writeJson = (file: string, v: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v), "utf8");
  fs.renameSync(tmp, file);
};

export function readTurntableProgress(sessionDir: string): TurntableProgress | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sessionDir, TURNTABLE_PROGRESS), "utf8")) as TurntableProgress;
    return j && typeof j === "object" && typeof j.phase === "string" ? j : null;
  } catch {
    return null;
  }
}

/** Tên tệp video đã có của phiên (mp4 trước), hoặc null. */
export function existingTurntable(sessionDir: string): string | null {
  for (const rel of [TURNTABLE_MP4, TURNTABLE_WEBM]) if (fs.existsSync(path.join(sessionDir, rel))) return rel;
  return null;
}

/** Render video quay tròn của phiên `slug`. Không ném lỗi. */
export async function renderTurntable(store: W3DStore, slug: string, opts: TurntableOptions, deps: TurntableDeps): Promise<TurntableResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let dir: string;
  try {
    dir = store.dir(slug);
  } catch {
    return { ok: false, error: "Mã phiên không hợp lệ." };
  }
  if (!fs.existsSync(dir)) return { ok: false, error: "Không tìm thấy phiên dựng 3D." };
  if (!deps.blender) return { ok: false, error: BLENDER_MISSING_MSG };
  const ffmpeg = deps.ffmpeg !== undefined ? deps.ffmpeg : findFfmpeg();
  if (!ffmpeg) return { ok: false, error: "Không tìm thấy ffmpeg để ghép video quay tròn. Cài ffmpeg hoặc đặt biến TNF_FFMPEG." };
  const glb = turntableGlb(dir);
  if (!glb) return { ok: false, error: "Phiên này chưa có mô hình (outputs/model.glb) để quay tròn." };
  const s = normalizeTurntable(opts);
  const work = path.join(dir, WORK_DIR);
  const outRel = s.background ? TURNTABLE_MP4 : TURNTABLE_WEBM;
  const outAbs = path.join(dir, outRel);
  const tmpOut = path.join(dir, TURNTABLE_DIR, `.out.${s.background ? "mp4" : "webm"}`);
  const stop = (): boolean => !!opts.signal?.aborted;
  const progress: TurntableProgress = { running: true, phase: "render", total: s.frames, done: 0, startedAt: new Date(t0).toISOString(), updatedAt: new Date(t0).toISOString() };
  const save = (): void => {
    progress.updatedAt = new Date(now()).toISOString();
    try {
      writeJson(path.join(dir, TURNTABLE_PROGRESS), progress);
    } catch {
      /* tiến độ chỉ để hiển thị */
    }
    try {
      opts.onProgress?.({ ...progress });
    } catch {
      /* callback của người gọi không được làm hỏng render */
    }
  };
  const fail = (error: string, cancelled = false): TurntableResult => {
    progress.running = false;
    progress.phase = cancelled ? "cancelled" : "failed";
    progress.error = error;
    save();
    return cancelled ? { ok: false, error, cancelled: true } : { ok: false, error };
  };
  const clean = (): void => {
    for (const p of [work, tmpOut]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* thư mục bị khóa không được làm hỏng kết quả */
      }
    }
  };
  const hidePaths = [dir];
  try {
    clean();
    fs.mkdirSync(work, { recursive: true });
    const mats = path.join(dir, "materials.json");
    const jobFile = path.join(dir, TURNTABLE_DIR, "job.json");
    writeJson(jobFile, buildTurntableJob(s, glb.abs, work, { materials: !glb.baked && fs.existsSync(mats) ? mats : null, libraryDir: deps.libraryDir ?? null, polyhavenDir: deps.polyhavenDir ?? null }));
    save();
    const countFrames = (): number => {
      try {
        return fs.readdirSync(work).filter((f) => /^frame_\d+\.png$/.test(f)).length;
      } catch {
        return 0;
      }
    };
    const ticker = setInterval(() => {
      const n = countFrames();
      if (n !== progress.done) {
        progress.done = Math.min(n, s.frames);
        save();
      }
    }, 1500);
    const run = deps.run ?? runBlenderProcess;
    const runOnce = (engine: "eevee" | "cycles") => {
      if (engine !== s.engine) writeJson(jobFile, buildTurntableJob({ ...s, engine }, glb.abs, work, { materials: !glb.baked && fs.existsSync(mats) ? mats : null, libraryDir: deps.libraryDir ?? null, polyhavenDir: deps.polyhavenDir ?? null }));
      return run(deps.blender as string, ["-b", "--factory-startup", "-noaudio", "-P", path.join(deps.scriptsDir ?? BLENDER_TOOLS_DIR, "render_turntable.py"), "--", jobFile], {
        timeoutMs: BLENDER_TIMEOUT_MS, shouldStop: stop, ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
      });
    };
    let r;
    try {
      r = await runOnce(s.engine);
      // EEVEE cần OpenGL: máy không có GPU có thể không chạy được, thử lại bằng Cycles CPU.
      if (!r.aborted && !r.timedOut && s.engine === "eevee" && parseBlenderResult(r.stdout)?.["ok"] !== true) {
        fs.rmSync(work, { recursive: true, force: true });
        fs.mkdirSync(work, { recursive: true });
        r = await runOnce("cycles");
      }
    } finally {
      clearInterval(ticker);
    }
    if (r.aborted || stop()) {
      clean();
      return fail("Đã hủy render video quay tròn.", true);
    }
    if (r.timedOut) {
      clean();
      return fail("Blender chạy quá lâu khi render video quay tròn, đã dừng. Thử giảm độ phân giải hoặc thời lượng.");
    }
    const info = parseBlenderResult(r.stdout);
    if (!info || info["ok"] !== true) {
      const why = typeof info?.["error"] === "string" ? info["error"] : r.stderr.trim().split(/\r?\n/).pop() || `mã thoát ${r.code}`;
      clean();
      return fail(`Blender không render được video quay tròn: ${cleanTurntableError(why, hidePaths)}`);
    }
    const frames = countFrames();
    if (frames < s.frames) {
      clean();
      return fail(`Blender chỉ ra ${frames}/${s.frames} khung hình.`);
    }
    const spf = typeof info["secondsPerFrame"] === "number" ? (info["secondsPerFrame"] as number) : null;
    progress.phase = "encode";
    progress.done = s.frames;
    if (spf !== null) progress.secondsPerFrame = spf;
    save();
    const ff = await (deps.ffRun ?? defaultFfRun)(ffmpeg, buildTurntableFfmpegArgs(s, work, tmpOut), { timeoutMs: FFMPEG_TIMEOUT_MS, signal: opts.signal });
    if (ff.aborted || stop()) {
      clean();
      return fail("Đã hủy render video quay tròn.", true);
    }
    if (ff.code !== 0 || !fs.existsSync(tmpOut)) {
      const why = cleanTurntableError(ff.stderr || `mã thoát ${ff.code}`, hidePaths);
      clean();
      return fail(`Không ghép được video quay tròn bằng ffmpeg: ${why}`);
    }
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.rmSync(path.join(dir, outRel === TURNTABLE_MP4 ? TURNTABLE_WEBM : TURNTABLE_MP4), { force: true });
    fs.rmSync(outAbs, { force: true });
    fs.renameSync(tmpOut, outAbs);
    clean();
    progress.running = false;
    progress.phase = "done";
    progress.file = outRel;
    delete progress.error;
    save();
    return { ok: true, file: outRel, frames: s.frames, seconds: Math.round((now() - t0) / 100) / 10, secondsPerFrame: spf };
  } catch (e) {
    clean();
    return fail(`Lỗi khi render video quay tròn: ${cleanTurntableError(e instanceof Error ? e.message : String(e), hidePaths)}`);
  }
}
