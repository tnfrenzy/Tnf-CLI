import { describe, expect, it } from "vitest";
import { ALL_BUILDING_PROJECTS, classifyRunBuilding, parseBuildingParam } from "../../src/core/run/run-building";
import { RunStore } from "../../src/core/run/run-store";

describe("classifyRunBuilding", () => {
  it("maps internal projects to buildings", () => {
    expect(classifyRunBuilding({ project: "codevideo" })).toBe("video");
    expect(classifyRunBuilding({ project: "videostudio" })).toBe("video");
    expect(classifyRunBuilding({ project: "skill-workshop" })).toBe("skills");
  });
  it("leaves ordinary and 3D workshop runs unclassified", () => {
    expect(classifyRunBuilding({ project: "my-app" })).toBeNull();
    expect(classifyRunBuilding({ project: "workshop3d" })).toBeNull();
  });
  it("parses the query param", () => {
    expect(parseBuildingParam("video")).toBe("video");
    expect(parseBuildingParam("skills")).toBe("skills");
    expect(parseBuildingParam("exclude")).toBe("exclude");
    expect(parseBuildingParam("x")).toBeUndefined();
    expect(parseBuildingParam(null)).toBeUndefined();
  });
  it("covers every building project", () => {
    expect(ALL_BUILDING_PROJECTS).toEqual(["codevideo", "videostudio", "skill-workshop"]);
  });
});

describe("RunStore building filter", () => {
  const mk = (store: RunStore, id: string, project: string, status: "running" | "done" = "done") =>
    store.createRun({ id, status, prompt: "p", mode: "single", model: "sonnet", session_id: null, parent_run_id: null, project, claude_version: null, run_dir: "x" } as never);
  it("splits runs between tabs without overlap", () => {
    const store = new RunStore(":memory:");
    mk(store, "a", "app");
    mk(store, "v1", "codevideo", "running");
    mk(store, "v2", "videostudio");
    mk(store, "s1", "skill-workshop", "running");
    mk(store, "w", "workshop3d");
    const ids = (b: "video" | "skills" | "exclude") => store.listRuns({ building: b }).map((r) => r.id).sort();
    expect(ids("video")).toEqual(["v1", "v2"]);
    expect(ids("skills")).toEqual(["s1"]);
    expect(ids("exclude")).toEqual(["a", "w"]);
    expect(store.countRuns({ building: "video", status: "running" })).toBe(1);
    expect(store.listRunThreads({ building: "skills" }).total).toBe(1);
  });
});
