/** Pure logic of the "Video quay tròn" block of the 3D workshop room (no React, no network). */
import { curLang } from "../../lib/lang";
import type { Workshop3DTurntable, Workshop3DTurntableOptions } from "../../types";

export const TURNTABLE_MP4 = "outputs/turntable.mp4";
export const TURNTABLE_WEBM = "outputs/turntable.webm";
export const TURNTABLE_MIN_SEC = 4;
export const TURNTABLE_MAX_SEC = 12;
export const TURNTABLE_DEFAULT_SEC = 8;
export const TURNTABLE_SIZES = [540, 1080] as const;
export type TurntableSize = (typeof TURNTABLE_SIZES)[number];

export interface TurntableForm {
  /** false = brand colour (server default), true = transparent (WebM with alpha). */
  transparent: boolean;
  size: TurntableSize;
  durationSec: number;
}

export const DEFAULT_TURNTABLE_FORM: TurntableForm = { transparent: false, size: 540, durationSec: TURNTABLE_DEFAULT_SEC };

/** Duration typed by the user -> whole seconds inside 4..12 (NaN / empty -> default). */
export function clampDuration(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return TURNTABLE_DEFAULT_SEC;
  return Math.min(TURNTABLE_MAX_SEC, Math.max(TURNTABLE_MIN_SEC, Math.round(n)));
}

/** Request body of POST /api/workshop3d/<slug>/turntable. The brand colour is the server default, so it is simply omitted. */
export function turntableBody(f: TurntableForm): Workshop3DTurntableOptions {
  const body: Workshop3DTurntableOptions = { width: f.size, height: f.size, durationSec: clampDuration(f.durationSec) };
  if (f.transparent) body.background = null;
  return body;
}

export function turntableRunning(tt: Workshop3DTurntable | null | undefined): boolean {
  return !!tt && tt.running === true;
}

export type TurntableStatus =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "render"; done: number; total: number; percent: number }
  | { kind: "encode"; percent: number };

/** What the progress bar shows while a render runs (idle otherwise). Render takes 0-95 %, encoding the rest. */
export function turntableStatus(tt: Workshop3DTurntable | null | undefined): TurntableStatus {
  if (!tt || tt.running !== true) return { kind: "idle" };
  if (tt.phase === "encode") return { kind: "encode", percent: 97 };
  const total = typeof tt.total === "number" && tt.total > 0 ? tt.total : 0;
  const done = typeof tt.done === "number" && tt.done > 0 ? Math.min(tt.done, total) : 0;
  if (total === 0) return { kind: "preparing" };
  return { kind: "render", done, total, percent: Math.round((done / total) * 95) };
}

/** The finished video listed in the session files (mp4 first), or null. */
export function turntableFile(files: readonly unknown[] | undefined): string | null {
  const list = Array.isArray(files) ? files : [];
  if (list.includes(TURNTABLE_MP4)) return TURNTABLE_MP4;
  if (list.includes(TURNTABLE_WEBM)) return TURNTABLE_WEBM;
  return null;
}

/**
 * Why the server cannot render now, for the panel: null when ready or unknown (older server: turntableReady undefined).
 * The server's reason is Vietnamese, so the English UI (and a missing reason) shows `generic`, the dictionary sentence.
 */
export function turntableBlockReason(ready: boolean | undefined, why: string | undefined, generic: string): string | null {
  if (ready !== false) return null;
  return curLang() === "vi" && why && why.trim() ? why : generic;
}

/** The render needs the GLB model (the server answers 409 with a Vietnamese message when Blender is missing). */
export function turntableCanStart(files: readonly unknown[] | undefined, running: boolean, busy: boolean, ready?: boolean): boolean {
  if (ready === false) return false;
  const list = Array.isArray(files) ? files : [];
  const hasGlb = list.some((f) => typeof f === "string" && /^outputs\/model(-blender|-mobile)?\.glb$/.test(f));
  return hasGlb && !running && !busy;
}
