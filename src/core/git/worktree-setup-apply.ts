import fs from "node:fs";
import path from "node:path";

import { describeWorktreeSetup, normalizeSetupTimeout, validateSetupCommand } from "./worktree-setup.js";
import { runSetupCommand } from "./worktree-setup-command.js";
import { provisionSetupFiles } from "./worktree-setup-copy.js";

import type { SetupCommandResult, SetupCopyResult } from "./worktree-setup.js";

/** Copy ignored files into a fresh worktree. Null when nothing is configured; never throws. */
export async function applySetupCopy(a: { repoPath: string; worktreePath: string; files: string[] }): Promise<SetupCopyResult | null> {
  if (!Array.isArray(a.files) || a.files.length === 0) return null;
  try {
    return await provisionSetupFiles(a.repoPath, a.worktreePath, a.files);
  } catch (e) {
    return { copied: [], skipped: [], ms: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Run the configured setup command. Null when none is configured; not-allowed commands yield ran:false. Never throws. */
export async function applySetupCommand(a: { worktreePath: string; command: string | null; timeoutSec: number; allowedCommands: string[]; env?: NodeJS.ProcessEnv }): Promise<SetupCommandResult | null> {
  if (a.command === null || a.command === undefined || a.command.trim() === "") return null;
  const notRan = (reason: string): SetupCommandResult => ({ ran: false, ok: false, exitCode: null, timedOut: false, tail: "", ms: 0, reason });
  try {
    const bad = validateSetupCommand(a.command, a.allowedCommands);
    if (bad !== null) return notRan(bad);
    let sec: number;
    try {
      sec = normalizeSetupTimeout(a.timeoutSec);
    } catch (e) {
      return notRan(e instanceof Error ? e.message : String(e));
    }
    return await runSetupCommand({ cwd: a.worktreePath, command: a.command.trim(), timeoutMs: sec * 1000, ...(a.env ? { env: a.env } : {}) });
  } catch (e) {
    return notRan(e instanceof Error ? e.message : String(e));
  }
}

/** Write `worktree-setup.txt` (paths and numbers only) and return the timeline notice, or null when nothing ran. Never throws. */
export function finishWorktreeSetup(runDir: string, copy: SetupCopyResult | null, cmd: SetupCommandResult | null): { key: string; text: string } | null {
  try {
    const notice = describeWorktreeSetup(copy, cmd);
    if (!notice) return null;
    try {
      const lines: string[] = [notice.text];
      if (copy) {
        lines.push(`copied (${copy.copied.length}):`, ...copy.copied.map((p) => `  ${p}`));
        if (copy.skipped.length) lines.push(`skipped (${copy.skipped.length}):`, ...copy.skipped.map((s) => `  ${s.path}: ${s.reason}`));
        lines.push(`copy ms: ${copy.ms}`);
      }
      if (cmd) lines.push(`command: ran=${cmd.ran} ok=${cmd.ok} exit=${cmd.exitCode ?? "null"} timedOut=${cmd.timedOut} ms=${cmd.ms}`);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "worktree-setup.txt"), lines.join("\n") + "\n", "utf8");
    } catch {
      // best effort: the notice is still returned
    }
    return { key: notice.key, text: notice.text };
  } catch {
    return null;
  }
}
