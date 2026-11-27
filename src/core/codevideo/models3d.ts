// src/core/codevideo/models3d.ts — thin bridge to the 3D workshop: the Video Studio never runs Blender itself.
// The 3D workshop (building 3) renders `outputs/turntable.mp4` of a session; here we list the sessions that have a model and
// copy that video into a project as `assets/cabin-turntable.mp4`. The engine is passed in (structural type) so tests use a fake.
import fs from "node:fs";
import path from "node:path";

export const CABIN_TURNTABLE_ASSET = "cabin-turntable.mp4";
const TURNTABLE_RELS = ["outputs/turntable.mp4", "outputs/turntable.webm"];
const MODEL_RELS = ["outputs/model-blender.glb", "outputs/model.glb"];
const POLL_MS = 1500;

export interface Models3dProgress {
  phase: string;
  done: number;
  total: number;
}

/** The part of the 3D workshop engine this bridge needs. */
export interface Models3dEngine {
  listForApi(): Array<{ slug: string; title: string; updatedAt: number }>;
  detail(slug: string): { files: string[]; turntable?: { running: boolean; phase: string; done: number; total: number } | null } | null;
  filePath(slug: string, rel: string): { abs: string };
  turntable?(slug: string, opts?: { width?: number; height?: number; durationSec?: number; fps?: number; background?: string | null; signal?: AbortSignal }): Promise<{ ok: true; file: string } | { ok: false; error: string }>;
}

export interface Model3dInfo {
  session: string;
  title: string;
  /** Model file the render uses (the Blender-baked GLB when present). */
  glb: string;
  hasTurntable: boolean;
  updatedAt: string;
}

/** Sessions that have a GLB, newest first. */
export function listModels3d(engine: Models3dEngine): Model3dInfo[] {
  const out: Model3dInfo[] = [];
  let items: ReturnType<Models3dEngine["listForApi"]> = [];
  try {
    items = engine.listForApi();
  } catch {
    return [];
  }
  for (const it of items) {
    let d: ReturnType<Models3dEngine["detail"]> = null;
    try {
      d = engine.detail(it.slug);
    } catch {
      continue;
    }
    const glb = d ? MODEL_RELS.find((r) => d.files.includes(r)) : undefined;
    if (!d || !glb) continue;
    out.push({ session: it.slug, title: it.title, glb, hasTurntable: TURNTABLE_RELS.some((r) => d.files.includes(r)), updatedAt: new Date(it.updatedAt).toISOString() });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface EnsureTurntableOptions {
  width?: number;
  height?: number;
  durationSec?: number;
  background?: string | null;
  /** Re-render even when the session already has a turntable. */
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: Models3dProgress) => void;
}

export type EnsureTurntableResult = { ok: true; file: string; rendered: boolean } | { ok: false; error: string; cancelled?: boolean };

/**
 * Makes `<projectDir>/assets/cabin-turntable.mp4` from the 3D session: when the session has no outputs/turntable.mp4 yet
 * (or `force`), asks the 3D workshop to render it and waits; then copies it. Never throws.
 */
export async function ensureTurntable(engine: Models3dEngine, slug: string, projectDir: string, opts: EnsureTurntableOptions = {}): Promise<EnsureTurntableResult> {
  try {
    const d = engine.detail(slug);
    if (!d) return { ok: false, error: "Không tìm thấy phiên dựng 3D." };
    if (!MODEL_RELS.some((r) => d.files.includes(r))) return { ok: false, error: "Phiên dựng 3D này chưa có mô hình để quay tròn." };
    let rendered = false;
    let rel = TURNTABLE_RELS.find((r) => d.files.includes(r));
    if (opts.force || !rel) {
      if (!engine.turntable) return { ok: false, error: "Xưởng dựng 3D chưa có bước render video quay tròn." };
      let poll: NodeJS.Timeout | null = null;
      if (opts.onProgress) {
        poll = setInterval(() => {
          try {
            const t = engine.detail(slug)?.turntable;
            if (t) opts.onProgress?.({ phase: t.phase, done: t.done, total: t.total });
          } catch {
            /* progress is best effort */
          }
        }, POLL_MS);
      }
      const { force: _force, onProgress: _onProgress, signal, ...render } = opts;
      void _force;
      void _onProgress;
      try {
        const r = await engine.turntable(slug, { ...render, ...(signal ? { signal } : {}) });
        if (!r.ok) return { ok: false, error: r.error, ...(opts.signal?.aborted ? { cancelled: true } : {}) };
        rendered = true;
        rel = r.file;
      } finally {
        if (poll) clearInterval(poll);
      }
    }
    if (opts.signal?.aborted) return { ok: false, error: "Đã hủy.", cancelled: true };
    if (!rel) return { ok: false, error: "Không thấy video quay tròn sau khi render." };
    const src = engine.filePath(slug, rel).abs;
    const destDir = path.join(projectDir, "assets");
    fs.mkdirSync(destDir, { recursive: true });
    const assetName = rel.endsWith(".webm") ? "cabin-turntable.webm" : CABIN_TURNTABLE_ASSET;
    const dest = path.join(destDir, assetName);
    const tmp = `${dest}.tmp`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
    return { ok: true, file: `assets/${assetName}`, rendered };
  } catch (e) {
    return { ok: false, error: `Không lấy được video quay tròn từ Xưởng 3D: ${e instanceof Error ? e.message.slice(0, 200) : "lỗi không rõ"}` };
  }
}
