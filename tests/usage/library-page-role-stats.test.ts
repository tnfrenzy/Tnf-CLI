import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../ui/src/skills/useLibrary", () => ({
  useLibrary: () => ({ lib: null, error: null, reload: async () => undefined }),
}));

import { LibraryPage } from "../../ui/src/pages/LibraryPage";

const html = renderToStaticMarkup(createElement(LibraryPage, { status: null }));
const source = readFileSync(fileURLToPath(new URL("../../ui/src/pages/LibraryPage.tsx", import.meta.url)), "utf8");

describe("LibraryPage role stats block", () => {
  it("shows the title and the show toggle, collapsed by default", () => {
    expect(html).toContain("Thống kê vai");
    expect(html).toContain("Hiện thống kê vai");
    expect(html).not.toContain("Ẩn thống kê vai");
  });
  it("does not mount RoleStatsTable while collapsed", () => {
    expect(html).not.toContain("Đang tải thống kê");
  });
  it("references RoleStatsTable in the source without props", () => {
    expect(source).toContain("<RoleStatsTable />");
    expect(source).toMatch(/import \{ RoleStatsTable \} from/);
  });
});
