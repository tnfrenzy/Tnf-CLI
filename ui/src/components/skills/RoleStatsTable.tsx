import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import type { Dict } from "../../i18n";
import type { UiRoleStatsResponse } from "../../types";
import {
  formatDurationShort,
  formatPassRate,
  formatTokens,
  hintsByRole,
  sortRoleStats,
  type RoleStatsSortKey,
  type UiRoleReviewHint,
} from "../../skills/roleStatsView";

export type RoleStatsSort = { key: RoleStatsSortKey; dir: "asc" | "desc" };

const GROUP_KEYS: Record<string, keyof Dict> = {
  coding: "rs_group_coding",
  library: "rs_group_library",
  cad3d: "rs_group_cad3d",
  other: "rs_group_other",
  unknown: "rs_group_unknown",
};

const HINT_KEYS: Record<UiRoleReviewHint["reason"], keyof Dict> = {
  unused: "rs_hint_unused",
  rare: "rs_hint_rare",
  denied: "rs_hint_denied",
  low_pass: "rs_hint_low_pass",
};

function groupKey(group: string): keyof Dict {
  return (Object.prototype.hasOwnProperty.call(GROUP_KEYS, group) ? GROUP_KEYS[group] : undefined) ?? "rs_group_unknown";
}

export function RoleStatsView(props: {
  data: UiRoleStatsResponse;
  sort: RoleStatsSort;
  onSort: (key: RoleStatsSortKey) => void;
}) {
  const { t } = useT();
  const { data, sort, onSort } = props;
  const rows = sortRoleStats(data.rows, sort.key, sort.dir);
  const hints = hintsByRole(data.hints);
  const showUnknown = data.rows.some((r) => r.group === "unknown") || data.runsWithoutAgents > 0;

  const sortable = (key: RoleStatsSortKey, label: string) => (
    <th>
      <button type="button" className="link-btn" onClick={() => onSort(key)}>
        {label}
        {sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );

  return (
    <div>
      {rows.length === 0 ? (
        <p className="fine">{t.rs_empty}</p>
      ) : (
        <table>
          <thead>
            <tr>
              {sortable("role", t.rs_col_role)}
              <th>{t.rs_col_group}</th>
              {sortable("calls", t.rs_col_calls)}
              {sortable("tokens", t.rs_col_tokens)}
              {sortable("durationMs", t.rs_col_duration)}
              {sortable("permissionDenials", t.rs_col_denied)}
              {sortable("passRate", t.rs_col_pass)}
              <th>{t.rs_col_hints}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.role}>
                <td>{r.role}</td>
                <td>{t[groupKey(r.group)]}</td>
                <td>{r.calls}</td>
                <td>{formatTokens(r.tokens)}</td>
                <td>{formatDurationShort(r.durationMs)}</td>
                <td>{r.permissionDenials}</td>
                <td>{formatPassRate(r.passRate)}</td>
                <td>{(hints[r.role] ?? []).map((h) => t[HINT_KEYS[h]]).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.truncated && <p className="fine">{t.rs_truncated}</p>}
      {showUnknown && <p className="fine">{t.rs_note_unknown}</p>}
      {data.coordinatorDenials > 0 && (
        <p className="fine">{t.rs_note_coordinator.replace("{n}", () => String(data.coordinatorDenials))}</p>
      )}
    </div>
  );
}

const DAY_OPTIONS: { value: number; key: keyof Dict }[] = [
  { value: 7, key: "rs_days_7" },
  { value: 30, key: "rs_days_30" },
  { value: 90, key: "rs_days_90" },
];

export function RoleStatsTable() {
  const { t } = useT();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UiRoleStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<RoleStatsSort>({ key: "calls", dir: "desc" });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    api
      .roleStats(days)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const onSort = (key: RoleStatsSortKey) => {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "role" ? "asc" : "desc" },
    );
  };

  return (
    <div>
      <label className="fine">
        {t.rs_days}{" "}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {DAY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {t[o.key]}
            </option>
          ))}
        </select>
      </label>
      {loading ? (
        <p className="muted">{t.rs_loading}</p>
      ) : error || !data ? (
        <p className="muted">{t.rs_load_error}</p>
      ) : (
        <RoleStatsView data={data} sort={sort} onSort={onSort} />
      )}
    </div>
  );
}
