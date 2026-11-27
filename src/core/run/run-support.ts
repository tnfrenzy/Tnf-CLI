import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { explorerArgs } from "../app/outputs.js";
import type { PreviewJson } from "../preview/preview.js";

export type PreviewState = { status: "idle" | "running" | "ok" | "partial" | "error"; step: string | null; result: PreviewJson | null };

/** Thrown by followupWithComments only when the comments fail validation. */
export class CommentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommentsError";
  }
}

export class PreviewError extends Error {
  constructor(public code: "not_found" | "bad_request" | "forbidden" | "conflict", message: string) {
    super(message);
    this.name = "PreviewError";
  }
}

export type OpenDirTarget = "run_dir" | "worktree";

export function defaultOpenDirectory(dir: string): void {
  const exe = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(exe, [dir], { shell: false, detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => { /* reported to the caller only via the returned path; Explorer failures are not fatal */ });
  child.unref();
}

export function defaultOpenPath(a: { dir: string; select?: string }): void {
  const win = process.platform === "win32";
  const exe = win ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = win && a.select ? explorerArgs(a.select, true) : [a.dir];
  const child = spawn(exe, args, { shell: false, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: win && !!a.select });
  child.on("error", () => { /* non-fatal */ });
  child.unref();
}

export function makeRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${randomUUID().slice(0, 6)}`;
}
