import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser, findFfmpeg, makeContactSheet, renderProject } from "../../src/core/codevideo/render/index.js";

const browser = findBrowser();
const ffmpeg = findFfmpeg();
const ffprobe = ffmpeg ? path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe") : null;
const canRun = !!browser && !!ffmpeg && !!ffprobe && fs.existsSync(ffprobe);

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
#box{position:absolute;width:100px;height:100px;top:40%}
</style></head><body><div id="box"></div><script>
window.__ready = new Promise(function (r) { setTimeout(r, 50); });
window.__seek = function (t) {
  var box = document.getElementById('box');
  box.style.left = (t * 200) + 'px';
  box.style.background = 'hsl(' + Math.round(t * 120) + ',90%,50%)';
  document.body.style.background = 'rgb(' + Math.round(t * 60) + ',0,40)';
};
</script></body></html>`;

function probe(file: string): { width: number; height: number; duration: number; frames: number } {
  const r = spawnSync(
    ffprobe as string,
    ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames:format=duration", "-of", "json", file],
    { encoding: "utf8", shell: false },
  );
  const j = JSON.parse(r.stdout) as { streams: Array<{ width: number; height: number; nb_read_frames: string }>; format: { duration: string } };
  const s = j.streams[0] as { width: number; height: number; nb_read_frames: string };
  return { width: s.width, height: s.height, duration: Number(j.format.duration), frames: Number(s.nb_read_frames) };
}

function firstFrameHash(file: string): string {
  const r = spawnSync(ffmpeg as string, ["-v", "error", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "bmp", "-"], {
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  return crypto.createHash("sha256").update(r.stdout).digest("hex");
}

describe.skipIf(!canRun)("renderProject (real Edge + ffmpeg)", { timeout: 240_000 }, () => {
  let root = "";
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tnf cv test-"));
    fs.writeFileSync(path.join(root, "index.html"), FIXTURE);
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("renders 2s @30fps 540x960 to a correct MP4, deterministically, plus a contact sheet", async () => {
    const out1 = path.join(root, "out", "a.mp4");
    const out2 = path.join(root, "out", "b.mp4");
    const framesDir = path.join(root, "out", "frames");
    const base = { projectDir: root, width: 540, height: 960, fps: 30, durationSec: 2, quality: "final" as const };

    const r1 = await renderProject({ ...base, outFile: out1, framesDir });
    expect(r1).toMatchObject({ ok: true });
    const r2 = await renderProject({ ...base, outFile: out2 });
    expect(r2).toMatchObject({ ok: true });

    const p = probe(out1);
    expect(p.width).toBe(540);
    expect(p.height).toBe(960);
    expect(Math.abs(p.duration - 2)).toBeLessThanOrEqual(0.1);
    expect(p.frames).toBe(60);
    expect(firstFrameHash(out1)).toBe(firstFrameHash(out2));
    expect(fs.readdirSync(path.join(root, "out")).filter((f) => f.includes(".part"))).toEqual([]);
    expect(fs.readdirSync(framesDir).length).toBe(60);

    const sheet = path.join(root, "out", "sheet.png");
    const s = await makeContactSheet({ videoOrFramesDir: out1, times: [0, 0.5, 1, 1.5], cols: 2, thumbWidth: 200, outFile: sheet });
    expect(s).toMatchObject({ ok: true, count: 4 });
    expect(fs.statSync(sheet).size).toBeGreaterThan(500);
    const s2 = await makeContactSheet({ videoOrFramesDir: framesDir, fps: 30, times: [0, 1.9], cols: 2, thumbWidth: 200, outFile: sheet });
    expect(s2).toMatchObject({ ok: true, count: 2 });
  });

  it("reports a missing __seek without crashing", async () => {
    const dir = path.join(root, "noseek");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><body>hi</body>");
    const r = await renderProject({ projectDir: dir, outFile: path.join(dir, "o.mp4"), width: 270, height: 480, fps: 10, durationSec: 1, quality: "draft" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("__seek(t)");
  });

  it("does not let the page reach the network", async () => {
    const dir = path.join(root, "net");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<!doctype html><body><script>
      window.__seek=function(){};
      window.__ready=fetch('http://127.0.0.1:9/x').then(function(){window.__net='open'},function(){window.__net='blocked'});
      </script></body>`,
    );
    const r = await renderProject({ projectDir: dir, outFile: path.join(dir, "o.mp4"), width: 270, height: 480, fps: 10, durationSec: 0.5, quality: "draft" });
    expect(r.ok).toBe(true);
  });

  it("measures throughput at 1080x1920 (informational)", async () => {
    const r = await renderProject({ projectDir: root, outFile: path.join(root, "out", "big.mp4"), width: 1080, height: 1920, fps: 30, durationSec: 2, quality: "final" });
    expect(r.ok).toBe(true);
    if (r.ok) console.log(`[render-speed] 1080x1920 ${r.frames} frames in ${r.elapsedSec.toFixed(2)}s = ${r.framesPerSec.toFixed(1)} fps (${r.encoder})`);
  });
});
