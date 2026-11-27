/** Pure helpers for the worktree-setup settings section (limits mirror src/core/git/worktree-setup.ts; not imported). */
import { pick } from "../lib/lang";

const MIN_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 900;
const DEFAULT_TIMEOUT_SEC = 180;
const MAX_PATTERN_LEN = 200;

export function patternsToText(files: string[]): string {
  return files.join("\n");
}

/** Split lines, trim, drop empties and duplicates (order kept). */
export function textToPatterns(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Allowed commands containing the query (case-insensitive); empty query returns all. */
export function commandSuggestions(allowed: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of allowed) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (!q || c.toLowerCase().includes(q)) out.push(c);
  }
  return out;
}

/** Vietnamese error message, or null when the pattern is acceptable. */
export function clientCheckPattern(p: string): string | null {
  const s = p.trim().replace(/\\/g, "/");
  if (!s) return pick("Mẫu không được để trống.", "The pattern must not be empty.");
  if (s.length > MAX_PATTERN_LEN) return pick(`Mẫu quá dài (tối đa ${MAX_PATTERN_LEN} ký tự).`, `The pattern is too long (max ${MAX_PATTERN_LEN} characters).`);
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) return pick("Mẫu phải là đường dẫn tương đối, không dùng đường dẫn tuyệt đối hay ổ đĩa.", "The pattern must be a relative path, not an absolute path or drive.");
  const segs = s.split("/");
  if (segs.includes("..")) return pick("Mẫu không được chứa '..'.", "The pattern must not contain '..'.");
  if (segs.some((x) => x.toLowerCase() === ".git")) return pick("Mẫu không được trỏ vào thư mục .git.", "The pattern must not point into the .git folder.");
  return null;
}

export function clampTimeoutSec(n: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.round(n)));
}
