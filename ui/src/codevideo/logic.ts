// Pure helpers of the code-driven Video Studio UI (tower 5): labels, progress, formatting and form validation.
// Every user-visible string goes through pick(vi, en) at the moment it is built, so the English UI never shows Vietnamese.
import { pick } from "../lib/lang";
import { CV_LIMITS } from "../../../src/core/codevideo/types";
import type { CvState } from "../../../src/core/codevideo/types";

/** Phase of a running job (mirrors CvPhase in src/core/codevideo/core.ts). */
export type CvJobPhase = "coding" | "draft" | "review" | "final" | "done";

/** The part of a job the UI needs. */
export interface CvJobView {
  kind: "generate" | "revise" | "render";
  phase: CvJobPhase;
  startedAt: string;
  done: number;
  total: number;
  round: number;
}

export interface FramePreset {
  id: "portrait" | "landscape" | "square";
  width: number;
  height: number;
}

export const FRAME_PRESETS: readonly FramePreset[] = [
  { id: "portrait", width: 1080, height: 1920 },
  { id: "landscape", width: 1920, height: 1080 },
  { id: "square", width: 1080, height: 1080 },
];

export const FPS_CHOICES: readonly number[] = CV_LIMITS.fps;
export const MIN_DURATION = CV_LIMITS.minDuration;
export const MAX_DURATION = CV_LIMITS.maxDuration;
export const MAX_TITLE = 80;
export const MAX_BRIEF = CV_LIMITS.maxBriefChars;
export const MAX_ASSET_BYTES = CV_LIMITS.maxAssetBytes;

export function presetLabel(id: FramePreset["id"]): string {
  if (id === "portrait") return pick("Dọc 1080x1920", "Portrait 1080x1920");
  if (id === "landscape") return pick("Ngang 1920x1080", "Landscape 1920x1080");
  return pick("Vuông 1080x1080", "Square 1080x1080");
}

/** The preset that matches a frame size, or null for a custom size. */
export function presetOf(width: number, height: number): FramePreset["id"] | null {
  return FRAME_PRESETS.find((p) => p.width === width && p.height === height)?.id ?? null;
}

export interface CreateForm {
  title: string;
  brief: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
}

/** Message for the first problem of the create form, or null when it can be submitted. */
export function validateCreateForm(f: CreateForm): string | null {
  const title = f.title.trim();
  if (!title) return pick("Hãy nhập tiêu đề video.", "Enter a video title.");
  if (title.length > MAX_TITLE) return pick(`Tiêu đề tối đa ${MAX_TITLE} ký tự.`, `The title can have at most ${MAX_TITLE} characters.`);
  const brief = f.brief.trim();
  if (!brief) return pick("Hãy mô tả video bạn muốn.", "Describe the video you want.");
  if (brief.length > MAX_BRIEF) return pick(`Mô tả tối đa ${MAX_BRIEF} ký tự.`, `The description can have at most ${MAX_BRIEF} characters.`);
  if (!Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width < CV_LIMITS.minSide || f.height < CV_LIMITS.minSide || f.width > CV_LIMITS.maxSide || f.height > CV_LIMITS.maxSide) {
    return pick(`Cỡ khung mỗi cạnh phải từ ${CV_LIMITS.minSide} đến ${CV_LIMITS.maxSide} điểm ảnh.`, `Each side of the frame must be ${CV_LIMITS.minSide} to ${CV_LIMITS.maxSide} pixels.`);
  }
  if (!Number.isFinite(f.duration) || f.duration < MIN_DURATION || f.duration > MAX_DURATION) {
    return pick(`Thời lượng phải từ ${MIN_DURATION} đến ${MAX_DURATION} giây.`, `The duration must be ${MIN_DURATION} to ${MAX_DURATION} seconds.`);
  }
  if (!FPS_CHOICES.includes(f.fps)) return pick(`Số khung hình/giây phải là một trong: ${FPS_CHOICES.join(", ")}.`, `Frames per second must be one of: ${FPS_CHOICES.join(", ")}.`);
  return null;
}

/** Message for an asset file that cannot be uploaded, or null. */
export function validateAssetFile(name: string, bytes: number): string | null {
  if (!name.trim()) return pick("Tệp không có tên.", "The file has no name.");
  if (bytes <= 0) return pick("Tệp rỗng.", "The file is empty.");
  if (bytes > MAX_ASSET_BYTES) return pick("Tệp quá lớn (tối đa 200 MB).", "The file is too large (200 MB max).");
  return null;
}

export function stateLabel(state: CvState | string): string {
  switch (state) {
    case "draft":
      return pick("Bản nháp", "Draft");
    case "coding":
      return pick("Claude đang viết", "Claude is writing");
    case "rendering":
      return pick("Đang dựng", "Rendering");
    case "done":
      return pick("Hoàn tất", "Done");
    case "failed":
      return pick("Lỗi", "Failed");
    default:
      return String(state);
  }
}

export function isBusyState(state: CvState | string): boolean {
  return state === "coding" || state === "rendering";
}

/** Label of what a running job is doing right now. */
export function phaseLabel(job: Pick<CvJobView, "kind" | "phase" | "round">): string {
  switch (job.phase) {
    case "coding":
      return job.kind === "revise" ? pick("Claude đang sửa video theo yêu cầu", "Claude is revising the video") : pick("Claude đang viết trang video", "Claude is writing the video page");
    case "draft":
      return pick("Đang dựng bản nháp để kiểm tra", "Rendering a draft to check");
    case "review":
      return pick(`Claude xem bảng khung và tự sửa (vòng ${job.round + 1})`, `Claude is reviewing the frame sheet and fixing it (round ${job.round + 1})`);
    case "final":
      return pick("Đang dựng bản cuối", "Rendering the final video");
    default:
      return pick("Sắp xong", "Almost done");
  }
}

/** Render percent 0-100 for the phases that render frames; null when the phase has no frame count (Claude is working). */
export function jobPercent(job: Pick<CvJobView, "phase" | "done" | "total">): number | null {
  if (job.phase !== "draft" && job.phase !== "final") return null;
  if (!(job.total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((job.done / job.total) * 100)));
}

/** One-line progress text, e.g. "Rendering the final video - 42% (126/300 frames)". */
export function jobProgressText(job: CvJobView): string {
  const base = phaseLabel(job);
  const pct = jobPercent(job);
  if (pct === null) return base;
  return pick(`${base} - ${pct}% (${job.done}/${job.total} khung)`, `${base} - ${pct}% (${job.done}/${job.total} frames)`);
}

/** Seconds as m:ss (or h:mm:ss from one hour). */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** Elapsed time since an ISO start, as m:ss; "0:00" for a bad date. */
export function elapsedSince(startedAt: string, now: number): string {
  const t = Date.parse(startedAt);
  return formatDuration(Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : 0);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Estimated cost, for viewing only (there is no cap). */
export function formatCost(usd: number): string {
  const v = Number.isFinite(usd) && usd > 0 ? usd : 0;
  return `~$${v.toFixed(v >= 10 ? 1 : 2)}`;
}

export function frameSizeText(width: number, height: number, fps?: number): string {
  return fps ? `${width}x${height} @ ${fps} fps` : `${width}x${height}`;
}

export function assetKindLabel(kind: string): string {
  switch (kind) {
    case "image":
      return pick("Ảnh", "Image");
    case "video":
      return pick("Video", "Video");
    case "audio":
      return pick("Âm thanh", "Audio");
    case "font":
      return pick("Phông", "Font");
    default:
      return pick("Dữ liệu", "Data");
  }
}

/** Sheets the coder writes, newest round first: the room shows the first one that exists. */
export function sheetCandidates(): string[] {
  const n = 3; // reviewRounds is at most 3
  return Array.from({ length: n }, (_, i) => `out/sheet-${n - i}.png`);
}

/**
 * Message for a failed call. Server messages are Vietnamese, so the English UI uses a generic text by status instead;
 * the Vietnamese UI shows the server message as is.
 */
export function friendlyError(status: number | undefined, serverMessage: string | undefined): string {
  const en =
    status === 401
      ? "Not signed in. Open the app through the link with the token."
      : status === 403
        ? "This action is not allowed from here."
        : status === 404
          ? "Not found. The project may have been deleted."
          : status === 409
            ? "The project is busy. Cancel the running job first."
            : status === 413
              ? "The content is too large."
              : status === 503
                ? "The video studio is not ready yet."
                : status !== undefined && status >= 500
                  ? "Internal error in the video studio."
                  : "The request failed. Check the input and try again.";
  const vi = serverMessage && serverMessage.trim() ? serverMessage.trim() : "Yêu cầu không thành công. Hãy kiểm tra dữ liệu và thử lại.";
  return pick(vi, en);
}

/** The last error stored in a project (Vietnamese, from the server) as shown to the current language. */
export function projectErrorText(error: string): string {
  return pick(error, "The last run failed. Fix the request below and try again, or rebuild.");
}
