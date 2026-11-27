import { describe, expect, it } from "vitest";
import { SANDBOX_DISALLOWED_TOOLS, assertSandboxTools, buildSandboxAllowedTools } from "../../src/core/run/permissions.js";

const DIR = "D:\\data\\codevideo\\demo";

describe("sandbox-write tools", () => {
  it("builds a list where Write/Edit are scoped to the project folder", () => {
    const tools = buildSandboxAllowedTools({ projectDir: DIR });
    expect(tools).toContain("Write(D:/data/codevideo/demo/**)");
    expect(tools).toContain("Edit(D:/data/codevideo/demo/**)");
    expect(tools.some((t) => /^(Bash|WebFetch|WebSearch|Agent)/.test(t))).toBe(false);
  });

  it("refuses shell, agents and network tools", () => {
    for (const t of SANDBOX_DISALLOWED_TOOLS) {
      expect(() => assertSandboxTools([t], [DIR])).toThrow(/không được cấp/);
    }
  });

  it("refuses an unscoped or out-of-folder Write/Edit", () => {
    expect(() => assertSandboxTools(["Write"], [DIR])).toThrow(/thư mục dự án/);
    expect(() => assertSandboxTools(["Edit(D:/other/**)"], [DIR])).toThrow(/thư mục dự án/);
    expect(() => assertSandboxTools(["Write(D:/data/codevideo/demo/../x/**)"], [DIR])).toThrow(/thư mục dự án/);
  });

  it("allows read tools", () => {
    expect(() => assertSandboxTools(["Read(D:/x/**)", "Grep(D:/x/**)"], [DIR])).not.toThrow();
  });
});
