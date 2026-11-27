import fs from "node:fs";
import path from "node:path";
import { commitAllInWorktree, commitFiles, currentBranch, isBranchMerged, isRepoClean, mergeBranchNoFf, previewMerge, removeWorktree, resolveRef } from "../git/git.js";
import { planPublish } from "../app/publish.js";
import { checkBranchMerged, checkRepoReady } from "../release/preconditions.js";
import { appendFeature } from "../app/feature-registry.js";
import { runReplan } from "../queue/queue-replan.js";
import { SCOUT_PROMPT_PREFIXES, type MergePrecheck, type RunRecord } from "./run-store.js";
import type { RunHost } from "./run-host.js";

export type ReleaseHost = Pick<RunHost, "config" | "store" | "active" | "queue" | "emitUpdated" | "startRun" | "waitFor">;

/** What happens to a finished coding run's branch: merge pre-check, release (merge into base), version bump, worktree cleanup. */
export class RunRelease {
  constructor(private readonly host: ReleaseHost) {}

  /**
   * UI "Dọn worktree" (after the two-step confirmation): `git worktree remove` + `git branch -D tnf/<id>` in the
   * target repo. Refused while this run, or any run sharing the worktree (follow-ups), is still running.
   */
  cleanupWorktree(runId: string): { worktree_path: string; branch: string; worktree_removed: boolean; branch_deleted: boolean; messages: string[] } {
    const run = this.host.store.getRun(runId);
    if (!run) throw new Error("Không tìm thấy lần chạy.");
    if (run.kind !== "coding" || !run.worktree_path || !run.branch) throw new Error("Lần chạy này không có worktree để dọn.");
    for (const id of this.host.active.keys()) {
      const other = this.host.store.getRun(id);
      if (id === runId || other?.worktree_path === run.worktree_path) throw new Error("Worktree đang được một lần chạy sử dụng; hãy chờ xong hoặc hủy trước.");
    }
    const project = this.host.store.getProject(run.project);
    if (!project?.repo_path) throw new Error("Không tìm thấy repo đích của project.");
    const worktreesDir = path.resolve(this.host.config.worktreesDir) + path.sep;
    if (!path.resolve(run.worktree_path).startsWith(worktreesDir)) throw new Error("Worktree nằm ngoài thư mục worktrees của controller; không dọn.");
    const r = removeWorktree({ repoPath: project.repo_path, worktreePath: run.worktree_path, branch: run.branch });
    return { worktree_path: run.worktree_path, branch: run.branch, ...r };
  }

  /**
   * Manual "release" of a finished coding run: commit leftovers in the worktree (excluding node_modules), then
   * `merge --no-ff tnf/<id>` into the target repo's base branch. Preconditions are checked before any change.
   * No push, no tag, no version bump, no checkout, no cleanup.
   */
  releaseRun(runId: string): { committed: boolean; merged: boolean; base: string; branch: string; commit: string | null } {
    const run = this.host.store.getRun(runId);
    if (!run) throw new Error("Không tìm thấy lần chạy.");
    if (run.kind !== "coding" || !run.worktree_path || !run.branch) throw new Error("Chỉ lần chạy lập trình có worktree mới phát hành được.");
    for (const id of this.host.active.keys()) {
      const other = this.host.store.getRun(id);
      if (id === runId || other?.worktree_path === run.worktree_path) throw new Error("Worktree đang được một lần chạy sử dụng; hãy chờ xong hoặc hủy trước khi phát hành.");
    }
    if (!fs.existsSync(run.worktree_path)) throw new Error("Worktree không còn trên đĩa; không thể phát hành.");
    const project = this.host.store.getProject(run.project);
    if (!project?.repo_path) throw new Error(`Không tìm thấy project "${run.project}" (có thể đã bị xóa) hoặc project không có repo đích; không thể phát hành.`);
    const base = project.base_branch || "main";
    const cur = currentBranch(project.repo_path);
    if (cur !== base) throw new Error(`Repo đích đang ở nhánh "${cur}", không phải nhánh base "${base}". Hãy chuyển repo đích về "${base}" rồi phát hành lại (controller không tự checkout).`);
    if (!isRepoClean(project.repo_path)) throw new Error("Repo đích còn thay đổi chưa commit; hãy commit hoặc cất chúng trước khi phát hành.");
    if (run.merge_precheck?.status === "conflict") {
      console.warn(`[precheck] run ${runId} có xung đột dự kiến khi gộp vào ${base}: ${run.merge_precheck.files.join(", ")}`);
    }
    const c = commitAllInWorktree(run.worktree_path, `chore(tnf): finalize ${runId}`);
    const m =mergeBranchNoFf({ repoPath: project.repo_path, base, branch: run.branch, message: `Merge ${run.branch}: release ${runId}` });
    try {
      // Every "đã commit" command on the same idea branch (sequential run-all shares one branch) is now merged.
      const cmds = this.host.queue
        .list(run.project)
        .filter((x) => x.status === "đã commit" && (x.runId === runId || (!!x.branch && x.branch === run.branch)));
      for (const qc of cmds) {
        try {
          this.host.queue.transition(run.project, qc.id, "đã gộp");
        } catch (e) {
          console.warn(`[queue] không đánh dấu "đã gộp" cho lệnh ${qc.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const source = cmds.find((x) => x.runId === runId) ?? cmds[0];
      if (source && this.host.config.queue?.replan?.enabled) {
        const proj = this.host.store.getProject(run.project);
        void runReplan(
          { manager: this.host, queue: this.host.queue, config: this.host.config, getProject: () => proj ?? null },
          { project: run.project, sourceId: source.id, branch: run.branch, mergeCommit: m.commit },
        ).catch((e) => console.warn(`[queue] replan lỗi cho run ${runId}: ${e instanceof Error ? e.message : String(e)}`));
      }
    } catch (e) {
      console.warn(`[queue] không đánh dấu "đã gộp" cho run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Runs outside the queue (queue commands are recorded when they reach "đã commit"/"đã gộp") add their request to the registry.
    try {
      if (!SCOUT_PROMPT_PREFIXES.some((p) => run.prompt.startsWith(p)) && !this.host.queue.list(run.project).some((x) => x.runId === runId)) {
        appendFeature(this.host.config.dataDir, run.project, { title: run.prompt.split(/\r?\n/)[0] ?? "", ref: runId });
      }
    } catch {
      /* the registry is best-effort */
    }
    // The base just moved: refresh the dry-run merge result of the other unmerged, idle coding runs of this project.
    try {
      const siblings = this.host.store
        .listRuns({ project: run.project, limit: 100000 })
        .filter((r) => r.id !== runId && r.project === run.project && r.kind === "coding" && !!r.branch && !this.host.active.has(r.id) && this.mergedFlag(r) !== true);
      for (const r of siblings) {
        try {
          this.precheckMerge(r.id);
        } catch (e) {
          console.warn(`[precheck] không kiểm tra lại được run ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      console.warn(`[precheck] không kiểm tra lại các run cùng project sau khi gộp ${runId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { committed: c.committed, merged: true, base, branch: run.branch, commit: m.commit };
  }

  /** Computed on the fly (not stored): is `tnf/<id>` already merged into the project's base? undefined for non-coding/no repo. */
  mergedFlag(run: RunRecord): boolean | undefined {
    if (run.kind !== "coding" || !run.branch) return undefined;
    const project = this.host.store.getProject(run.project);
    if (!project?.repo_path) return undefined;
    return isBranchMerged(project.repo_path, run.branch, project.base_branch || "main");
  }

  /**
   * Dry-run merge of the run's branch into the project's base; stores the result in `merge_precheck` and emits
   * `run.updated`. undefined (nothing written) for non-coding runs, runs without a branch, or projects without a repo.
   * Not wrapped in try/catch: callers handle errors.
   */
  precheckMerge(runId: string): MergePrecheck | undefined {
    const run = this.host.store.getRun(runId);
    if (!run || run.kind !== "coding" || !run.branch) return undefined;
    const project = this.host.store.getProject(run.project);
    if (!project?.repo_path) return undefined;
    const repoPath = project.repo_path;
    const base = project.base_branch || "main";
    const preview = previewMerge({ repoPath, base, branch: run.branch });
    const merge_precheck: MergePrecheck = { ...preview, base_sha_checked: resolveRef(repoPath, base) };
    this.host.store.updateRun(runId, { merge_precheck });
    this.host.emitUpdated(runId);
    return merge_precheck;
  }

  /**
   * "Phát hành": bump the patch version in package.json (+ package-lock.json) of the target repo and commit
   * `chore(release): <version>`. All preconditions are checked before any file is touched. No tag, no push, no npm.
   */
  publishRun(runId: string): { ok: true; version: string; previous: string; commit: string } {
    const run = this.host.store.getRun(runId);
    if (!run) throw new Error("Không tìm thấy lần chạy.");
    if (run.kind !== "coding" || !run.branch) throw new Error("Chỉ lần chạy lập trình mới phát hành được.");
    if (run.status === "running" || this.host.active.has(runId)) throw new Error("Lần chạy chưa xong; hãy chờ xong hoặc hủy trước khi phát hành.");
    const project = this.host.store.getProject(run.project);
    if (!project?.repo_path) throw new Error(`Không tìm thấy project "${run.project}" hoặc project không có repo đích; không thể phát hành.`);
    const repo = project.repo_path;
    const base = project.base_branch || "main";
    checkRepoReady(repo, base);
    const plan = planPublish(repo);
    checkBranchMerged(repo, run.branch, base);
    for (const f of plan.files) fs.writeFileSync(path.join(repo, f.rel), f.content);
    const commit = commitFiles(repo, plan.files.map((f) => f.rel), `chore(release): ${plan.next}`);
    return { ok: true, version: plan.next, previous: plan.previous, commit };
  }
}
