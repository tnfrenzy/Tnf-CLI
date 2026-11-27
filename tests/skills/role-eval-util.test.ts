import { describe, expect, it } from "vitest";
import { extractToolNames, roleVersionHash } from "../../src/core/roles/role-eval-util.js";

const asst = (...names: string[]) =>
  JSON.stringify({ type: "assistant", message: { content: names.map((name) => ({ type: "tool_use", name, id: "x", input: {} })) } });

describe("extractToolNames", () => {
  it("collects names from multiple blocks, deduped, in order", () => {
    const s = [asst("Read", "Grep"), asst("Read", "Glob")].join("\n");
    expect(extractToolNames(s)).toEqual(["Read", "Grep", "Glob"]);
  });
  it("skips broken and empty lines and empty input", () => {
    expect(extractToolNames("")).toEqual([]);
    expect(extractToolNames(`\n{bad\n${asst("Read")}\n\n`)).toEqual(["Read"]);
  });
  it("ignores non-assistant events and text blocks", () => {
    const user = JSON.stringify({ type: "user", message: { content: [{ type: "tool_use", name: "Bash" }] } });
    const text = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    expect(extractToolNames([user, text].join("\n"))).toEqual([]);
  });
  it("does not throw on strings larger than 5 MB", () => {
    const big = "x".repeat(6 * 1024 * 1024);
    expect(() => extractToolNames(`${asst("Read")}\n${big}\n${asst("Late")}`)).not.toThrow();
    expect(extractToolNames(`${asst("Read")}\n${big}\n${asst("Late")}`)).toEqual(["Read"]);
  });
});

describe("roleVersionHash", () => {
  const base = { id: "r", description: "d", prompt: "p", tools: ["Read", "Grep"] };
  it("is 12 hex chars and stable", () => {
    expect(roleVersionHash(base)).toMatch(/^[0-9a-f]{12}$/);
    expect(roleVersionHash(base)).toBe(roleVersionHash({ ...base }));
  });
  it("changes with prompt or tools", () => {
    expect(roleVersionHash({ ...base, prompt: "q" })).not.toBe(roleVersionHash(base));
    expect(roleVersionHash({ ...base, tools: ["Read"] })).not.toBe(roleVersionHash(base));
  });
  it("is invariant to tools order", () => {
    expect(roleVersionHash({ ...base, tools: ["Grep", "Read"] })).toBe(roleVersionHash(base));
  });
});
