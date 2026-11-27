import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const file = path.resolve(__dirname, "..", "..", "docs", "WORKTREE-SETUP.md");
const doc = readFileSync(file, "utf8");

function section(from: string, to?: string): string {
  const a = doc.indexOf(from);
  if (a < 0) return "";
  const b = to ? doc.indexOf(to, a + from.length) : -1;
  return b < 0 ? doc.slice(a) : doc.slice(a, b);
}

describe("docs/WORKTREE-SETUP.md", () => {
  it("exists and has a table of contents", () => {
    expect(existsSync(file)).toBe(true);
    expect(doc).toContain("## Mục lục");
  });

  it("has the eight numbered headings", () => {
    for (let i = 1; i <= 8; i++) expect(doc).toMatch(new RegExp(`^## ${i}\\. `, "m"));
  });

  it("API section names the route, verbs and fields", () => {
    const s = section("## 3.", "## 4.");
    for (const k of ["/api/projects/:name/worktree-setup", "GET", "PUT", "allowedCommands", "files", "command", "timeoutSec"]) {
      expect(s).toContain(k);
    }
    expect(s).toContain("từ 10 đến 900");
  });

  it("run order lists the steps in sequence", () => {
    const s = section("## 4.", "## 5.");
    expect(s).toContain("node_modules");
    expect(s).toContain("createRun");
    const anchors = [
      "1. Tạo worktree",
      "2. Liên kết hoặc chuẩn bị node_modules",
      "3. Chép file",
      "4. Quét ngữ cảnh",
      "5. Tạo bản ghi run (createRun)",
      "6. Chạy lệnh setup",
      "7. Khởi động agent",
    ];
    let last = -1;
    for (const a of anchors) {
      const i = s.indexOf(a);
      expect(i, a).toBeGreaterThan(last);
      last = i;
    }
  });

  it("safety section has the key rules", () => {
    const s = section("## 5.", "## 6.");
    for (const k of ["shell:false", "..", ".gitignore", "180 giây"]) expect(s).toContain(k);
  });

  it("limits section has the numbers with context", () => {
    const s = section("## 6.", "## 7.");
    for (const k of ["20 mẫu", "50 file", "5 MB mỗi file", "20 MB tổng", "180 giây", "từ 10 đến 900", "4000 byte"]) {
      expect(s).toContain(k);
    }
    expect(s).toContain("chưa nằm trong src");
  });

  it("mentions the notice key and result file", () => {
    expect(doc).toContain("worktree.setup.error");
    expect(doc).toContain("worktree-setup.txt");
  });

  it("contains no key-like values", () => {
    for (const re of [/sk-ant-[A-Za-z0-9_-]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /Bearer\s+[A-Za-z0-9._-]{32,}/]) {
      expect(doc).not.toMatch(re);
    }
  });
});
