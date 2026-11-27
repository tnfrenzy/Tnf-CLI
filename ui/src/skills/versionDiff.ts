import type { LibraryItem, LibraryRole } from "../types";

/** Stable text of a library version (role or item), one `field: value` block per non-empty field. */
export function versionText(v: { role?: Partial<LibraryRole>; item?: Partial<LibraryItem> }): string {
  const parts: string[] = [];
  const add = (k: string, val: unknown) => {
    if (val === undefined || val === null || val === "") return;
    if (Array.isArray(val) && val.length === 0) return;
    parts.push(`${k}: ${Array.isArray(val) ? val.join(", ") : String(val)}`);
  };
  if (v.role) {
    add("id", v.role.id);
    add("description", v.role.description);
    add("model", v.role.model);
    add("tools", v.role.tools);
    add("prompt", v.role.prompt);
  } else if (v.item) {
    add("id", v.item.id);
    add("name", v.item.name);
    add("type", v.item.type);
    add("roleIds", v.item.roleIds);
    add("content", v.item.content);
  }
  return parts.join("\n");
}

function toLines(text: string): string[] {
  return text === "" ? [] : text.split(/\r?\n/);
}

/** Unified diff (single hunk, full context) between two texts using a simple LCS. */
export function buildVersionPatch(label: string, oldText: string, newText: string): string {
  const header = [`diff --git a/${label} b/${label}`, `--- a/${label}`, `+++ b/${label}`];
  if (oldText === newText) return header.join("\n");
  const a = toLines(oldText);
  const b = toLines(newText);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (r: number, c: number): number => dp[r]?.[c] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(` ${a[i]}`); i++; j++; }
    else if (at(i + 1, j) >= at(i, j + 1)) { out.push(`-${a[i]}`); i++; }
    else { out.push(`+${b[j]}`); j++; }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return [...header, `@@ -${n ? 1 : 0},${n} +${m ? 1 : 0},${m} @@`, ...out].join("\n");
}
