import { describe, expect, it } from "vitest";
import { buildVersionPatch, versionText } from "../../ui/src/skills/versionDiff";
import { parsePatch } from "../../ui/src/components/run/DiffView";

describe("buildVersionPatch", () => {
  it("starts with the diff --git header, ---/+++ and hunk", () => {
    const p = buildVersionPatch("role.md", "a", "b").split("\n");
    expect(p[0]).toBe("diff --git a/role.md b/role.md");
    expect(p[1]).toBe("--- a/role.md");
    expect(p[2]).toBe("+++ b/role.md");
    expect(p[3]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  });

  it("marks kept, removed and added lines", () => {
    const p = buildVersionPatch("x", "a\nb\nc", "a\nc\nd").split("\n").slice(4);
    expect(p).toEqual([" a", "-b", " c", "+d"]);
  });

  it("identical texts give header only without throwing", () => {
    const p = buildVersionPatch("x", "same", "same");
    expect(p.split("\n")).toHaveLength(3);
    expect(p).not.toContain("@@");
  });

  it("handles empty strings", () => {
    expect(buildVersionPatch("x", "", "").startsWith("diff --git")).toBe(true);
    expect(buildVersionPatch("x", "", "a\nb").split("\n").slice(3)).toEqual(["@@ -0,0 +1,2 @@", "+a", "+b"]);
    expect(buildVersionPatch("x", "a", "").split("\n").slice(3)).toEqual(["@@ -1,1 +0,0 @@", "-a"]);
  });

  it("is readable by DiffView parsePatch", () => {
    const files = parsePatch(buildVersionPatch("x.md", "a\nb", "a\nc"));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("x.md");
    expect(files[0].added).toBe(1);
    expect(files[0].deleted).toBe(1);
  });
});

describe("versionText", () => {
  it("does not throw with missing fields", () => {
    expect(versionText({})).toBe("");
    expect(versionText({ role: {} })).toBe("");
    expect(versionText({ item: {} })).toBe("");
  });

  it("renders role and item fields", () => {
    const r = versionText({ role: { id: "r", description: "d", prompt: "p", tools: ["Read", "Grep"] } });
    expect(r).toContain("prompt: p");
    expect(r).toContain("tools: Read, Grep");
    const i = versionText({ item: { id: "i", name: "N", type: "skill", content: "c", roleIds: [] } });
    expect(i).toContain("content: c");
    expect(i).not.toContain("roleIds");
  });
});
