import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildBrowserArgs,
  buildFfmpegArgs,
  detectEncoder,
  findBrowser,
  findFfmpeg,
  isAllowedUrl,
  MISSING_SEEK_MESSAGE,
  parseDevToolsPort,
  planRender,
  renderProject,
  sanitizeMessage,
  type FfSpawnFn,
  type PageSession,
} from "../../src/core/codevideo/render/index.js";

const EDGE86 = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const EDGE = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

describe("findBrowser", () => {
  it("prefers the env override", () => {
    const over = "D:\\x\\browser.exe";
    expect(findBrowser({ TNF_BROWSER_PATH: over }, "win32", (p) => p === over || p === EDGE86)).toBe(over);
  });
  it("ignores an override that does not exist", () => {
    expect(findBrowser({ TNF_BROWSER_PATH: "D:\\nope.exe" }, "win32", (p) => p === EDGE86)).toBe(EDGE86);
  });
  it("orders Edge(x86), Edge, Chrome on Windows", () => {
    expect(findBrowser({}, "win32", (p) => p === EDGE86 || p === CHROME)).toBe(EDGE86);
    expect(findBrowser({}, "win32", (p) => p === EDGE || p === CHROME)).toBe(EDGE);
    expect(findBrowser({}, "win32", (p) => p === CHROME)).toBe(CHROME);
  });
  it("returns null when nothing exists", () => {
    expect(findBrowser({}, "win32", () => false)).toBeNull();
  });
});

describe("findFfmpeg", () => {
  it("uses TNF_FFMPEG, then PATH, else null", () => {
    expect(findFfmpeg({ TNF_FFMPEG: "D:\\f\\ffmpeg.exe" }, "win32", (p) => p === "D:\\f\\ffmpeg.exe")).toBe("D:\\f\\ffmpeg.exe");
    const r = findFfmpeg({ PATH: "C:\\a;C:\\tools bin" }, "win32", (p) => p.endsWith("tools bin\\ffmpeg.exe"));
    expect(r).toContain("tools bin");
    expect(findFfmpeg({ PATH: "C:\\a" }, "win32", () => false)).toBeNull();
  });
});

describe("parseDevToolsPort", () => {
  it("parses the DevToolsActivePort file", () => {
    expect(parseDevToolsPort("52341\n/devtools/browser/abc-123\n")).toEqual({ port: 52341, browserPath: "/devtools/browser/abc-123" });
  });
  it("parses the stderr banner", () => {
    const t = "noise\nDevTools listening on ws://127.0.0.1:9333/devtools/browser/0f-ab\n";
    expect(parseDevToolsPort(t)).toEqual({ port: 9333, browserPath: "/devtools/browser/0f-ab" });
  });
  it("rejects garbage", () => {
    expect(parseDevToolsPort("")).toBeNull();
    expect(parseDevToolsPort("hello\nworld")).toBeNull();
    expect(parseDevToolsPort("0\n/x")).toBeNull();
  });
});

describe("browser args and URL guard", () => {
  it("uses a private profile and a random port", () => {
    const a = buildBrowserArgs("C:\\tmp\\my profile");
    expect(a).toContain("--remote-debugging-port=0");
    expect(a).toContain("--user-data-dir=C:\\tmp\\my profile");
    expect(a).toContain("--headless=new");
  });
  it("allows only file:// inside the project", () => {
    const dir = process.platform === "win32" ? "C:\\proj dir" : "/proj dir";
    const inside = process.platform === "win32" ? "file:///C:/proj%20dir/assets/a.png" : "file:///proj%20dir/assets/a.png";
    const outside = process.platform === "win32" ? "file:///C:/Windows/win.ini" : "file:///etc/passwd";
    expect(isAllowedUrl(inside, dir)).toBe(true);
    expect(isAllowedUrl(outside, dir)).toBe(false);
    expect(isAllowedUrl("https://example.com/x.js", dir)).toBe(false);
    expect(isAllowedUrl("http://127.0.0.1:4800/api", dir)).toBe(false);
    expect(isAllowedUrl("data:image/png;base64,AA", dir)).toBe(true);
    expect(isAllowedUrl("not a url", dir)).toBe(false);
  });
});

describe("ffmpeg args", () => {
  it("builds libx264 final with audio padding, fade and faststart", () => {
    const a = buildFfmpegArgs({ fps: 30, outFile: "o.mp4", encoder: "libx264", quality: "final", durationSec: 10, audioFile: "C:\\my music\\a.mp3" });
    expect(a).toContain("libx264");
    expect(a[a.indexOf("-crf") + 1]).toBe("18");
    expect(a[a.indexOf("-preset") + 1]).toBe("medium");
    expect(a).toContain("+faststart");
    expect(a).toContain("yuv420p");
    expect(a).toContain("C:\\my music\\a.mp3");
    expect(a).toContain("-shortest");
    const af = a[a.indexOf("-af") + 1] ?? "";
    expect(af).toContain("apad=whole_dur=10.000");
    expect(af).toContain("afade=t=out:st=9.000");
    expect(a[a.length - 1]).toBe("o.mp4");
  });
  it("builds nvenc without audio", () => {
    const a = buildFfmpegArgs({ fps: 15, outFile: "o.mp4", encoder: "h264_nvenc", quality: "draft", durationSec: 2 });
    expect(a).toContain("h264_nvenc");
    expect(a).toContain("-an");
    expect(a).not.toContain("-shortest");
    expect(a).toContain("image2pipe");
  });
  it("plans draft as half size and half fps", () => {
    expect(planRender({ width: 1080, height: 1920, fps: 30, durationSec: 4, quality: "draft" })).toMatchObject({
      outWidth: 540,
      outHeight: 960,
      fps: 15,
      totalFrames: 60,
    });
    expect(planRender({ width: 540, height: 960, fps: 30, durationSec: 2, quality: "final" }).totalFrames).toBe(60);
  });
});

function fakeChild(opts: { stdout?: string; code: number; onStdinEnd?: boolean; chunks?: Buffer[] }): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk: Buffer, _enc, cb) {
      opts.chunks?.push(Buffer.from(chunk));
      cb();
    },
  });
  Object.assign(ee, { stdout, stderr, stdin, exitCode: null, kill: () => true });
  const finish = (): void => {
    stdout.end();
    stderr.end();
    (ee as { exitCode: number | null }).exitCode = opts.code;
    ee.emit("close", opts.code);
  };
  if (opts.onStdinEnd) stdin.on("finish", () => setImmediate(finish));
  else {
    setImmediate(() => {
      if (opts.stdout) stdout.write(opts.stdout);
      finish();
    });
  }
  return ee;
}

describe("detectEncoder", () => {
  it("uses nvenc only when listed and probe passes", async () => {
    const calls: string[][] = [];
    const ok: FfSpawnFn = (_c, args) => {
      calls.push(args);
      return fakeChild({ stdout: " V....D h264_nvenc  NVIDIA NVENC\n", code: 0 });
    };
    expect(await detectEncoder("ffmpeg", ok, false)).toBe("h264_nvenc");
    expect(calls).toHaveLength(2);
  });
  it("falls back to libx264 when the probe fails or encoder not listed", async () => {
    const probeFails: FfSpawnFn = (_c, args) =>
      args.includes("-encoders") ? fakeChild({ stdout: "h264_nvenc\n", code: 0 }) : fakeChild({ code: 1 });
    expect(await detectEncoder("ffmpeg", probeFails, false)).toBe("libx264");
    const notListed: FfSpawnFn = () => fakeChild({ stdout: "libx264\n", code: 0 });
    expect(await detectEncoder("ffmpeg", notListed, false)).toBe("libx264");
  });
});

describe("sanitizeMessage", () => {
  it("hides project paths and tokens", () => {
    const s = sanitizeMessage("failed at D:\\secret proj\\index.html token=abc123", ["D:\\secret proj"]);
    expect(s).not.toContain("secret proj");
    expect(s).not.toContain("abc123");
  });
});

const noFs = {
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  rename: async () => undefined,
  rm: async () => undefined,
};

function fakePage(overrides: Partial<PageSession> = {}): PageSession & { shots: number; seeks: string[] } {
  const state = { shots: 0, seeks: [] as string[] };
  const page: PageSession = {
    setViewport: async () => undefined,
    navigate: async () => undefined,
    evaluate: async (expr: string) => {
      if (expr.includes("__seek) ===") || expr.includes("typeof window.__seek")) return true;
      state.seeks.push(expr);
      return 0;
    },
    screenshot: async () => {
      state.shots++;
      return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    },
    pageErrors: () => [],
    close: async () => undefined,
    ...overrides,
  };
  Object.defineProperty(page, "shots", { get: () => state.shots });
  Object.defineProperty(page, "seeks", { value: state.seeks });
  return page as PageSession & { shots: number; seeks: string[] };
}

describe("renderProject (fakes)", () => {
  const base = { projectDir: "D:\\p", outFile: "D:\\p\\out\\v.mp4", width: 540, height: 960, fps: 30, durationSec: 0.5, quality: "final" as const };

  it("returns a clear Vietnamese error when __seek is missing, without throwing", async () => {
    const page = fakePage({ evaluate: async () => false });
    const r = await renderProject({
      ...base,
      deps: { spawn: () => fakeChild({ stdout: "libx264", code: 0 }), launch: async () => page, fs: noFs },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("__seek(t)");
      expect(r.error).toBe(MISSING_SEEK_MESSAGE);
    }
  });

  it("seeks every frame, pipes them to ffmpeg and reports progress", async () => {
    const chunks: Buffer[] = [];
    const spawned: string[][] = [];
    const spawn: FfSpawnFn = (_c, args) => {
      spawned.push(args);
      if (args.includes("-encoders") || args.includes("lavfi")) return fakeChild({ stdout: "libx264", code: 0 });
      return fakeChild({ code: 0, onStdinEnd: true, chunks });
    };
    const page = fakePage();
    const progress: Array<[number, number]> = [];
    const r = await renderProject({
      ...base,
      onProgress: (d, t) => progress.push([d, t]),
      deps: { spawn, launch: async () => page, fs: noFs },
    });
    expect(r.ok).toBe(true);
    expect(page.shots).toBe(15);
    expect(chunks.length).toBe(15);
    expect(page.seeks[1]).toContain(String(1 / 30));
    expect(progress.at(-1)).toEqual([15, 15]);
    const enc = spawned.find((a) => a.includes("image2pipe"));
    expect(enc).toBeDefined();
  });

  it("stops on abort without throwing", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await renderProject({ ...base, signal: ac.signal, deps: { spawn: () => fakeChild({ code: 0 }), launch: async () => fakePage(), fs: noFs } });
    expect(r.ok).toBe(false);
  });

  it("rejects invalid options", async () => {
    const r = await renderProject({ ...base, fps: 0, deps: { spawn: () => fakeChild({ code: 0 }), launch: async () => fakePage(), fs: noFs } });
    expect(r.ok).toBe(false);
  });
});
