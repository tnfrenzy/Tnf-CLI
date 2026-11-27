import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BROWSER_MISSING_MESSAGE, FFMPEG_MISSING_MESSAGE, findBrowser, findFfmpeg } from "./browser.js";
import { launchPage, projectFileUrl, type LaunchFn, type PageSession } from "./cdp.js";
import {
  buildFfmpegArgs,
  defaultFfSpawn,
  detectEncoder,
  formatFrameName,
  sanitizeMessage,
  type EncoderName,
  type FfSpawnFn,
  type Quality,
} from "./frames.js";

export interface RenderDeps {
  /** ffmpeg spawn seam (must behave like shell:false spawn). */
  spawn?: FfSpawnFn;
  /** Page launcher seam (real = headless Edge/Chrome over CDP). */
  launch?: LaunchFn;
  now?: () => number;
  /** Frame/file system seam. */
  fs?: Pick<typeof fs.promises, "mkdir" | "writeFile" | "rename" | "rm">;
}

export interface RenderOptions {
  projectDir: string;
  indexFile?: string;
  outFile: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  audioFile?: string;
  quality: Quality;
  browserPath?: string;
  ffmpegPath?: string;
  /** Overall page-ready wait. Default 30 s. */
  readyTimeoutMs?: number;
  /** Per-frame (seek + capture) timeout. Default 30 s. */
  frameTimeoutMs?: number;
  /** Also keep every captured frame as frame_000000.jpg ... in this directory. */
  framesDir?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  deps?: RenderDeps;
}

export type RenderResult =
  | {
      ok: true;
      file: string;
      frames: number;
      /** Duration of the produced video in seconds. */
      seconds: number;
      encoder: EncoderName;
      width: number;
      height: number;
      fps: number;
      /** Wall-clock render time in seconds. */
      elapsedSec: number;
      framesPerSec: number;
    }
  | { ok: false; error: string };

export const MISSING_SEEK_MESSAGE =
  "Trang chưa có __seek(t). Hãy định nghĩa window.__seek = (t) => { ... } (t tính bằng giây) đặt toàn bộ hoạt ảnh về đúng thời điểm t, không dùng requestAnimationFrame hay Date.now(); và window.__ready là Promise resolve khi ảnh/phông/video đã tải xong.";

class RenderError extends Error {}

function fail(message: string): never {
  throw new RenderError(message);
}

/** Effective output geometry/fps for a quality level. Draft = half size, half fps. */
export function planRender(o: Pick<RenderOptions, "width" | "height" | "fps" | "durationSec" | "quality">): {
  outWidth: number;
  outHeight: number;
  fps: number;
  scale: number;
  totalFrames: number;
} {
  const draft = o.quality === "draft";
  const scale = draft ? 0.5 : 1;
  const fps = draft ? Math.max(1, Math.round(o.fps / 2)) : o.fps;
  return {
    outWidth: Math.max(2, Math.round(o.width * scale)),
    outHeight: Math.max(2, Math.round(o.height * scale)),
    fps,
    scale,
    totalFrames: Math.max(1, Math.round(o.durationSec * fps)),
  };
}

function validate(o: RenderOptions): void {
  const posInt = (n: number): boolean => Number.isFinite(n) && Number.isInteger(n) && n > 0;
  if (!posInt(o.width) || !posInt(o.height) || o.width > 7680 || o.height > 7680) fail("Kích thước video không hợp lệ.");
  if (!Number.isFinite(o.fps) || o.fps < 1 || o.fps > 120) fail("Tốc độ khung hình (fps) không hợp lệ (1-120).");
  if (!Number.isFinite(o.durationSec) || o.durationSec <= 0 || o.durationSec > 3600) fail("Thời lượng video không hợp lệ.");
}

function waitClose(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("close", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
}

function writeChunk(child: ChildProcess, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed) return reject(new Error("ffmpeg đã dừng."));
    const onErr = (e: Error): void => reject(e);
    stdin.once("error", onErr);
    const ok = stdin.write(buf, () => undefined);
    if (ok) {
      stdin.off("error", onErr);
      resolve();
    } else {
      stdin.once("drain", () => {
        stdin.off("error", onErr);
        resolve();
      });
    }
  });
}

/** Turn an HTML project directory into an MP4. Never throws. */
export async function renderProject(opts: RenderOptions): Promise<RenderResult> {
  const deps = opts.deps ?? {};
  const now = deps.now ?? Date.now;
  const spawnFn = deps.spawn ?? defaultFfSpawn;
  const launch = deps.launch ?? launchPage;
  const fsp = deps.fs ?? fs.promises;
  const started = now();
  const safe = (m: string): string => sanitizeMessage(m, [opts.projectDir, opts.outFile, opts.audioFile, opts.framesDir]);

  let session: PageSession | null = null;
  let ffmpeg: ChildProcess | null = null;
  let tmpOut: string | null = null;

  try {
    validate(opts);
    if (opts.signal?.aborted) fail("Đã hủy dựng video.");

    const indexFile = opts.indexFile ?? "index.html";
    const projectDir = path.resolve(opts.projectDir);
    const indexAbs = path.resolve(projectDir, indexFile);
    const rel = path.relative(projectDir, indexAbs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) fail("Tệp trang phải nằm trong thư mục dự án.");
    if (!deps.launch && !fs.existsSync(indexAbs)) fail(`Không thấy tệp trang ${path.basename(indexFile)} trong thư mục dự án.`);
    if (opts.audioFile && !deps.spawn && !fs.existsSync(opts.audioFile)) fail("Không thấy tệp âm thanh.");

    const browserPath = opts.browserPath ?? (deps.launch ? "fake-browser" : findBrowser());
    if (!browserPath) fail(BROWSER_MISSING_MESSAGE);
    const ffmpegPath = opts.ffmpegPath ?? (deps.spawn ? "ffmpeg" : findFfmpeg());
    if (!ffmpegPath) fail(FFMPEG_MISSING_MESSAGE);

    const plan = planRender(opts);
    const encoder = await detectEncoder(ffmpegPath, spawnFn, !deps.spawn);
    if (opts.signal?.aborted) fail("Đã hủy dựng video.");

    session = await launch({ browserPath, projectDir, signal: opts.signal, commandTimeoutMs: opts.frameTimeoutMs });
    await session.setViewport(opts.width, opts.height);
    await session.navigate(projectFileUrl(projectDir, indexFile), opts.readyTimeoutMs ?? 30_000);

    const readyMs = opts.readyTimeoutMs ?? 30_000;
    let hasSeek: unknown;
    try {
      hasSeek = await session.evaluate(
        "(async () => { if (window.__ready) await window.__ready; if (document.fonts && document.fonts.ready) await document.fonts.ready; return typeof window.__seek === 'function'; })()",
        readyMs,
      );
    } catch (e) {
      const errs = session.pageErrors();
      const detail = errs.length ? ` Lỗi trong trang: ${errs.slice(0, 3).join(" ; ")}` : "";
      fail(`Trang không sẵn sàng (window.__ready lỗi hoặc quá hạn ${Math.round(readyMs / 1000)}s): ${(e as Error).message}.${detail}`);
    }
    if (hasSeek !== true) {
      const errs = session.pageErrors();
      fail(errs.length ? `${MISSING_SEEK_MESSAGE} Lỗi trong trang: ${errs.slice(0, 3).join(" ; ")}` : MISSING_SEEK_MESSAGE);
    }

    const outAbs = path.resolve(opts.outFile);
    await fsp.mkdir(path.dirname(outAbs), { recursive: true });
    if (opts.framesDir) await fsp.mkdir(opts.framesDir, { recursive: true });
    tmpOut = `${outAbs}.part.mp4`;

    const args = buildFfmpegArgs({
      fps: plan.fps,
      outFile: tmpOut,
      encoder,
      quality: opts.quality,
      durationSec: plan.totalFrames / plan.fps,
      audioFile: opts.audioFile,
      input: { kind: "pipe", codec: "mjpeg" },
    });
    ffmpeg = spawnFn(ffmpegPath, args);
    let ffErr = "";
    ffmpeg.stderr?.on("data", (d: Buffer) => {
      if (ffErr.length < 8000) ffErr += d.toString("utf8");
    });
    ffmpeg.stdout?.resume();
    const closePromise = waitClose(ffmpeg);

    const frameMs = opts.frameTimeoutMs ?? 30_000;
    const jpegQuality = opts.quality === "draft" ? 70 : 92;
    for (let i = 0; i < plan.totalFrames; i++) {
      if (opts.signal?.aborted) fail("Đã hủy dựng video.");
      const t = i / plan.fps;
      try {
        await session.evaluate(`Promise.resolve(window.__seek(${JSON.stringify(t)})).then(() => 0)`, frameMs);
      } catch (e) {
        fail(`__seek(${t.toFixed(3)}) bị lỗi ở khung ${i}: ${(e as Error).message}`);
      }
      const jpg = await session.screenshot({
        format: "jpeg",
        quality: jpegQuality,
        width: opts.width,
        height: opts.height,
        scale: plan.scale,
      });
      if (opts.framesDir) await fsp.writeFile(path.join(opts.framesDir, formatFrameName(i)), jpg);
      try {
        await writeChunk(ffmpeg, jpg);
      } catch {
        // ffmpeg died; surface its own message below
        const code = await closePromise;
        fail(`ffmpeg dừng giữa chừng (mã ${code ?? "?"}): ${ffErr.trim().split("\n").slice(-3).join(" | ")}`);
      }
      opts.onProgress?.(i + 1, plan.totalFrames);
    }

    ffmpeg.stdin?.end();
    const code = await closePromise;
    if (code !== 0) fail(`ffmpeg lỗi (mã ${code ?? "?"}): ${ffErr.trim().split("\n").slice(-3).join(" | ")}`);
    await fsp.rm(outAbs, { force: true });
    await fsp.rename(tmpOut, outAbs);
    tmpOut = null;

    const elapsedSec = Math.max(0.001, (now() - started) / 1000);
    return {
      ok: true,
      file: outAbs,
      frames: plan.totalFrames,
      seconds: plan.totalFrames / plan.fps,
      encoder,
      width: plan.outWidth,
      height: plan.outHeight,
      fps: plan.fps,
      elapsedSec,
      framesPerSec: plan.totalFrames / elapsedSec,
    };
  } catch (e) {
    const message = e instanceof RenderError ? e.message : e instanceof Error ? e.message : "Lỗi không xác định khi dựng video.";
    return { ok: false, error: safe(message) };
  } finally {
    if (ffmpeg && ffmpeg.exitCode === null) {
      try {
        ffmpeg.stdin?.destroy();
        ffmpeg.kill();
      } catch {
        /* ignore */
      }
    }
    if (session) {
      try {
        await session.close();
      } catch {
        /* ignore */
      }
    }
    if (tmpOut) {
      try {
        await fsp.rm(tmpOut, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
