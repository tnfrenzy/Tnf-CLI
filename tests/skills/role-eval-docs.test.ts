import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const docPath = path.resolve(__dirname, "..", "..", "docs", "ROLE-EVAL.md");

describe("docs/ROLE-EVAL.md", () => {
  it("exists", () => {
    expect(existsSync(docPath)).toBe(true);
  });

  const doc = existsSync(docPath) ? readFileSync(docPath, "utf8") : "";

  it("has the key sections in order", () => {
    const headings = doc
      .split(/\r?\n/)
      .filter((l) => l.startsWith("## "))
      .map((l) => l.toLowerCase());
    const keys = ["tiêu chí", "ngưỡng mềm", "phiên bản", "chi phí", "bảo mật", "api"];
    let from = 0;
    for (const key of keys) {
      const idx = headings.findIndex((h, i) => i >= from && h.includes(key));
      expect(idx, `missing heading containing "${key}"`).toBeGreaterThanOrEqual(0);
      from = idx + 1;
    }
  });

  it("mentions the evals endpoint", () => {
    expect(doc).toContain("/api/library/roles/:id/evals");
  });

  it("states the run cap of 15 in context", () => {
    expect(doc).toMatch(/\b15\b/);
    expect(doc.toLowerCase()).toMatch(/tối đa[^\n]{0,40}\b15\b/);
  });

  it("has no Windows user paths", () => {
    expect(doc).not.toMatch(/[A-Za-z]:\\Users\\/);
  });

  it("does not spell out permission-bypass flags", () => {
    const flag = "--dangerously-" + "skip-permissions";
    const mode = "bypass" + "Permissions";
    expect(doc).not.toContain(flag);
    expect(doc).not.toContain(mode);
  });

  it("credits promptfoo (MIT) as inspiration only", () => {
    expect(doc).toContain("promptfoo");
    expect(doc).toContain("MIT");
  });
});
