import { describe, expect, it } from "vitest";
import { dicts } from "../../ui/src/i18n.js";

const expected = [
  "rs_title",
  "rs_toggle_show",
  "rs_toggle_hide",
  "rs_days",
  "rs_days_7",
  "rs_days_30",
  "rs_days_90",
  "rs_col_role",
  "rs_col_group",
  "rs_col_calls",
  "rs_col_tokens",
  "rs_col_duration",
  "rs_col_denied",
  "rs_col_pass",
  "rs_col_hints",
  "rs_group_coding",
  "rs_group_library",
  "rs_group_cad3d",
  "rs_group_other",
  "rs_group_unknown",
  "rs_hint_unused",
  "rs_hint_rare",
  "rs_hint_denied",
  "rs_hint_low_pass",
  "rs_empty",
  "rs_loading",
  "rs_load_error",
  "rs_truncated",
  "rs_note_unknown",
  "rs_note_coordinator",
];

describe("role stats i18n keys", () => {
  it("lists exactly 30 keys", () => {
    expect(expected.length).toBe(30);
    expect(new Set(expected).size).toBe(30);
  });
  for (const lang of ["vi", "en"] as const) {
    it(`has all rs_* keys non-empty in ${lang}`, () => {
      const d = dicts[lang] as Record<string, string>;
      for (const k of expected) {
        expect(typeof d[k]).toBe("string");
        expect(d[k].trim().length).toBeGreaterThan(0);
      }
      const found = Object.keys(d).filter((k) => k.startsWith("rs_"));
      expect(found.sort()).toEqual([...expected].sort());
    });
  }
});
