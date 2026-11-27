import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../ui/src/skills/useLibrary", () => ({
  useLibrary: () => ({ lib: null, error: null, reload: async () => undefined }),
}));

import { LibraryPage } from "../../ui/src/pages/LibraryPage";

const src = readFileSync(resolve(__dirname, "../../ui/src/pages/LibraryPage.tsx"), "utf8");

describe("LibraryPage eval button (source)", () => {
  it("imports RoleEvalPanel and showEvalButton", () => {
    expect(src).toMatch(/import\s*\{\s*RoleEvalPanel\s*\}/);
    expect(src).toMatch(/import\s*\{\s*showEvalButton\s*\}/);
  });
  it("uses lib_eval_button and a single evalRoleId state", () => {
    expect(src).toContain("lib_eval_button");
    expect(src).toMatch(/useState<string \| null>\(null\)/);
    expect(src).toContain("evalRoleId");
  });
  it("renders with empty data without throwing", () => {
    expect(() => renderToStaticMarkup(createElement(LibraryPage, { status: null }))).not.toThrow();
  });
});
