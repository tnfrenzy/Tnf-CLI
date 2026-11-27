// src/core/codevideo/core.ts
// Orchestrates a code-driven video: coder run -> draft render -> contact sheet -> self-review -> final render.
import fs from "node:fs";
import path from "node:path";
import {
  buildCreatePrompt,
  buildFixPrompt,
  buildReviewPrompt,
  buildRevisePrompt,
  createCvAgentRunner,
  type CvAgentRunner,
  type CvStepManager,
} from "./agent.js";
import { ensureTurntable, type Models3dEngine } from "./models3d.js";
import { makeContactSheet, renderProject, type RenderOptions, type RenderResult } from "./render/index.js";
import { createCvSettingsStore, type CvSettingsStore } from "./settings.js";
import { createCvStore, type CvCreateInput, type CvStore } from "./store.js";
import { CvError } from "./types.js";
import type { CvProject } from "./types.js";

export type CvJobKind = "generate" | "revise" | "render";
export type CvPhase = "model3d" | "coding" | "draft" | "review" | "final" | "done";

export interface CvJob {
  slug: string;
  kind: CvJobKind;
  phase: CvPhase;
  startedAt: string;
  /** Frames rendered so far in the current render phase (0 when not rendering). */
  done: number;
  total: number;
  /** Number of draft/review rounds finished. */
  round: number;
}

export interface CvCoreOptions {
  manager: CvStepManager;
  dataDir: string;
  log?: (msg: string) => void;
  /** Test seams. */
  runner?: CvAgentRunner;
  render?: (o: RenderOptions) => Promise<RenderResult>;
  sheet?: typeof makeContactSheet;
  /** The 3D workshop (building 3): a project with a 3D session gets its turntable video from there. */
  models3d?: Models3dEngine | null;
}

export interface CvCore {
  store: CvStore;
  settings: CvSettingsStore;
  models3d: Models3dEngine | null;
  dataDir: string;
  create(input: CvCreateInput): CvProject;
  startGenerate(slug: string): CvJob;
  startRevise(slug: string, instruction: string): CvJob;
  startRender(slug: string): CvJob;
  cancel(slug: string): boolean;
  job(slug: string): CvJob | null;
  /** Resolves when the job of this slug finishes (for tests and shutdown). */
  whenIdle(slug: string): Promise<void>;
  /** After a restart: projects left in coding/rendering by a killed process become failed (nothing is running). */
  recover(): number;
}

const SHEET_FRAMES = 8;
const FIX_ATTEMPTS = 2;

export function createCodeVideoCore(opts: CvCoreOptions): CvCore {
  const log = opts.log ?? (() => undefined);
  const store = createCvStore(opts.dataDir);
  const settings = createCvSettingsStore(opts.dataDir);
  const runner = opts.runner ?? createCvAgentRunner(opts.manager);
  const render = opts.render ?? renderProject;
  const sheet = opts.sheet ?? makeContactSheet;

  const jobs = new Map<string, CvJob>();
  const finished = new Map<string, Promise<void>>();
  const controllers = new Map<string, { abort: AbortController; runId: string }>();
  // Rendering is CPU/GPU heavy: one render at a time across all projects.
  let renderChain: Promise<unknown> = Promise.resolve();
  const withRenderLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = renderChain.then(fn, fn);
    renderChain = p.catch(() => undefined);
    return p;
  };

  const sheetTimes = (duration: number): number[] => Array.from({ length: SHEET_FRAMES }, (_, i) => Math.min(duration - 0.05, ((i + 0.5) / SHEET_FRAMES) * duration));

  const toolPaths = (): { browserPath?: string; ffmpegPath?: string } => {
    const s = settings.get();
    return { ...(s.browserPath ? { browserPath: s.browserPath } : {}), ...(s.ffmpegPath ? { ffmpegPath: s.ffmpegPath } : {}) };
  };

  const check = (slug: string): { job: CvJob | undefined; signal: AbortSignal } => ({ job: jobs.get(slug), signal: controllers.get(slug)!.abort.signal });

  async function renderOnce(slug: string, quality: "draft" | "final"): Promise<RenderResult> {
    const p = store.get(slug);
    const dir = store.dir(slug);
    const job = jobs.get(slug)!;
    const outFile = path.join(dir, "out", quality === "draft" ? "draft.mp4" : "video.mp4");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const audio = p.audio ? store.resolveInside(slug, p.audio) : undefined;
    store.setState(slug, "rendering");
    return withRenderLock(() =>
      render({
        projectDir: dir,
        outFile,
        width: p.width,
        height: p.height,
        fps: p.fps,
        durationSec: p.duration,
        ...(audio && fs.existsSync(audio) ? { audioFile: audio } : {}),
        quality,
        signal: check(slug).signal,
        onProgress: (done, total) => {
          job.done = done;
          job.total = total;
        },
        ...toolPaths(),
      }),
    );
  }

  async function runCoder(slug: string, prompt: string): Promise<{ ok: boolean; error?: string }> {
    const ctl = controllers.get(slug)!;
    store.setState(slug, "coding");
    const r = await runner(prompt, store.dir(slug), { onRun: (id) => (ctl.runId = id) });
    const cur = store.get(slug);
    store.update(slug, { costUsd: cur.costUsd + r.costUsd, rounds: cur.rounds + 1 });
    if (!r.ok) return { ok: false, error: r.error ?? "Claude không hoàn tất lượt viết mã." };
    return { ok: true };
  }

  /** Draft render with up to FIX_ATTEMPTS coder fixes when the page fails to render. */
  async function renderDraftWithFixes(slug: string): Promise<{ ok: true } | { ok: false; error: string }> {
    for (let attempt = 0; ; attempt++) {
      const job = jobs.get(slug)!;
      job.phase = "draft";
      job.done = 0;
      const r = await renderOnce(slug, "draft");
      if (r.ok) return { ok: true };
      if (check(slug).signal.aborted) return { ok: false, error: "Đã hủy." };
      if (attempt >= FIX_ATTEMPTS) return { ok: false, error: r.error };
      log(`codevideo ${slug}: render nháp lỗi, nhờ Claude sửa (lần ${attempt + 1}): ${r.error.slice(0, 200)}`);
      job.phase = "coding";
      const fixed = await runCoder(slug, buildFixPrompt(store.get(slug), store.dir(slug), r.error));
      if (!fixed.ok) return { ok: false, error: fixed.error ?? r.error };
    }
  }

  async function pipeline(slug: string, kind: CvJobKind, instruction: string | null): Promise<void> {
    const job = jobs.get(slug)!;
    const fail = (error: string): void => {
      store.setState(slug, "failed", error);
    };
    try {
      let p = store.get(slug);
      const dir = store.dir(slug);
      if (kind === "generate" && p.model3dSession && opts.models3d) {
        job.phase = "model3d";
        const t = await ensureTurntable(opts.models3d, p.model3dSession, dir, {
          width: 1080,
          height: 1080,
          signal: check(slug).signal,
          onProgress: (pr) => {
            job.done = pr.done;
            job.total = pr.total;
          },
        });
        if (!t.ok) return fail(t.cancelled ? "Đã hủy." : t.error);
        job.done = 0;
        job.total = 0;
        job.phase = "coding";
      }
      if (kind !== "render") {
        const assets = store.listAssets(slug);
        const prompt =
          kind === "generate"
            ? buildCreatePrompt(p, dir, assets, fs.existsSync(path.join(dir, "assets", "cabin-turntable.mp4")))
            : buildRevisePrompt(p, dir, instruction ?? "", assets);
        const coded = await runCoder(slug, prompt);
        if (!coded.ok) return fail(check(slug).signal.aborted ? "Đã hủy." : coded.error!);
        if (check(slug).signal.aborted) return fail("Đã hủy.");

        const rounds = kind === "generate" ? settings.get().reviewRounds : 0;
        for (let i = 0; i < rounds; i++) {
          const d = await renderDraftWithFixes(slug);
          if (!d.ok) return fail(d.error);
          p = store.get(slug);
          const sheetRel = `out/sheet-${i + 1}.png`;
          const times = sheetTimes(p.duration);
          const s = await sheet({
            videoOrFramesDir: path.join(dir, "out", "draft.mp4"),
            times,
            cols: 4,
            thumbWidth: Math.round(Math.min(480, p.width / 2)),
            outFile: path.join(dir, sheetRel),
            ...(toolPaths().ffmpegPath ? { ffmpegPath: toolPaths().ffmpegPath! } : {}),
          });
          if (!s.ok) {
            log(`codevideo ${slug}: không tạo được bảng khung: ${s.error}`);
            break;
          }
          job.phase = "review";
          const rev = await runCoder(slug, buildReviewPrompt(p, dir, sheetRel, times));
          if (!rev.ok) return fail(check(slug).signal.aborted ? "Đã hủy." : rev.error!);
          job.round = i + 1;
        }
      }
      job.phase = "final";
      job.done = 0;
      for (let attempt = 0; ; attempt++) {
        const r = await renderOnce(slug, "final");
        if (r.ok) break;
        if (check(slug).signal.aborted) return fail("Đã hủy.");
        if (attempt >= FIX_ATTEMPTS || kind === "render") return fail(r.error);
        job.phase = "coding";
        const fixed = await runCoder(slug, buildFixPrompt(store.get(slug), store.dir(slug), r.error));
        if (!fixed.ok) return fail(fixed.error ?? r.error);
        job.phase = "final";
      }
      store.update(slug, { video: "out/video.mp4" });
      store.setState(slug, "done");
      job.phase = "done";
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  function start(slug: string, kind: CvJobKind, instruction: string | null): CvJob {
    store.get(slug);
    if (jobs.has(slug)) throw new CvError("Dự án này đang được xử lý.", 409);
    const job: CvJob = { slug, kind, phase: kind === "render" ? "final" : "coding", startedAt: new Date().toISOString(), done: 0, total: 0, round: 0 };
    jobs.set(slug, job);
    controllers.set(slug, { abort: new AbortController(), runId: "" });
    const run = pipeline(slug, kind, instruction).finally(() => {
      jobs.delete(slug);
      controllers.delete(slug);
      finished.delete(slug);
    });
    finished.set(slug, run);
    return job;
  }

  return {
    store,
    settings,
    models3d: opts.models3d ?? null,
    dataDir: opts.dataDir,
    create: (input) => store.create(input, settings.get().brand),
    startGenerate: (slug) => start(slug, "generate", null),
    startRevise(slug, instruction) {
      const text = (instruction ?? "").trim();
      if (!text) throw new CvError("Hãy nhập yêu cầu sửa.", 400);
      if (text.length > 4000) throw new CvError("Yêu cầu sửa quá dài (tối đa 4000 ký tự).", 400);
      return start(slug, "revise", text);
    },
    startRender: (slug) => start(slug, "render", null),
    cancel(slug) {
      const ctl = controllers.get(slug);
      if (!ctl) return false;
      ctl.abort.abort();
      if (ctl.runId) opts.manager.cancel(ctl.runId);
      return true;
    },
    recover() {
      let n = 0;
      for (const item of store.list()) {
        if ((item.state === "coding" || item.state === "rendering") && !jobs.has(item.slug)) {
          store.setState(item.slug, "failed", "Việc dựng bị ngắt do ứng dụng khởi động lại. Hãy bấm dựng lại.");
          n++;
        }
      }
      return n;
    },
    job: (slug) => jobs.get(slug) ?? null,
    whenIdle: (slug) => finished.get(slug) ?? Promise.resolve(),
  };
}
