import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoleStatsTable, RoleStatsView } from "../../ui/src/components/skills/RoleStatsTable.js";
import { vi as vi_ } from "../../ui/src/i18n/vi.js";
import type { UiRoleStatsResponse } from "../../ui/src/types.js";

type Sort = { key: "role" | "calls" | "tokens" | "durationMs" | "permissionDenials" | "passRate"; dir: "asc" | "desc" };

const rows = [
  { role: "alpha-coder", group: "coding", calls: 10, tokens: 12345, durationMs: 65000, permissionDenials: 1, passRate: 0.75 },
  { role: "beta-lib", group: "library", calls: 50, tokens: 500, durationMs: 4000, permissionDenials: 0, passRate: null },
  { role: "gamma-cad", group: "cad3d", calls: 30, tokens: 2000000, durationMs: 3700000, permissionDenials: 2, passRate: 0.5 },
];

const base = (over: Partial<UiRoleStatsResponse> = {}): UiRoleStatsResponse => ({
  rows,
  hints: [{ role: "alpha-coder", reason: "rare" }],
  truncated: false,
  runsWithoutAgents: 0,
  coordinatorDenials: 0,
  ...over,
});

const render = (data: UiRoleStatsResponse, sort: Sort = { key: "calls", dir: "desc" }) =>
  renderToStaticMarkup(createElement(RoleStatsView, { data, sort, onSort: () => {} }));

describe("RoleStatsView", () => {
  it("(a) shows 8 column labels, role names and formatted cells", () => {
    const html = render(base());
    for (const k of ["rs_col_role", "rs_col_group", "rs_col_calls", "rs_col_tokens", "rs_col_duration", "rs_col_denied", "rs_col_pass", "rs_col_hints"] as const) {
      expect(html).toContain(vi_[k]);
    }
    for (const r of rows) expect(html).toContain(r.role);
    expect(html).toContain("12.3k");
    expect(html).toContain("1m 5s");
    expect(html).toContain("75%");
    expect(html).toContain("—");
  });

  it("(b) hint label only on the row with a hint", () => {
    const html = render(base());
    expect(html).toContain(vi_.rs_hint_rare);
    expect(html).not.toContain(vi_.rs_hint_unused);
    expect(html).not.toContain(vi_.rs_hint_denied);
    expect(html).not.toContain(vi_.rs_hint_low_pass);
    const html2 = render(base({ hints: [] }));
    expect(html2).not.toContain(vi_.rs_hint_rare);
  });

  it("(c) notes", () => {
    const plain = render(base());
    expect(plain).not.toContain(vi_.rs_truncated);
    expect(plain).not.toContain(vi_.rs_note_unknown);
    expect(plain).not.toContain(vi_.rs_empty);
    expect(plain).not.toContain("Điều phối viên bị từ chối");

    expect(render(base({ truncated: true }))).toContain(vi_.rs_truncated);
    expect(render(base({ runsWithoutAgents: 2 }))).toContain(vi_.rs_note_unknown);
    const unk = render(base({ rows: [...rows, { role: "mystery", group: "unknown", calls: 1, tokens: 1, durationMs: 1, permissionDenials: 0, passRate: null }] }));
    expect(unk).toContain(vi_.rs_note_unknown);

    const coord = render(base({ coordinatorDenials: 5 }));
    expect(coord).toContain(vi_.rs_note_coordinator.replace("{n}", "5"));
    expect(coord).not.toContain("{n}");

    const empty = render(base({ rows: [], hints: [] }));
    expect(empty).toContain(vi_.rs_empty);
  });

  it("(d) sort changes row order", () => {
    const desc = render(base(), { key: "calls", dir: "desc" });
    expect(desc.indexOf("beta-lib")).toBeLessThan(desc.indexOf("gamma-cad"));
    expect(desc.indexOf("gamma-cad")).toBeLessThan(desc.indexOf("alpha-coder"));
    const asc = render(base(), { key: "calls", dir: "asc" });
    expect(asc.indexOf("alpha-coder")).toBeLessThan(asc.indexOf("gamma-cad"));
    expect(asc.indexOf("gamma-cad")).toBeLessThan(asc.indexOf("beta-lib"));
  });

  it("(e) extra row fields are never rendered", () => {
    const dirty = rows.map((r) => ({ ...r, path: "/home/secret", prompt: "PROMPT_SECRET" }));
    const html = render(base({ rows: dirty as unknown as UiRoleStatsResponse["rows"] }));
    expect(html).toContain("alpha-coder");
    expect(html).not.toContain("/home/secret");
    expect(html).not.toContain("PROMPT_SECRET");
  });
});

describe("RoleStatsTable (static)", () => {
  it("(f) shows loading, days label and 3 options with 30 selected", () => {
    const html = renderToStaticMarkup(createElement(RoleStatsTable));
    expect(html).toContain(vi_.rs_loading);
    expect(html).toContain(vi_.rs_days);
    expect(html).toContain(vi_.rs_days_7);
    expect(html).toContain(vi_.rs_days_90);
    expect(html).toMatch(/<option value="30" selected=""[^>]*>/);
    expect(html).toContain(vi_.rs_days_30);
  });
});
