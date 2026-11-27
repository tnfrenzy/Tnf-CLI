import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dicts } from "../../ui/src/i18n";
import { RoleEvalPanel } from "../../ui/src/components/skills/RoleEvalPanel";

const src = readFileSync("ui/src/components/skills/RoleEvalPanel.tsx", "utf8");

describe("RoleEvalPanel", () => {
  it("renders the loading string initially", () => {
    const html = renderToString(createElement(RoleEvalPanel, { roleId: "r1" }));
    expect(html).toContain(dicts.vi.lib_eval_loading);
  });
  it("imports buildRunRequest and nextPollDelay from skills/roleEval", () => {
    expect(src).toMatch(/import\s*\{[^}]*\bbuildRunRequest\b[^}]*\}\s*from\s*["'][^"']*skills\/roleEval["']/);
    expect(src).toMatch(/import\s*\{[^}]*\bnextPollDelay\b[^}]*\}\s*from\s*["'][^"']*skills\/roleEval["']/);
  });
  it("clears timers and calls the api", () => {
    expect(src).toContain("clearTimeout");
    expect(src).toContain("api.cancelRoleEvals");
    expect(src).toContain("api.saveRoleEvals");
    expect(src).toContain("api.runRoleEvals");
  });
});
