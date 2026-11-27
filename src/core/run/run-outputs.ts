import fs from "node:fs";
import path from "node:path";
import { loadAppSettings, saveAppSettings } from "../app/app-settings.js";
import { defaultOutputDir, resolveInside, syncRunOutputs, validateOutputDir } from "../app/outputs.js";
import { validateInboxName } from "./inbox.js";
import { defaultOpenDirectory, defaultOpenPath, type OpenDirTarget } from "./run-support.js";
import type { RunHost } from "./run-host.js";

export type OutputsHost = Pick<RunHost, "config" | "store" | "openDirectory" | "openPath">;

/** The output folder (AI-made, non-code files mirrored out of run dirs) and the "open in Explorer" actions. */
export class RunOutputs {
  constructor(private readonly host: OutputsHost) {}

  /**
   * UI "Mở trong Explorer": only the two directories recorded in the DB for this run are ever opened; the path never
   * comes from the request. Returns the opened path.
   */
  openDir(runId: string, target: OpenDirTarget): string {
    const run = this.host.store.getRun(runId);
    if (!run) throw new Error("Không tìm thấy lần chạy.");
    const dir = target === "worktree" ? run.worktree_path : run.run_dir;
    if (!dir) throw new Error("Lần chạy này không có worktree.");
    if (!path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Thư mục không còn tồn tại: ${dir}`);
    (this.host.openDirectory ?? defaultOpenDirectory)(dir);
    return dir;
  }

  /** Where AI-made (non-code) files are collected: Settings value, else <workspace>/outputs. */
  outputDir(): string {
    return loadAppSettings(this.host.config.dataDir).outputDir ?? defaultOutputDir(this.host.config.workspaceDir);
  }

  setOutputDir(p: string): string {
    const v = validateOutputDir(p);
    saveAppSettings(this.host.config.dataDir, { outputDir: v });
    return v;
  }

  /** Mirror a run's artifacts into the output folder (best-effort, never throws). */
  syncOutputs(runId: string): number {
    try {
      const run = this.host.store.getRun(runId);
      if (!run) return 0;
      return syncRunOutputs(run.run_dir, this.outputDir(), runId, this.host.store.getArtifacts(runId));
    } catch {
      return 0;
    }
  }

  /** UI "Mở tệp": the path comes from the DB + a checked relative path, never from the request. */
  openOutput(runId: string, rel?: string): string {
    const run = this.host.store.getRun(runId);
    if (!run) throw new Error("Không tìm thấy lần chạy.");
    this.host.store.scanArtifacts(runId, run.run_dir);
    this.syncOutputs(runId);
    const dir = path.join(this.outputDir(), runId);
    if (!fs.existsSync(dir)) throw new Error("Lần chạy này chưa có tệp nào để mở.");
    const open = this.host.openPath ?? defaultOpenPath;
    if (rel) {
      const file = resolveInside(dir, rel);
      if (!file || !fs.existsSync(file)) throw new Error("Không tìm thấy tệp trong thư mục lưu.");
      open({ dir, select: file });
      return file;
    }
    open({ dir });
    return dir;
  }

  /** Save a file made outside a run (skill training exports) under `<outputDir>/<group>/<name>` and highlight it. */
  saveOutputFile(group: string, name: string, data: Buffer): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,60}(\/[a-z0-9][a-z0-9_-]{0,60})?$/.test(group)) throw new Error("Nhóm thư mục không hợp lệ.");
    const bad = validateInboxName(name);
    if (bad) throw new Error(bad);
    const dir = path.join(this.outputDir(), ...group.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    (this.host.openPath ?? defaultOpenPath)({ dir, select: file });
    return file;
  }
}
