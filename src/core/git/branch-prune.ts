/**
 * Git side of "also delete the branch of a merged queue command" (Autopilot). Only `tnf/...` run branches are ever
 * touched, only with `git branch -d` (never `-D`), and only when git itself confirms the branch is an ancestor of the
 * base branch and no worktree still has it checked out. All git calls go through `runGit` (no shell).
 */
import fs from "node:fs";
import { isRunBranchName, resolveRef, runGit } from "./git.js";
import type { BranchPruner } from "../queue/queue-store.js";

/** What the run store knows about one branch: every run that used it. */
export interface BranchRunInfo {
  worktreePath: string | null;
  /** queued or running. */
  active: boolean;
}

export interface GitBranchPrunerOptions {
  repoPath: string;
  /** Branch the command branches were merged into (project base branch). Never deleted itself. */
  baseBranch: string;
  runsOfBranch: (branch: string) => BranchRunInfo[];
}

/** Branches currently checked out in any worktree of the repo (from `git worktree list --porcelain`). */
function checkedOutBranches(repoPath: string): Set<string> | null {
  const r = runGit(repoPath, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return null;
  const out = new Set<string>();
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith("branch refs/heads/")) out.add(line.slice("branch refs/heads/".length).trim());
  }
  return out;
}

export function createGitBranchPruner(o: GitBranchPrunerOptions): BranchPruner {
  return {
    inspect(branch) {
      // Condition guard: only agent run branches, never the base branch (main, release/*, feat/*, integ/*... are not tnf/).
      if (!isRunBranchName(branch) || branch === o.baseBranch) return { ok: false, reason: "không phải nhánh tnf/..." };
      const sha = resolveRef(o.repoPath, `refs/heads/${branch}`);
      if (!sha) return { ok: false, reason: "nhánh không còn trong repo" };
      // 2. git confirms the branch is an ancestor of the base branch.
      if (runGit(o.repoPath, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/heads/${o.baseBranch}`]).code !== 0) {
        return { ok: false, reason: `chưa là tổ tiên của ${o.baseBranch}` };
      }
      // 4. no run still uses its worktree, and git no longer has it checked out.
      const runs = o.runsOfBranch(branch);
      if (runs.some((r) => r.active)) return { ok: false, reason: "còn run đang dùng nhánh" };
      if (runs.some((r) => r.worktreePath && fs.existsSync(r.worktreePath))) return { ok: false, reason: "worktree chưa được gỡ" };
      const checked = checkedOutBranches(o.repoPath);
      if (checked === null) return { ok: false, reason: "không đọc được danh sách worktree" };
      if (checked.has(branch)) return { ok: false, reason: "worktree chưa được gỡ" };
      return { ok: true, sha };
    },
    remove(branch) {
      if (!isRunBranchName(branch)) return { ok: false, message: "không phải nhánh tnf/..." };
      const r = runGit(o.repoPath, ["branch", "-d", branch]);
      return r.code === 0 ? { ok: true } : { ok: false, message: r.stderr.trim() || r.stdout.trim() || `git branch -d mã ${r.code}` };
    },
  };
}
