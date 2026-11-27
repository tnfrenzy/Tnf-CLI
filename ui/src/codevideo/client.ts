// Client of /api/codevideo/*. Same token mechanism as ui/src/api.ts: the x-controller-token header, never a URL.
// <video>/<img> cannot send headers, so files are fetched as blobs (fetchBlob) and shown from object URLs.
import { ApiError, downloadFile, fetchBlob, getToken } from "../api";
import { friendlyError, validateAssetFile } from "./logic";
import type { CvAssetInfo, CvBrand, CvListItem, CvProject } from "../../../src/core/codevideo/types";
import type { CvJobView } from "./logic";

export type { CvAssetInfo, CvBrand, CvListItem, CvProject };
export type CvJob = CvJobView & { slug: string };

export interface CvListEntry extends CvListItem {
  job: CvJob | null;
}

export interface CvListResponse {
  projects: CvListEntry[];
  /** Whether a browser and ffmpeg were found (or configured) for rendering. */
  tools: { browser: boolean; ffmpeg: boolean };
}

export type CvDetail = CvProject & { assets: CvAssetInfo[]; job: CvJob | null };

export interface CvSettingsView {
  brand: CvBrand;
  reviewRounds: number;
  browserPath: string | null;
  ffmpegPath: string | null;
}

export interface CvCreateInput {
  title: string;
  brief: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  model3dSession?: string;
}

export interface CvActionResult {
  state: string;
  job: CvJob;
}

const BASE = "/api/codevideo";

export function codeVideoPath(slug: string): string {
  return `${BASE}/${encodeURIComponent(slug)}`;
}

/** URL of a project file (only out/ and assets/ are served). It carries no token: load it with codeVideoFileBlob. */
export function codeVideoFilePath(slug: string, rel: string): string {
  return `${codeVideoPath(slug)}/file?path=${encodeURIComponent(rel)}`;
}

/** URL of the rendered video as a download (also needs the header token: use downloadCodeVideo). */
export function codeVideoDownloadPath(slug: string): string {
  return `${codeVideoPath(slug)}/download`;
}

async function failure(r: Response): Promise<ApiError> {
  const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
  return new ApiError(friendlyError(r.status, j.message), r.status, j.error);
}

async function request<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-controller-token": getToken() ?? "" };
  const opts: RequestInit = { method: init.method ?? "GET", headers };
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(init.json);
  }
  let r: Response;
  try {
    r = await fetch(path, opts);
  } catch {
    throw new ApiError(friendlyError(undefined, "Không kết nối được tới máy chủ."), 0, "network");
  }
  if (!r.ok) throw await failure(r);
  return (await r.json()) as T;
}

export const codeVideoApi = {
  list: (): Promise<CvListResponse> => request<CvListResponse>(BASE),
  create: (input: CvCreateInput): Promise<CvProject> => request<CvProject>(BASE, { method: "POST", json: input }),
  get: (slug: string): Promise<CvDetail> => request<CvDetail>(codeVideoPath(slug)),
  remove: (slug: string): Promise<{ ok: boolean }> => request<{ ok: boolean }>(codeVideoPath(slug), { method: "DELETE" }),
  generate: (slug: string): Promise<CvActionResult> => request<CvActionResult>(`${codeVideoPath(slug)}/generate`, { method: "POST", json: {} }),
  revise: (slug: string, instruction: string): Promise<CvActionResult> => request<CvActionResult>(`${codeVideoPath(slug)}/revise`, { method: "POST", json: { instruction } }),
  render: (slug: string): Promise<CvActionResult> => request<CvActionResult>(`${codeVideoPath(slug)}/render`, { method: "POST", json: {} }),
  cancel: (slug: string): Promise<{ cancelled: boolean }> => request<{ cancelled: boolean }>(`${codeVideoPath(slug)}/cancel`, { method: "POST", json: {} }),
  /** Raw body upload; the name travels encoded in x-file-name. */
  async uploadAsset(slug: string, file: File): Promise<CvAssetInfo> {
    const bad = validateAssetFile(file.name, file.size);
    if (bad) throw new ApiError(bad, 400, "bad_file");
    let r: Response;
    try {
      r = await fetch(`${codeVideoPath(slug)}/assets`, {
        method: "POST",
        headers: { "x-controller-token": getToken() ?? "", "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
    } catch {
      throw new ApiError(friendlyError(undefined, "Không kết nối được tới máy chủ."), 0, "network");
    }
    if (!r.ok) throw await failure(r);
    return (await r.json()) as CvAssetInfo;
  },
  models3d: (): Promise<{ models: Array<{ session: string; title: string; hasTurntable: boolean; updatedAt: string }> }> => request(`${BASE}/models3d`),
  getSettings: (): Promise<CvSettingsView> => request<CvSettingsView>(`${BASE}/settings`),
  putSettings: (patch: Partial<CvSettingsView>): Promise<CvSettingsView> => request<CvSettingsView>(`${BASE}/settings`, { method: "PUT", json: patch }),
};

/** A project file as a Blob (token in the header), for <video>/<img> object URLs. */
export function codeVideoFileBlob(slug: string, rel: string): Promise<Blob> {
  return fetchBlob(codeVideoFilePath(slug, rel));
}

/** Saves the rendered video through the browser. */
export function downloadCodeVideo(slug: string, fileName: string): Promise<void> {
  return downloadFile(codeVideoDownloadPath(slug), fileName);
}
