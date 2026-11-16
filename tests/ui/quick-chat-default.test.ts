import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dicts } from "../../ui/src/i18n.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("quick chat targets the default environment", () => {
  const src = read("../../ui/src/components/LeftPanel.tsx");
  it("submit ignores the selected env and has a role picker button", () => {
    expect(src).toContain('const submit = () => onOpen("cmd", { projectName: "default"');
    expect(src).not.toContain("projectName: env");
    expect(src).not.toContain("env-current\">{t.ss_env_pick}");
    expect(src).toContain("rolesOpen: true");
    expect(src).toContain("t.ss_pick_roles");
  });
  it("CommandPage accepts initialRolesOpen and App forwards it", () => {
    expect(read("../../ui/src/pages/CommandPage.tsx")).toContain("initialRolesOpen");
    expect(read("../../ui/src/App.tsx")).toContain("initialRolesOpen: true");
  });
  it("i18n has the label in vi and en", () => {
    expect((dicts.vi as Record<string, string>).ss_pick_roles).toBe("Chọn vai");
    expect((dicts.en as Record<string, string>).ss_pick_roles).toBeTruthy();
  });
});
