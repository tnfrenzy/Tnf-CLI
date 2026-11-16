import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("scout button", () => {
  it("LeftPanel wires the helpers and api", () => {
    const s = src("../../ui/src/components/LeftPanel.tsx");
    for (const k of ["canScout", "buildScoutPrompt", "scoutConfirmText", "api.startRun"]) expect(s).toContain(k);
  });
  it("LeftPanel opens ScoutReview when the scout run is done", () => {
    const s = src("../../ui/src/components/LeftPanel.tsx");
    for (const k of ["ScoutReview", "api.getRun"]) expect(s).toContain(k);
  });
  it("HistoryPage reopens the review for scout runs", () => {
    const s = src("../../ui/src/pages/HistoryPage.tsx");
    for (const k of ["ScoutReview", "isScoutPrompt", "scoutReview_reopen"]) expect(s).toContain(k);
  });
  it("isScoutPrompt recognises both languages", async () => {
    const m = await import("../../ui/src/queue/scoutAgent");
    expect(m.isScoutPrompt(m.buildScoutPrompt("x", "vi"))).toBe(true);
    expect(m.isScoutPrompt(m.buildScoutPrompt("x", "en"))).toBe(true);
    expect(m.isScoutPrompt("hello")).toBe(false);
  });
  it("i18n has the keys in vi and en", () => {
    const s = src("../../ui/src/i18n.ts");
    for (const k of ["env_scout", "env_scout_busy", "env_scout_tip", "env_scout_need_repo"]) {
      expect(s.split(`  ${k}:`).length - 1).toBe(2);
    }
  });
  it("scout passes focus groups and skipped proposals to the prompt", () => {
    const s = src("../../ui/src/components/LeftPanel.tsx");
    expect(s).toMatch(/buildScoutPrompt\(project\.name, lang, \{ focus, skipped: loadSkipped\(project\.name\) \}\)/);
    expect(s).toContain("SCOUT_FOCUS_IDS.map");
    expect(s).toContain("disabled={on && focus.length === 1}"); // last ticked group cannot be unticked
    expect(s).toContain("e.stopPropagation()");
  });
  it("focus i18n keys exist in vi and en for all 4 groups", () => {
    const s = src("../../ui/src/i18n.ts");
    for (const k of ["scoutFocus_title", "scoutFocus_feature", "scoutFocus_security", "scoutFocus_agents", "scoutFocus_ui"]) {
      expect(s.split(`  ${k}:`).length - 1, k).toBe(2);
    }
  });
  it("loadScoutFocus defaults to all 4 groups without storage", async () => {
    const { SCOUT_FOCUS_IDS } = await import("../../ui/src/queue/scoutAgent");
    const { loadScoutFocus } = await import("../../ui/src/lib/prefs");
    expect(loadScoutFocus()).toEqual([...SCOUT_FOCUS_IDS]);
  });
  it("loadScoutFocus drops unknown values and maps empty to all", async () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    try {
      const { loadScoutFocus, saveScoutFocus } = await import("../../ui/src/lib/prefs");
      store.set("tnf.scoutFocus", JSON.stringify(["security", "bogus", "ui"]));
      expect(loadScoutFocus()).toEqual(["security", "ui"]);
      store.set("tnf.scoutFocus", JSON.stringify(["bogus"]));
      expect(loadScoutFocus()).toHaveLength(4);
      saveScoutFocus(["agents"]);
      expect(loadScoutFocus()).toEqual(["agents"]);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
  it("EnvRow lays out name, agent chips, then buttons", () => {
    const s = src("../../ui/src/components/LeftPanel.tsx");
    const body = s.slice(s.indexOf("function EnvRow"));
    const a = body.indexOf("{project.name}</div>");
    const b = body.indexOf('className="steps"');
    const c = body.indexOf('className="env-actions"');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
