import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodeVideoCore, type CvAgentRunner, type CvStepManager } from "../../src/core/codevideo/index.js";
import type { RenderOptions, RenderResult } from "../../src/core/codevideo/render/index.js";

let dataDir: string;

const manager: CvStepManager = {
  startRun: async () => ({ id: "r1" }),
  waitFor: async () => ({ status: "done" }),
  cancel: () => true,
  store: { getProject: () => ({}), upsertProject: () => undefined },
};

const okRender = async (o: RenderOptions): Promise<RenderResult> => {
  fs.mkdirSync(path.dirname(o.outFile), { recursive: true });
  fs.writeFileSync(o.outFile, "fake");
  o.onProgress?.(1, 1);
  return { ok: true, file: o.outFile, frames: 1, seconds: o.durationSec, encoder: "libx264", width: o.width, height: o.height, fps: o.fps, elapsedSec: 0, framesPerSec: 1 };
};
const sheetOk = async (o: { outFile: string }) => {
  fs.writeFileSync(o.outFile, "png");
  return { ok: true as const, file: o.outFile, count: 8 };
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-core-"));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function make(runner: CvAgentRunner, render = okRender) {
  return createCodeVideoCore({ manager, dataDir, runner, render, sheet: sheetOk as never });
}

describe("codevideo core", () => {
  it("creates a project from the template with lib, brand and motion doc", () => {
    const core = make(async () => ({ ok: true, text: "", costUsd: 0, runId: "r" }));
    const p = core.create({ title: "Giới thiệu Xưởng Mẫu", brief: "Video 30 giây" });
    expect(p.slug).toBe("gioi-thieu-xuong-mau");
    const d = core.store.dir(p.slug);
    for (const f of ["index.html", "lib/tnf-motion.js", "brand.js", "brand.json", "project.json", "MOTION.md"]) expect(fs.existsSync(path.join(d, f))).toBe(true);
    expect(p.state).toBe("draft");
  });

  it("rejects an empty title/brief and a path-escaping asset", () => {
    const core = make(async () => ({ ok: true, text: "", costUsd: 0, runId: "r" }));
    expect(() => core.create({ title: " ", brief: "x" })).toThrow(/tiêu đề/);
    expect(() => core.create({ title: "a", brief: "" })).toThrow(/mô tả/);
    const p = core.create({ title: "a", brief: "b" });
    expect(() => core.store.addAsset(p.slug, "evil.exe", Buffer.from("x"))).toThrow(/chưa được hỗ trợ/);
    expect(() => core.store.resolveInside(p.slug, "../../x")).toThrow(/ngoài/);
    const a = core.store.addAsset(p.slug, "../../Ảnh Đẹp.PNG", Buffer.from("x"));
    expect(a.path).toBe("assets/Anh-dep.png");
  });

  it("generate: coder -> draft -> review -> final, state done with video", async () => {
    const prompts: string[] = [];
    const core = make(async (prompt) => {
      prompts.push(prompt);
      return { ok: true, text: "ok", costUsd: 0.5, runId: "r" };
    });
    const p = core.create({ title: "Demo", brief: "Mô tả" });
    core.startGenerate(p.slug);
    await core.whenIdle(p.slug);
    const done = core.store.get(p.slug);
    expect(done.state).toBe("done");
    expect(done.video).toBe("out/video.mp4");
    expect(done.costUsd).toBeCloseTo(1.0);
    expect(done.rounds).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatch(/dựng video motion-graphics/);
    expect(prompts[1]).toMatch(/bảng khung/);
    expect(fs.existsSync(path.join(core.store.dir(p.slug), "out", "video.mp4"))).toBe(true);
  });

  it("a failed coder run marks the project failed with the error", async () => {
    const core = make(async () => ({ ok: false, text: "", costUsd: 0, runId: "r", error: "Hết hạn mức" }));
    const p = core.create({ title: "Demo", brief: "Mô tả" });
    core.startGenerate(p.slug);
    await core.whenIdle(p.slug);
    const cur = core.store.get(p.slug);
    expect(cur.state).toBe("failed");
    expect(cur.error).toBe("Hết hạn mức");
  });

  it("a render error is sent back to the coder, which fixes it", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const flaky = async (o: RenderOptions): Promise<RenderResult> => {
      calls++;
      if (calls === 1) return { ok: false, error: "Trang chưa có __seek(t)" };
      return okRender(o);
    };
    const core = make(async (prompt) => {
      prompts.push(prompt);
      return { ok: true, text: "", costUsd: 0, runId: "r" };
    }, flaky);
    const p = core.create({ title: "Demo", brief: "Mô tả" });
    core.startGenerate(p.slug);
    await core.whenIdle(p.slug);
    expect(core.store.get(p.slug).state).toBe("done");
    expect(prompts.some((x) => /Render bản nháp bị lỗi/.test(x) && /__seek/.test(x))).toBe(true);
  });

  it("revise runs one coder pass then a final render, and refuses a second concurrent job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const core = make(async () => {
      await gate;
      return { ok: true, text: "", costUsd: 0, runId: "r" };
    });
    const p = core.create({ title: "Demo", brief: "Mô tả" });
    core.startRevise(p.slug, "Đổi màu nền sang đỏ");
    expect(() => core.startRevise(p.slug, "x")).toThrow(/đang được xử lý/);
    expect(core.job(p.slug)?.kind).toBe("revise");
    release();
    await core.whenIdle(p.slug);
    expect(core.store.get(p.slug).state).toBe("done");
    expect(core.job(p.slug)).toBeNull();
  });

  it("asks the 3D workshop for the turntable before the coder runs and copies it into assets", async () => {
    const src = path.join(dataDir, "turn.mp4");
    fs.writeFileSync(src, "vid");
    let asked = "";
    const engine = {
      listForApi: () => [],
      detail: () => ({ files: ["outputs/model.glb"] }),
      filePath: () => ({ abs: src }),
      turntable: async (slug: string) => ((asked = slug), { ok: true as const, file: "outputs/turntable.mp4" }),
    };
    const prompts: string[] = [];
    const core = createCodeVideoCore({
      manager,
      dataDir,
      render: okRender,
      sheet: sheetOk as never,
      models3d: engine,
      runner: async (prompt) => (prompts.push(prompt), { ok: true, text: "", costUsd: 0, runId: "r" }),
    });
    const p = core.create({ title: "Cabin", brief: "b", model3dSession: "phien-1" });
    core.startGenerate(p.slug);
    await core.whenIdle(p.slug);
    expect(asked).toBe("phien-1");
    expect(fs.existsSync(path.join(core.store.dir(p.slug), "assets", "cabin-turntable.mp4"))).toBe(true);
    expect(prompts[0]).toMatch(/cabin-turntable\.mp4/);
    expect(core.store.get(p.slug).state).toBe("done");
  });

  it("fails with the 3D workshop's message when the turntable cannot be made", async () => {
    const engine = { listForApi: () => [], detail: () => null, filePath: () => ({ abs: "" }) };
    const core = createCodeVideoCore({ manager, dataDir, render: okRender, sheet: sheetOk as never, models3d: engine, runner: async () => ({ ok: true, text: "", costUsd: 0, runId: "r" }) });
    const p = core.create({ title: "Cabin", brief: "b", model3dSession: "khong-co" });
    core.startGenerate(p.slug);
    await core.whenIdle(p.slug);
    expect(core.store.get(p.slug).state).toBe("failed");
    expect(core.store.get(p.slug).error).toMatch(/phiên dựng 3D/);
  });

  it("recover marks projects left running by a killed process as failed", () => {
    const core = make(async () => ({ ok: true, text: "", costUsd: 0, runId: "r" }));
    const a = core.create({ title: "A", brief: "b" });
    const b = core.create({ title: "B", brief: "b" });
    core.store.setState(a.slug, "rendering");
    expect(core.recover()).toBe(1);
    expect(core.store.get(a.slug).state).toBe("failed");
    expect(core.store.get(a.slug).error).toMatch(/khởi động lại/);
    expect(core.store.get(b.slug).state).toBe("draft");
  });

  it("cancel aborts the job and cancels the run", async () => {
    let cancelled = "";
    const mgr: CvStepManager = { ...manager, cancel: (id) => ((cancelled = id), true) };
    const core = createCodeVideoCore({
      manager: mgr,
      dataDir,
      render: okRender,
      sheet: sheetOk as never,
      runner: async (_p, _d, o) => {
        o?.onRun?.("run-77");
        await new Promise((r) => setTimeout(r, 20));
        return { ok: false, text: "", costUsd: 0, runId: "run-77", error: "bị dừng" };
      },
    });
    const p = core.create({ title: "Demo", brief: "Mô tả" });
    core.startGenerate(p.slug);
    await new Promise((r) => setTimeout(r, 5));
    expect(core.cancel(p.slug)).toBe(true);
    await core.whenIdle(p.slug);
    expect(cancelled).toBe("run-77");
    expect(core.store.get(p.slug).state).toBe("failed");
    expect(core.store.get(p.slug).error).toBe("Đã hủy.");
  });
});
