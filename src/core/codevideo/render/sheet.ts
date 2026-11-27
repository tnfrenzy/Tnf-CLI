import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FFMPEG_MISSING_MESSAGE, findFfmpeg } from "./browser.js";
import { defaultFfSpawn, formatFrameName, runCollect, sanitizeMessage, type FfSpawnFn } from "./frames.js";

export interface ContactSheetOptions {
  /** A video file, or a directory of frame_000000.jpg files written by renderProject({framesDir}). */
  videoOrFramesDir: string;
  times: number[];
  cols: number;
  thumbWidth: number;
  outFile: string;
  /** Needed when videoOrFramesDir is a frames directory (maps time -> frame index). */
  fps?: number;
  ffmpegPath?: string;
  spawn?: FfSpawnFn;
}

export type ContactSheetResult = { ok: true; file: string; count: number } | { ok: false; error: string };

const FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
];

function findFont(): string | null {
  for (const f of FONT_CANDIDATES) {
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* next */
    }
  }
  return null;
}

/** ffmpeg filter-argument escaping for a font path (colons and backslashes). */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

export function buildThumbFilter(thumbWidth: number, label: string, fontPath: string | null): string {
  const scale = `scale=${thumbWidth}:-2`;
  if (!fontPath) return scale;
  const text = label.replace(/[^0-9.:s-]/g, "");
  return `${scale},drawtext=fontfile='${escapeFilterPath(fontPath)}':text='${text}':x=6:y=6:fontsize=${Math.max(12, Math.round(thumbWidth / 14))}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3`;
}

/** Build a labelled contact sheet PNG so Claude can review a render. Never throws. */
export async function makeContactSheet(opts: ContactSheetOptions): Promise<ContactSheetResult> {
  const spawnFn = opts.spawn ?? defaultFfSpawn;
  let tmp: string | null = null;
  try {
    if (!Array.isArray(opts.times) || opts.times.length === 0 || opts.times.length > 120) {
      return { ok: false, error: "Danh sách thời điểm không hợp lệ (1-120 mốc)." };
    }
    if (opts.times.some((t) => !Number.isFinite(t) || t < 0)) return { ok: false, error: "Có mốc thời gian không hợp lệ." };
    if (!Number.isInteger(opts.cols) || opts.cols < 1 || opts.cols > 20) return { ok: false, error: "Số cột không hợp lệ." };
    if (!Number.isInteger(opts.thumbWidth) || opts.thumbWidth < 16 || opts.thumbWidth > 2000) {
      return { ok: false, error: "Chiều rộng ảnh nhỏ không hợp lệ." };
    }
    const ffmpegPath = opts.ffmpegPath ?? (opts.spawn ? "ffmpeg" : findFfmpeg());
    if (!ffmpegPath) return { ok: false, error: FFMPEG_MISSING_MESSAGE };

    const src = path.resolve(opts.videoOrFramesDir);
    let isDir = false;
    try {
      isDir = fs.statSync(src).isDirectory();
    } catch {
      if (!opts.spawn) return { ok: false, error: "Không thấy video hoặc thư mục khung để tạo bảng khung." };
    }
    if (isDir && !(opts.fps && opts.fps > 0)) return { ok: false, error: "Cần fps khi dùng thư mục khung." };

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tnf-cv-sheet-"));
    const font = findFont();
    const thumbs: string[] = [];
    for (let i = 0; i < opts.times.length; i++) {
      const t = opts.times[i] as number;
      const thumb = path.join(tmp, `t_${String(i).padStart(3, "0")}.png`);
      const vf = buildThumbFilter(opts.thumbWidth, `${t.toFixed(2)}s`, font);
      const args = isDir
        ? [
            "-y", "-hide_banner", "-loglevel", "error",
            "-i", path.join(src, formatFrameName(Math.round(t * (opts.fps as number)))),
            "-frames:v", "1", "-vf", vf, thumb,
          ]
        : ["-y", "-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), "-i", src, "-frames:v", "1", "-vf", vf, thumb];
      const r = await runCollect(spawnFn, ffmpegPath, args, 30_000);
      if (r.code !== 0 || (!opts.spawn && !fs.existsSync(thumb))) {
        // a time past the end of the video yields no frame; skip it
        continue;
      }
      thumbs.push(thumb);
    }
    if (thumbs.length === 0) return { ok: false, error: "Không trích được khung nào tại các mốc đã chọn." };

    const cols = Math.min(opts.cols, thumbs.length);
    const rows = Math.ceil(thumbs.length / cols);
    const out = path.resolve(opts.outFile);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const args = [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", "1", "-i", path.join(tmp, "t_%03d.png"),
      "-vf", `tile=${cols}x${rows}:padding=4:color=black`,
      "-frames:v", "1", out,
    ];
    const r = await runCollect(spawnFn, ffmpegPath, args, 60_000);
    if (r.code !== 0) return { ok: false, error: sanitizeMessage(`Không ghép được bảng khung: ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`, [opts.videoOrFramesDir, opts.outFile]) };
    return { ok: true, file: out, count: thumbs.length };
  } catch (e) {
    return { ok: false, error: sanitizeMessage(e instanceof Error ? e.message : "Lỗi khi tạo bảng khung.", [opts.videoOrFramesDir, opts.outFile]) };
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
