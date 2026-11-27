import { afterEach, describe, expect, it } from "vitest";
import { setCurLang } from "../../ui/src/lib/lang";
import {
  FRAME_PRESETS,
  assetKindLabel,
  elapsedSince,
  formatBytes,
  formatCost,
  formatDuration,
  friendlyError,
  jobPercent,
  jobProgressText,
  phaseLabel,
  presetLabel,
  presetOf,
  projectErrorText,
  sheetCandidates,
  stateLabel,
  validateAssetFile,
  validateCreateForm,
} from "../../ui/src/codevideo/logic";
import { codeVideoTowerFloors } from "../../ui/src/office/codevideo-floors";

const VI = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
const ok = { title: "Video", brief: "Mô tả", width: 1080, height: 1920, duration: 30, fps: 30 };

afterEach(() => setCurLang("vi"));

describe("codevideo ui logic", () => {
  it("presets are the three frame sizes", () => {
    expect(FRAME_PRESETS.map((p) => `${p.width}x${p.height}`)).toEqual(["1080x1920", "1920x1080", "1080x1080"]);
    expect(presetOf(1920, 1080)).toBe("landscape");
    expect(presetOf(10, 10)).toBeNull();
  });

  it("validates the create form", () => {
    expect(validateCreateForm(ok)).toBeNull();
    expect(validateCreateForm({ ...ok, title: "  " })).toMatch(/tiêu đề/i);
    expect(validateCreateForm({ ...ok, title: "x".repeat(81) })).not.toBeNull();
    expect(validateCreateForm({ ...ok, brief: "" })).toMatch(/mô tả/i);
    expect(validateCreateForm({ ...ok, brief: "x".repeat(8001) })).not.toBeNull();
    expect(validateCreateForm({ ...ok, duration: 2 })).toMatch(/3/);
    expect(validateCreateForm({ ...ok, duration: 181 })).toMatch(/180/);
    expect(validateCreateForm({ ...ok, duration: 3 })).toBeNull();
    expect(validateCreateForm({ ...ok, duration: 180 })).toBeNull();
    expect(validateCreateForm({ ...ok, fps: 29 })).not.toBeNull();
    expect(validateCreateForm({ ...ok, width: 100 })).not.toBeNull();
    expect(validateCreateForm({ ...ok, height: 5000 })).not.toBeNull();
  });

  it("validates asset files", () => {
    expect(validateAssetFile("a.png", 10)).toBeNull();
    expect(validateAssetFile("a.png", 0)).not.toBeNull();
    expect(validateAssetFile("a.mp4", 201 * 1024 * 1024)).not.toBeNull();
    expect(validateAssetFile(" ", 5)).not.toBeNull();
  });

  it("labels job phases and percent", () => {
    const job = { kind: "generate", phase: "final", startedAt: "2026-01-01T00:00:00Z", done: 126, total: 300, round: 0 } as const;
    expect(jobPercent(job)).toBe(42);
    expect(jobProgressText(job)).toContain("42%");
    expect(jobProgressText(job)).toContain("126/300");
    expect(jobPercent({ ...job, phase: "coding" })).toBeNull();
    expect(jobPercent({ ...job, phase: "draft", total: 0 })).toBeNull();
    expect(jobPercent({ ...job, done: 999 })).toBe(100);
    expect(phaseLabel({ kind: "revise", phase: "coding", round: 0 })).toMatch(/sửa/);
    expect(phaseLabel({ kind: "generate", phase: "review", round: 1 })).toContain("2");
    for (const ph of ["coding", "draft", "review", "final", "done"] as const) expect(phaseLabel({ kind: "render", phase: ph, round: 0 })).not.toBe("");
  });

  it("formats duration, bytes, cost and elapsed time", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatCost(0.1234)).toBe("~$0.12");
    expect(formatCost(-1)).toBe("~$0.00");
    expect(elapsedSince("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:01:30Z"))).toBe("1:30");
    expect(elapsedSince("bad", 1000)).toBe("0:00");
  });

  it("sheet candidates list the newest round first", () => {
    expect(sheetCandidates()).toEqual(["out/sheet-3.png", "out/sheet-2.png", "out/sheet-1.png"]);
  });

  it("friendly errors keep the server text in Vietnamese and never leak it into English", () => {
    expect(friendlyError(409, "Dự án đang bận")).toBe("Dự án đang bận");
    setCurLang("en");
    expect(friendlyError(409, "Dự án đang bận")).not.toMatch(VI);
    expect(friendlyError(500, undefined)).not.toMatch(VI);
    expect(projectErrorText("Lỗi dựng")).not.toMatch(VI);
  });

  it("English labels contain no Vietnamese", () => {
    setCurLang("en");
    const out: string[] = [];
    for (const p of FRAME_PRESETS) out.push(presetLabel(p.id));
    for (const s of ["draft", "coding", "rendering", "done", "failed"]) out.push(stateLabel(s));
    for (const k of ["image", "video", "audio", "font", "data"]) out.push(assetKindLabel(k));
    for (const ph of ["coding", "draft", "review", "final", "done"] as const) {
      out.push(phaseLabel({ kind: "revise", phase: ph, round: 1 }), jobProgressText({ kind: "render", phase: ph, startedAt: "", done: 1, total: 2, round: 0 }));
    }
    out.push(validateCreateForm({ ...ok, title: "" }) ?? "", validateCreateForm({ ...ok, brief: "" }) ?? "", validateCreateForm({ ...ok, duration: 1 }) ?? "", validateCreateForm({ ...ok, fps: 1 }) ?? "", validateCreateForm({ ...ok, width: 1 }) ?? "");
    out.push(validateAssetFile("", 1) ?? "", validateAssetFile("a", 0) ?? "", validateAssetFile("a", 1e12) ?? "");
    for (const s of out) expect(s, s).not.toMatch(VI);
  });

  it("tower floors still come from the shared codevideo-floors module", () => {
    const f = codeVideoTowerFloors([{ slug: "a", title: "A", state: "coding", updatedAt: "2" }, { slug: "b", state: "done", updatedAt: "1" }]);
    expect(f.map((x) => x.badge)).toEqual(["running", "done"]);
  });
});
