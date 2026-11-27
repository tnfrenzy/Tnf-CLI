// src/core/codevideo/types.ts
// Shared types of the code-driven Video Studio (tower 5): a project is a folder holding an HTML page that Claude writes.

export type CvState = "draft" | "coding" | "rendering" | "done" | "failed";

export interface CvBrand {
  name: string;
  tagline: string;
  /** Path relative to the project folder (e.g. "assets/logo.svg"). */
  logo: string;
  colors: { primary: string; accent: string; bg: string; text: string };
  fonts: { heading: string; body: string };
  hotline: string;
  website: string;
}

export interface CvProject {
  slug: string;
  title: string;
  state: CvState;
  width: number;
  height: number;
  fps: number;
  /** Target length in seconds. */
  duration: number;
  /** What the user asked for (untrusted text; passed to the coder as data). */
  brief: string;
  /** Last error shown to the user (Vietnamese); absent when fine. */
  error?: string;
  /** Rendered file relative to the project folder, when one exists. */
  video?: string;
  /** Narration/background music file relative to the project folder. */
  audio?: string;
  /** Workshop 3D session whose turntable render is used as footage. */
  model3dSession?: string;
  createdAt: string;
  updatedAt: string;
  /** Sum of the estimated cost of coder runs (informational only; no cap). */
  costUsd: number;
  /** Number of coder rounds so far (create + revisions). */
  rounds: number;
}

export interface CvListItem {
  slug: string;
  title: string;
  state: CvState;
  updatedAt: string;
  width: number;
  height: number;
  duration: number;
  hasVideo: boolean;
}

export interface CvAssetInfo {
  /** Path relative to the project folder, always under assets/. */
  path: string;
  kind: "image" | "video" | "audio" | "font" | "data";
  bytes: number;
}

export class CvError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "CvError";
  }
}

export const CV_DEFAULT_SIZE = { width: 1080, height: 1920, fps: 30, duration: 30 } as const;
export const CV_LIMITS = {
  minDuration: 3,
  maxDuration: 180,
  maxSide: 3840,
  minSide: 240,
  fps: [24, 25, 30, 50, 60] as readonly number[],
  maxBriefChars: 8000,
  maxAssetBytes: 200 * 1024 * 1024,
  maxProjects: 200,
} as const;
