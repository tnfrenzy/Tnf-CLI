// Pure helpers for the role statistics view (sorting, formatting, hint grouping).

// TEMPORARY: minimal local types, structurally identical to UiRoleStatRow /
// UiRoleReviewHint from the rs-ui-api command. Keep in sync with it and replace
// with imports once that command lands. Generics below accept the full types.
export interface UiRoleStatRow {
  role: string;
  group: string;
  calls: number;
  tokens: number;
  durationMs: number;
  permissionDenials: number;
  passRate: number | null;
}

export interface UiRoleReviewHint {
  role: string;
  reason: "unused" | "rare" | "denied" | "low_pass";
}

export type RoleStatsSortKey =
  | "role"
  | "calls"
  | "tokens"
  | "durationMs"
  | "permissionDenials"
  | "passRate";

const DASH = "—";

export function sortRoleStats<T extends UiRoleStatRow>(
  rows: T[],
  key: RoleStatsSortKey,
  dir: "asc" | "desc",
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "role") return sign * a.role.localeCompare(b.role);
    if (key === "passRate") {
      const x = a.passRate;
      const y = b.passRate;
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return sign * (x - y);
    }
    return sign * (a[key] - b[key]);
  });
}

export function formatPassRate(rate: number | null): string {
  if (rate === null) return DASH;
  return `${Math.round(rate * 100)}%`;
}

export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const total = Math.floor(ms / 1000);
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (total >= 60) {
    return `${Math.floor(total / 60)}m ${total % 60}s`;
  }
  return `${total}s`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function hintsByRole<H extends UiRoleReviewHint>(
  hints: H[],
): Record<string, H["reason"][]> {
  const out: Record<string, H["reason"][]> = {};
  for (const h of hints) {
    const list = out[h.role] ?? [];
    if (!list.includes(h.reason)) list.push(h.reason);
    out[h.role] = list;
  }
  return out;
}
