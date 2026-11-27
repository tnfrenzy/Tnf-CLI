import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const docPath = path.resolve(__dirname, "..", "..", "docs", "ROLE-STATS.md");

describe("docs/ROLE-STATS.md", () => {
  it("exists", () => {
    expect(existsSync(docPath)).toBe(true);
  });

  const doc = existsSync(docPath) ? readFileSync(docPath, "utf8") : "";

  it("has the 8 main sections", () => {
    const names = [
      "Mục đích",
      "Nguồn số liệu",
      "Ý nghĩa các cột",
      "Cách ghép nhóm",
      "Quy tắc gợi ý",
      "Giới hạn tham số",
      "Giới hạn đã biết",
      "Bảo mật",
    ];
    names.forEach((name, i) => {
      expect(doc).toMatch(new RegExp(`^## ${i + 1}\\. ${name}\\s*$`, "m"));
    });
  });

  it("lists the 11 columns", () => {
    for (const col of [
      "role", "group", "calls", "runs", "tokens", "durationMs",
      "permissionDenials", "runsWithVerdict", "passRuns", "passRate", "lastUsedAt",
    ]) {
      expect(doc).toContain("`" + col + "`");
    }
  });

  it("lists the 4 suggestion codes", () => {
    for (const code of ["unused", "rare", "denied", "low_pass"]) {
      expect(doc).toContain("`" + code + "`");
    }
  });

  it("mentions key limits, token header and groups", () => {
    expect(doc).toContain("30 vai");
    expect(doc).toContain("1..90");
    expect(doc).toContain("2000");
    expect(doc).toContain("X-Controller-Token");
    expect(doc).toContain("coordinatorDenials");
    for (const g of ["coding", "thư viện", "cad3d", "khác", "không xác định"]) {
      expect(doc).toContain(g);
    }
  });

  it("states the unknown rule inside the known-limits section", () => {
    const start = doc.search(/^## 7\. Giới hạn đã biết/m);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = doc.slice(start + 5);
    const next = rest.search(/^## /m);
    const section = next >= 0 ? rest.slice(0, next) : rest;
    expect(section).toContain("subagent");
    expect(section).toContain("unknown");
    expect(section).toContain("coordinatorDenials");
    expect(section).toContain("MỘT hàng");
  });

  it("has no Windows user paths", () => {
    expect(doc).not.toMatch(/[A-Za-z]:\\Users\\/);
  });
});
