import { assertSafeCommandTokens, splitCommand } from "../preview/preview-config.js";
import { validateAllowedCommand } from "../run/permissions.js";

import type { WorktreeSetupConfig } from "../run/run-store.js";

export type { WorktreeSetupConfig };

export const WORKTREE_SETUP_LIMITS = {
  maxPatterns: 20,
  maxFiles: 50,
  maxFileBytes: 5242880,
  maxTotalBytes: 20971520,
  defaultTimeoutSec: 180,
  minTimeoutSec: 10,
  maxTimeoutSec: 900,
  logTailBytes: 4000,
} as const;

export interface SetupCopyResult {
  copied: string[];
  skipped: { path: string; reason: string }[];
  ms: number;
  error?: string;
}

export interface SetupCommandResult {
  ran: boolean;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
  ms: number;
  reason?: string;
}

/** Match a repo-relative path against a setup glob: `*` and `?` stay within a segment, `**` crosses directories. */
export function matchSetupGlob(pattern: string, relPath: string, opts?: { caseInsensitive?: boolean }): boolean {
  const pat = pattern.replace(/\\/g, "/");
  const path = relPath.replace(/\\/g, "/");
  let re = "^";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") {
      if (pat[i + 1] === "*") {
        if (pat[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re, opts?.caseInsensitive ? "i" : "").test(path);
}

/** Git pathspecs (glob magic) for the given patterns. */
export function globsToPathspecs(patterns: string[]): string[] {
  return patterns.map((p) => `:(glob)${p}`);
}

/** Decide which candidate files to copy: skips symlinks, non-matching, oversized and over-quota files. */
export function planWorktreeCopy(
  patterns: string[],
  candidates: { path: string; size: number; symlink?: boolean }[],
  opts?: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number },
): { copy: string[]; skipped: { path: string; reason: string }[] } {
  const maxFiles = opts?.maxFiles ?? WORKTREE_SETUP_LIMITS.maxFiles;
  const maxFileBytes = opts?.maxFileBytes ?? WORKTREE_SETUP_LIMITS.maxFileBytes;
  const maxTotalBytes = opts?.maxTotalBytes ?? WORKTREE_SETUP_LIMITS.maxTotalBytes;
  const copy: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;
  for (const c of candidates) {
    if (c.symlink) {
      skipped.push({ path: c.path, reason: "Bỏ qua liên kết tượng trưng (symlink)." });
    } else if (!patterns.some((p) => matchSetupGlob(p, c.path))) {
      skipped.push({ path: c.path, reason: "Không khớp mẫu tệp nào." });
    } else if (c.size > maxFileBytes) {
      skipped.push({ path: c.path, reason: `Tệp vượt giới hạn ${maxFileBytes} byte.` });
    } else if (copy.length >= maxFiles) {
      skipped.push({ path: c.path, reason: `Vượt giới hạn ${maxFiles} tệp.` });
    } else if (total + c.size > maxTotalBytes) {
      skipped.push({ path: c.path, reason: `Vượt tổng dung lượng ${maxTotalBytes} byte.` });
    } else {
      copy.push(c.path);
      total += c.size;
    }
  }
  return { copy, skipped };
}

/** Timeline notice for the setup result, or null when nothing was configured. */
export function describeWorktreeSetup(
  copy: SetupCopyResult | null,
  cmd: SetupCommandResult | null,
): { key: "worktree.setup" | "worktree.setup.error"; text: string } | null {
  if (!copy && !cmd) return null;
  const parts: string[] = [];
  let failed = false;
  if (copy) {
    parts.push(`Đã chép ${copy.copied.length} tệp vào worktree` + (copy.skipped.length ? `, bỏ qua ${copy.skipped.length}` : ""));
    if (copy.error) {
      failed = true;
      parts.push(`lỗi chép: ${copy.error}`);
    }
  }
  if (cmd) {
    if (!cmd.ran) {
      failed = true;
      parts.push(`lệnh setup không chạy${cmd.reason ? `: ${cmd.reason}` : ""}`);
    } else if (cmd.timedOut) {
      failed = true;
      parts.push(`lệnh setup quá thời gian (${cmd.ms} ms)`);
    } else if (!cmd.ok) {
      failed = true;
      parts.push(`lệnh setup lỗi (mã thoát ${cmd.exitCode ?? "không rõ"}, ${cmd.ms} ms)`);
    } else {
      parts.push(`lệnh setup xong (${cmd.ms} ms)`);
    }
  }
  return { key: failed ? "worktree.setup.error" : "worktree.setup", text: parts.join("; ") + "." };
}

/** Validate and clean the list of files/globs to copy into a new worktree. Throws (Vietnamese) on bad input. */
export function normalizeSetupFiles(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
    throw new Error("Danh sách tệp phải là mảng chuỗi.");
  }
  const out: string[] = [];
  for (const item of raw as string[]) {
    const s = item.trim().replace(/\\/g, "/");
    if (!s || out.includes(s)) continue;
    if (s.startsWith("/")) throw new Error(`Đường dẫn phải tương đối, không bắt đầu bằng "/": "${s}"`);
    if (/^[A-Za-z]:/.test(s)) throw new Error(`Đường dẫn phải tương đối, không dùng ổ đĩa: "${s}"`);
    const segs = s.split("/");
    if (segs.includes("..")) throw new Error(`Đường dẫn không được chứa "..": "${s}"`);
    if (segs.some((g) => g.toLowerCase() === ".git")) throw new Error(`Không được chọn thư mục .git: "${s}"`);
    out.push(s);
  }
  if (out.length > WORKTREE_SETUP_LIMITS.maxPatterns) throw new Error(`Tối đa ${WORKTREE_SETUP_LIMITS.maxPatterns} mẫu tệp.`);
  return out;
}

/** Timeout (seconds) for the setup command; default 180, allowed 10..900. */
export function normalizeSetupTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return WORKTREE_SETUP_LIMITS.defaultTimeoutSec;
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw new Error("Thời gian chờ phải là số nguyên (giây).");
  if (raw < WORKTREE_SETUP_LIMITS.minTimeoutSec || raw > WORKTREE_SETUP_LIMITS.maxTimeoutSec) throw new Error("Thời gian chờ phải từ 10 đến 900 giây.");
  return raw;
}

/** Null when the command is empty or permitted by the environment's allowed_commands, otherwise a Vietnamese reason. */
export function validateSetupCommand(command: string | null, allowed: string[]): string | null {
  if (command === null || command.trim() === "") return null;
  const cmd = command.trim();
  try {
    assertSafeCommandTokens(splitCommand(cmd));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  for (const rule of allowed) {
    if (validateAllowedCommand(rule) !== null) continue;
    const inner = /^Bash\((.+)\)$/.exec(rule.trim())![1]!;
    const fixed = inner.split("*")[0]!.trim();
    const hasStar = inner.includes("*");
    if (cmd === fixed || cmd.startsWith(fixed + " ") || (hasStar && cmd.startsWith(fixed))) return null;
  }
  return `Lệnh "${cmd}" không nằm trong allowed_commands của môi trường.`;
}
