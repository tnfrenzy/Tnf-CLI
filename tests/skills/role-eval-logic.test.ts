import { describe, expect, it } from "vitest";
import { buildRunRequest, nextPollDelay } from "../../ui/src/skills/roleEval";

describe("role eval logic", () => {
  it("buildRunRequest clamps and rounds repeats", () => {
    expect(buildRunRequest(0).repeats).toBe(1);
    expect(buildRunRequest(99).repeats).toBe(3);
    expect(buildRunRequest(2.4).repeats).toBe(2);
    expect(buildRunRequest(NaN).repeats).toBe(1);
  });
  it("nextPollDelay", () => {
    const d = nextPollDelay(true);
    expect(typeof d).toBe("number");
    expect(d as number).toBeGreaterThan(0);
    expect(nextPollDelay(false)).toBeNull();
  });
});
