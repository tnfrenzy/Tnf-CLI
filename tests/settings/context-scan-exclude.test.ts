import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildContextBlock } from "../../src/core/run/context-scan.js";

function setup(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-excl-"));
  fs.writeFileSync(path.join(dir, ".env"), "SECRET_TOKEN=abc");
  fs.writeFileSync(path.join(dir, "README.md"), "hello readme");
  return dir;
}

const cfg = { enabled: true, maxBytes: 4096, files: [".env", "README.md"] };

describe("buildContextBlock exclude", () => {
  it("includes the file when exclude is not given", () => {
    const b = buildContextBlock({ worktree: setup(), cfg });
    expect(b.loaded.map((l) => l.name)).toEqual([".env", "README.md"]);
  });

  it("drops excluded files, case-insensitively and with backslashes", () => {
    const wt = setup();
    const b = buildContextBlock({ worktree: wt, cfg, exclude: [".ENV"] });
    expect(b.loaded.map((l) => l.name)).toEqual(["README.md"]);
    expect(b.text).not.toContain("SECRET_TOKEN");
    const c = buildContextBlock({ worktree: wt, cfg: { ...cfg, files: ["sub/x.txt"] }, exclude: ["SUB\\X.txt"] });
    expect(c.text).toBe("");
  });
});
