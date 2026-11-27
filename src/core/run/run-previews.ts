import fs from "node:fs";
import path from "node:path";
import { resolveInside } from "../app/outputs.js";
import { validatePreview, type PreviewConfig } from "../preview/preview-config.js";
import { defaultPreviewDeps, readPreviewJson, runPreview, type PreviewJson } from "../preview/preview.js";
import { PreviewError, type PreviewState } from "./run-support.js";
import type { RunHost } from "./run-host.js";

export type PreviewHost = Pick<RunHost, "config" | "store" | "previewDeps" | "getGrants" | "outputDir" | "worktreeExists">;

/** "Xem trước": per-project preview config and the background screenshot capture of a run (one capture per port / desktop at a time). */
export class RunPreviews {
  private readonly previewLocks = new Set<string>();
  private readonly previews = new Map<string, { status: PreviewState["status"]; step: string | null }>();

  constructor(private readonly host: PreviewHost) {}

  getPreviewConfig(project: string): PreviewConfig {
    return this.host.store.getProjectPreview(project);
  }

  setPreviewConfig(project: string, raw: unknown): PreviewConfig {
    if (!this.host.store.getProject(project)) throw new Error("Không tìm thấy môi trường.");
    const c = validatePreview(raw);
    this.host.store.setProjectPreview(project, c);
    return c;
  }

  private previewDir(runId: string): string {
    return path.join(this.host.outputDir(), runId, "preview");
  }

  /** Start a background capture of the run's worktree (web) or desktop app; throws PreviewError when it cannot start. */
  startPreview(runId: string, opts: { viaTunnel: boolean }): PreviewState {
    const run = this.host.store.getRun(runId);
    if (!run) throw new PreviewError("not_found", "Không tìm thấy lần chạy.");
    const cfg = run.project ? this.getPreviewConfig(run.project) : ({ kind: "none" } as PreviewConfig);
    if (cfg.kind === "none") throw new PreviewError("bad_request", "Môi trường chưa khai báo Xem trước.");
    if (this.host.getGrants(run.project).grants.preview !== true) {
      throw new PreviewError("forbidden", "Chưa bật quyền chạy ứng dụng/máy chủ để xem trước (tab Xem trước hoặc Cài đặt > Cấp quyền).");
    }
    if (cfg.kind === "desktop" && opts.viaTunnel) throw new PreviewError("forbidden", "Chụp phần mềm desktop chỉ làm được trên máy chạy app.");
    if (cfg.kind === "web" && (!run.worktree_path || !this.host.worktreeExists(run))) throw new PreviewError("bad_request", "Worktree của lần chạy đã bị dọn.");
    if (cfg.kind === "web" && (run.status === "running" || run.status === "queued")) {
      throw new PreviewError("conflict", "Lần chạy đang chạy hoặc đang chờ, hãy đợi xong rồi chụp.");
    }
    if (this.previews.get(runId)?.status === "running") throw new PreviewError("conflict", "Đang chụp, hãy đợi xong.");

    const lockKey = cfg.kind === "web" ? `web-port:${new URL(cfg.url).port || "80"}` : "desktop";
    if (this.previewLocks.has(lockKey)) throw new PreviewError("conflict", "Một lượt chụp khác của môi trường này đang chạy.");
    const outDir = this.previewDir(runId);
    const deps = this.host.previewDeps ?? defaultPreviewDeps(this.host.config.dataDir, this.host.config.repoRoot);
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
    } catch {
      throw new PreviewError("bad_request", "Không xóa được ảnh cũ (tệp đang được dùng?).");
    }
    const entry: { status: PreviewState["status"]; step: string | null } = { status: "running", step: null };
    this.previews.set(runId, entry);
    this.previewLocks.add(lockKey);
    const finish = () => {
      this.previews.delete(runId);
      this.previewLocks.delete(lockKey);
    };
    void runPreview(cfg, { cwd: run.worktree_path ?? "", outDir, onStep: (s) => { entry.step = s; } }, deps)
      .catch((e): PreviewJson => {
        const t = Date.now();
        return { kind: cfg.kind === "desktop" ? "desktop" : "web", started_at: t, finished_at: t, status: "error", shots: [], error: e instanceof Error ? e.message : String(e), log_tail: [] };
      })
      .then((result) => {
        try {
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, "preview.json"), JSON.stringify(result, null, 2), "utf8");
        } catch { /* nothing to persist; state falls back to idle */ }
        finish();
      }, finish);
    return { status: "running", step: null, result: null };
  }

  getPreviewState(runId: string): PreviewState {
    const live = this.previews.get(runId);
    if (live) return { status: live.status, step: live.step, result: null };
    const result = readPreviewJson(this.previewDir(runId));
    return result ? { status: result.status, step: null, result } : { status: "idle", step: null, result: null };
  }

  /** Absolute path of a captured PNG of this run, or null (name must be a plain *.png file name inside the preview folder). */
  previewFile(runId: string, file: string): string | null {
    if (!/^[A-Za-z0-9._-]+\.png$/.test(file)) return null;
    const abs = resolveInside(this.previewDir(runId), file);
    return abs && fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
  }
}
