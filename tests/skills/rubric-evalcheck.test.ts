import { describe, expect, it } from "vitest";
import { evalRubricCheck, type RubricCheck } from "../../src/core/skill-workshop/rubric.js";

const ev = (c: RubricCheck | undefined, o: string) => evalRubricCheck(c, o);

describe("evalRubricCheck", () => {
  it("undefined check scores 0", () => {
    expect(ev(undefined, "x")).toBe(0);
  });
  it("contains", () => {
    expect(ev({ type: "contains", value: "ab" }, "xaby")).toBe(1);
    expect(ev({ type: "contains", value: "ab" }, "xy")).toBe(0);
  });
  it("not-contains", () => {
    expect(ev({ type: "not-contains", value: "ab" }, "xaby")).toBe(0);
    expect(ev({ type: "not-contains", value: "ab" }, "xy")).toBe(1);
  });
  it("regex", () => {
    expect(ev({ type: "regex", pattern: "^a+$" }, "aaa")).toBe(1);
    expect(ev({ type: "regex", pattern: "^a+$" }, "b")).toBe(0);
    expect(ev({ type: "regex", pattern: "abc" }, "xABCx")).toBe(0);
    expect(ev({ type: "regex", pattern: "abc", flags: "i" }, "xABCx")).toBe(1);
  });
  it("invalid regex scores 0", () => {
    expect(ev({ type: "regex", pattern: "(" }, "(")).toBe(0);
    expect(ev({ type: "regex", pattern: "a", flags: "gg" }, "a")).toBe(0);
  });
  it("max-length", () => {
    expect(ev({ type: "max-length", max: 3 }, "abc")).toBe(1);
    expect(ev({ type: "max-length", max: 3 }, "abcd")).toBe(0);
  });
  it("min-length", () => {
    expect(ev({ type: "min-length", min: 3 }, "abc")).toBe(1);
    expect(ev({ type: "min-length", min: 3 }, "ab")).toBe(0);
  });
  it("section-present", () => {
    expect(ev({ type: "section-present", heading: "Tiêu đề" }, "intro\n## tiêu ĐỀ\nbody")).toBe(1);
    expect(ev({ type: "section-present", heading: "Tiêu đề" }, "text ## Tiêu đề\n")).toBe(0);
    expect(ev({ type: "section-present", heading: "C++ (v2)" }, "# C++ (v2)\n")).toBe(1);
    expect(ev({ type: "section-present", heading: "C++ (v2)" }, "# C (v2)\n")).toBe(0);
  });
  describe("json-schema", () => {
    const mk = (schema: Record<string, unknown>): RubricCheck => ({ type: "json-schema", schema });
    it("invalid or non-object JSON scores 0", () => {
      expect(ev(mk({}), "{bad")).toBe(0);
      expect(ev(mk({}), "null")).toBe(0);
      expect(ev(mk({}), "5")).toBe(0);
    });
    it("no usable required scores 1", () => {
      expect(ev(mk({}), "{}")).toBe(1);
      expect(ev(mk({ required: "a" }), "{}")).toBe(1);
      expect(ev(mk({ required: [] }), "{}")).toBe(1);
    });
    it("ratio of required keys present", () => {
      const c = mk({ required: ["a", "b"] });
      expect(ev(c, '{"a":1}')).toBe(0.5);
      expect(ev(c, '{"a":1,"b":2}')).toBe(1);
      expect(ev(c, "{}")).toBe(0);
    });
  });
  it("unknown check type scores 0", () => {
    expect(ev({ type: "weird" } as never, "x")).toBe(0);
  });
});
