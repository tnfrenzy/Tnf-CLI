import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type Quality = "draft" | "final";
export type EncoderName = "h264_nvenc" | "libx264";
export type FfSpawnFn = (command: string, args: string[]) => ChildProcess;

export const defaultFfSpawn: FfSpawnFn = (command, args) =>
  nodeSpawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

export interface CollectResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a short command and collect its output; never rejects (spawn errors become code null). */
export function runCollect(spawnFn: FfSpawnFn, command: string, args: string[], timeoutMs = 20_000): Promise<CollectResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
      done(null);
    }, timeoutMs);
    try {
      child = spawnFn(command, args);
    } catch {
      done(null);
      return;
    }
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < 200_000) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 200_000) stderr += d.toString("utf8");
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code));
  });
}

const encoderCache = new Map<string, EncoderName>();

/**
 * Prefer h264_nvenc when ffmpeg lists it AND a tiny real encode succeeds
 * (the encoder can be compiled in while no NVIDIA GPU/driver is present).
 */
export async function detectEncoder(
  ffmpegPath: string,
  spawnFn: FfSpawnFn = defaultFfSpawn,
  useCache = true,
): Promise<EncoderName> {
  if (useCache) {
    const hit = encoderCache.get(ffmpegPath);
    if (hit) return hit;
  }
  let result: EncoderName = "libx264";
  const list = await runCollect(spawnFn, ffmpegPath, ["-hide_banner", "-encoders"]);
  if (list.code === 0 && /\bh264_nvenc\b/.test(list.stdout)) {
    const probe = await runCollect(spawnFn, ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=256x256:d=0.2:r=10",
      "-c:v",
      "h264_nvenc",
      "-f",
      "null",
      "-",
    ]);
    if (probe.code === 0) result = "h264_nvenc";
  }
  if (useCache) encoderCache.set(ffmpegPath, result);
  return result;
}

export interface FfmpegArgsInput {
  /** Frame rate of the frames being piped in (already the effective fps). */
  fps: number;
  outFile: string;
  encoder: EncoderName;
  quality: Quality;
  durationSec: number;
  audioFile?: string | undefined;
  /** "pipe" reads MJPEG/PNG frames from stdin; otherwise a printf-style image pattern on disk. */
  input?: { kind: "pipe"; codec: "mjpeg" | "png" } | { kind: "pattern"; pattern: string };
}

const FADE_SEC = 1;

export function buildFfmpegArgs(i: FfmpegArgsInput): string[] {
  const input = i.input ?? { kind: "pipe", codec: "mjpeg" };
  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  if (input.kind === "pipe") {
    args.push("-f", "image2pipe", "-c:v", input.codec, "-framerate", String(i.fps), "-i", "pipe:0");
  } else {
    args.push("-framerate", String(i.fps), "-i", input.pattern);
  }
  if (i.audioFile) args.push("-i", i.audioFile);

  // yuv420p needs even dimensions
  args.push("-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic");
  args.push("-r", String(i.fps));

  const draft = i.quality === "draft";
  if (i.encoder === "h264_nvenc") {
    args.push("-c:v", "h264_nvenc", "-preset", draft ? "p3" : "p5", "-rc", "vbr", "-cq", draft ? "28" : "19", "-b:v", "0");
  } else {
    args.push("-c:v", "libx264", "-preset", draft ? "veryfast" : "medium", "-crf", draft ? "28" : "18");
  }
  args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart");

  if (i.audioFile) {
    const d = Math.max(0.1, i.durationSec);
    const fade = Math.min(FADE_SEC, d);
    const fadeStart = Math.max(0, d - fade);
    // pad/cut to the video length first, then fade the tail
    const filter = `apad=whole_dur=${d.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=${fade.toFixed(3)}`;
    args.push("-map", "0:v:0", "-map", "1:a:0", "-af", filter, "-c:a", "aac", "-b:a", "192k", "-t", d.toFixed(3), "-shortest");
  } else {
    args.push("-an");
  }
  args.push(i.outFile);
  return args;
}

/** Strip sensitive-looking material from text shown to users or fed back to Claude. */
export function sanitizeMessage(text: string, paths: ReadonlyArray<string | undefined> = []): string {
  let out = text;
  const roots = [...paths, os.homedir(), os.tmpdir()].filter((p): p is string => !!p && p.length > 3);
  // longest first so nested paths collapse cleanly
  roots.sort((a, b) => b.length - a.length);
  for (const r of roots) {
    for (const variant of new Set([r, r.replace(/\\/g, "/"), path.resolve(r)])) {
      out = out.split(variant).join("<đường-dẫn>");
    }
  }
  out = out.replace(/(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_.-]+)/g, "<ẩn>");
  out = out.replace(/(token|key|secret|password)=\S+/gi, "$1=<ẩn>");
  return out.length > 800 ? `${out.slice(0, 800)}…` : out;
}

export function formatFrameName(index: number): string {
  return `frame_${String(index).padStart(6, "0")}.jpg`;
}
