/* Pure mapping from code-driven Video Studio projects to the floors of the 5th tower in the city scene. */

export const MAX_CODEVIDEO_FLOORS = 5;

export type CodeVideoBadge = "running" | "done" | "failed" | "idle";
export type CodeVideoDisplayFloor = { slug: string; name: string; badge: CodeVideoBadge; running: boolean; state: string };

/** Minimal project shape the tower needs; the real list API is wired in a later stage. */
export type CodeVideoListItem = { slug: string; title?: string | undefined; state: string; updatedAt?: string | undefined };

/** Working states -> running, done -> done, failed -> failed; everything else -> idle. */
export function codeVideoBadge(state: string): CodeVideoBadge {
  switch (state) {
    case "planning":
    case "coding":
    case "rendering":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

/** The newest MAX_CODEVIDEO_FLOORS projects (by updatedAt, newest first); broken items are dropped first. */
export function codeVideoTowerFloors(projects: readonly CodeVideoListItem[]): CodeVideoDisplayFloor[] {
  return projects
    .filter((p) => !!p && typeof p.slug === "string" && p.slug !== "")
    .slice()
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_CODEVIDEO_FLOORS)
    .map((p) => {
      const label = typeof p.title === "string" && p.title.trim() ? p.title.replace(/\s+/g, " ").trim() : p.slug;
      const badge = codeVideoBadge(p.state);
      return { slug: p.slug, name: label.length > 34 ? `${label.slice(0, 33)}…` : label, badge, running: badge === "running", state: String(p.state) };
    });
}

export function canAddCodeVideo(count: number): boolean {
  return count < MAX_CODEVIDEO_FLOORS;
}
