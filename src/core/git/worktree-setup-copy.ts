import fs from "node:fs";
import path from "node:path";

import { runGitAsync } from "./git.js";
import { globsToPathspecs, planWorktreeCopy, type SetupCopyResult } from "./worktree-setup.js";

/** Gitignored (untracked) files in repoPath matching the glob patterns, as repo-relative "/" paths. Throws on git failure. */
export async function listIgnoredFiles(repoPath: string, patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const r = await runGitAsync(repoPath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...globsToPathspecs(patterns)]);
  if (r.code !== 0) throw new Error(`git ls-files thất bại: ${r.stderr.trim() || `mã ${r.code}`}`);
  return r.stdout.split("\0").filter((s) => s.length > 0).map((s) => s.replace(/\\/g, "/"));
}

/**
 * Copy gitignored files matching `patterns` from the repo into a fresh worktree (same spirit as provisionNodeModules:
 * never overwrite, never follow or create symlinks). Never throws; failures land in `error`. File contents are not logged.
 */
export async function provisionSetupFiles(repoPath: string, worktreePath: string, patterns: string[]): Promise<SetupCopyResult> {
  if (patterns.length === 0) return { copied: [], skipped: [], ms: 0 };
  const t0 = Date.now();
  const copied: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  try {
    const listed = await listIgnoredFiles(repoPath, patterns);
    const candidates = listed.map((p) => {
      try {
        const st = fs.lstatSync(path.join(repoPath, p));
        return { path: p, size: st.size, symlink: st.isSymbolicLink() || !st.isFile() };
      } catch {
        return { path: p, size: 0, symlink: true };
      }
    });
    const plan = planWorktreeCopy(patterns, candidates);
    skipped.push(...plan.skipped);
    for (const rel of plan.copy) {
      const dest = path.join(worktreePath, rel);
      try {
        if (fs.existsSync(dest)) {
          skipped.push({ path: rel, reason: "Đã có ở worktree, không ghi đè." });
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(repoPath, rel), dest, fs.constants.COPYFILE_EXCL);
        copied.push(rel);
      } catch (e) {
        skipped.push({ path: rel, reason: `Không chép được: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return { copied, skipped, ms: Date.now() - t0 };
  } catch (e) {
    return { copied, skipped, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}
