import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LibraryHistoryView, orderVersions, type LibraryHistoryViewProps } from "../../ui/src/components/skills/LibraryHistory";
import { buildVersionPatch } from "../../ui/src/skills/versionDiff";
import type { LibraryVersion } from "../../ui/src/types";

const noop = () => undefined;
const base: LibraryHistoryViewProps = {
  versions: [], selectedId: null, patch: "", dangerKeywords: [], confirming: false, busy: false, error: null,
  onSelect: noop, onRestore: noop, onConfirm: noop, onClose: noop,
};
const render = (p: Partial<LibraryHistoryViewProps>) => renderToStaticMarkup(createElement(LibraryHistoryView, { ...base, ...p }));
const ver = (id: string, note: string): LibraryVersion => ({ id, kind: "role", entryId: "r1", at: 1700000000000, note });

describe("LibraryHistoryView", () => {
  it("shows the empty state", () => {
    expect(render({})).toContain("Chưa có phiên bản cũ nào.");
  });
  it("lists versions with restore buttons and no delete button", () => {
    const html = render({ versions: [ver("v2", "second"), ver("v1", "first")] });
    expect(html.match(/Khôi phục bản này/g)?.length).toBe(2);
    expect(html).toContain("second");
    expect(html).not.toMatch(/Xóa|Delete/);
  });
  it("orderVersions keeps newest-first order", () => {
    const list = [ver("v3", "n3"), ver("v2", "n2"), ver("v1", "n1")];
    expect(orderVersions(list).map((v) => v.id)).toEqual(["v3", "v2", "v1"]);
  });
  it("labels the newest version with the highest number", () => {
    const html = render({ versions: orderVersions([ver("v3", "n3"), ver("v2", "n2"), ver("v1", "n1")]) });
    expect(html).toMatch(/ 3 · [^<]*n3/);
    expect(html).toMatch(/ 1 · [^<]*n1/);
    expect(html.indexOf("n3")).toBeLessThan(html.indexOf("n1"));
  });
  it("LibraryHistory source uses orderVersions and no longer reverses", () => {
    const src = readFileSync(resolve(__dirname, "../../ui/src/components/skills/LibraryHistory.tsx"), "utf8");
    expect(src).toContain("orderVersions(");
    expect(src).not.toContain(".reverse()");
  });
  it("shows the danger warning and confirm button", () => {
    const html = render({ versions: [ver("v1", "")], selectedId: "v1", dangerKeywords: ["rm -rf"], confirming: true });
    expect(html).toContain("từ khóa nguy hiểm");
    expect(html).toContain("rm -rf");
    expect(html).toContain("Xác nhận khôi phục");
  });
  it("shows the diff patch content", () => {
    const patch = buildVersionPatch("r1", "prompt: old", "prompt: brand-new");
    const html = render({ versions: [ver("v1", "")], selectedId: "v1", patch });
    expect(html).toContain("brand-new");
  });
});
