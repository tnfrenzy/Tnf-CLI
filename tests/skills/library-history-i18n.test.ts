import { describe, expect, it } from "vitest";
import { dicts } from "../../ui/src/i18n";

const REQUIRED = [
  "lib_hist_button", "lib_hist_title", "lib_hist_empty", "lib_hist_compare", "lib_hist_current",
  "lib_hist_restore", "lib_hist_restore_confirm", "lib_hist_danger", "lib_hist_note_label",
  "lib_hist_loading", "lib_hist_close", "lib_hist_restored", "lib_hist_note_placeholder",
  "lib_hist_version_label", "lib_hist_no_diff",
];
const VI_CHARS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

const keysOf = (d: Record<string, string>) => Object.keys(d).filter((k) => k.startsWith("lib_hist_")).sort();

describe("lib_hist i18n", () => {
  it("has the 15 required keys in both languages", () => {
    for (const k of REQUIRED) {
      expect(dicts.vi[k], k).toBeTruthy();
      expect(dicts.en[k], k).toBeTruthy();
    }
    expect(keysOf(dicts.vi)).toEqual([...REQUIRED].sort());
  });
  it("vi and en have the same lib_hist key set", () => {
    expect(keysOf(dicts.en)).toEqual(keysOf(dicts.vi));
  });
  it("en values contain no Vietnamese characters", () => {
    for (const k of keysOf(dicts.en)) expect(VI_CHARS.test(dicts.en[k]), k).toBe(false);
  });
});
