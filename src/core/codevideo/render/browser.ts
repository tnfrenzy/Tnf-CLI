import fs from "node:fs";
import path from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;
export type ExistsFn = (p: string) => boolean;

function isFileSync(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate a Chromium-based browser (Edge or Chrome) to drive over CDP.
 * Returns null when nothing usable is found (callers show a Vietnamese message).
 */
export function findBrowser(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  existsFn: ExistsFn = isFileSync,
): string | null {
  const override = env.TNF_BROWSER_PATH;
  if (override && existsFn(override)) return override;

  const candidates: string[] = [];
  if (platform === "win32") {
    const pf = env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = env.LOCALAPPDATA;
    candidates.push(
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      path.win32.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.win32.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.win32.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.win32.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    );
    if (local) candidates.push(path.win32.join(local, "Google", "Chrome", "Application", "chrome.exe"));
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else {
    candidates.push(
      "/usr/bin/microsoft-edge",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  for (const c of candidates) if (existsFn(c)) return c;
  return null;
}

function listDirsSafe(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function pathDirs(env: Env): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(path.delimiter).map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

/** Locate ffmpeg: TNF_FFMPEG override, then PATH, then common Windows install dirs. */
export function findFfmpeg(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  existsFn: ExistsFn = isFileSync,
): string | null {
  const override = env.TNF_FFMPEG;
  if (override && existsFn(override)) return override;

  const names = platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"];
  const dirs = pathDirs(env);
  const local = env.LOCALAPPDATA;
  if (platform === "win32") {
    if (local) {
      dirs.push(path.join(local, "Microsoft", "WinGet", "Links"));
      const pkgs = path.join(local, "Microsoft", "WinGet", "Packages");
      for (const p of listDirsSafe(pkgs).filter((d) => /ffmpeg/i.test(path.basename(d)))) {
        dirs.push(path.join(p, "bin"));
        for (const sub of listDirsSafe(p)) dirs.push(path.join(sub, "bin"));
      }
    }
    if (env.ProgramData) dirs.push(path.join(env.ProgramData, "chocolatey", "bin"));
    for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432]) {
      if (pf) dirs.push(path.join(pf, "ffmpeg", "bin"), path.join(pf, "FFmpeg", "bin"));
    }
    dirs.push("C:\\ffmpeg\\bin");
  }
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsFn(candidate)) return candidate;
    }
  }
  return null;
}

export const BROWSER_MISSING_MESSAGE =
  "Không tìm thấy trình duyệt Edge hoặc Chrome để dựng video. Hãy cài Microsoft Edge hoặc Google Chrome, hoặc đặt biến môi trường TNF_BROWSER_PATH trỏ tới tệp msedge.exe/chrome.exe.";
export const FFMPEG_MISSING_MESSAGE =
  "Không tìm thấy ffmpeg để ghép video. Hãy cài ffmpeg (ví dụ: winget install Gyan.FFmpeg) hoặc đặt biến môi trường TNF_FFMPEG trỏ tới ffmpeg.exe.";
