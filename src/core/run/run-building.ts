/** Which "building" (workshop) a run belongs to, derived from its internal project name. */
export type RunBuilding = "video" | "skills";
export type RunBuildingFilter = RunBuilding | "exclude";

/** Internal repo-less projects of each building. "videostudio" is the removed legacy Video Studio; old rows may remain. */
export const BUILDING_PROJECTS: Record<RunBuilding, readonly string[]> = {
  video: ["codevideo", "videostudio"],
  skills: ["skill-workshop"],
};

export const ALL_BUILDING_PROJECTS: readonly string[] = [...BUILDING_PROJECTS.video, ...BUILDING_PROJECTS.skills];

/** Building of a run, or null for ordinary (coding / research / queue) runs. */
export function classifyRunBuilding(run: { project: string }): RunBuilding | null {
  for (const b of Object.keys(BUILDING_PROJECTS) as RunBuilding[]) if (BUILDING_PROJECTS[b].includes(run.project)) return b;
  return null;
}

export function parseBuildingParam(v: string | null | undefined): RunBuildingFilter | undefined {
  return v === "video" || v === "skills" || v === "exclude" ? v : undefined;
}
