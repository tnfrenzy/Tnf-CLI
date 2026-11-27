import { lazy } from "react";

// Popup bodies are split out of the entry chunk and fetched the first time their popup opens. App renders all of
// them inside one <Suspense>, so nothing else has to know that they are lazy.

export const CommandPage = lazy(() => import("./pages/CommandPage").then((m) => ({ default: m.CommandPage })));
export const RunsPage = lazy(() => import("./pages/RunsPage").then((m) => ({ default: m.RunsPage })));
export const RunPage = lazy(() => import("./pages/RunPage").then((m) => ({ default: m.RunPage })));
export const HistoryPage = lazy(() => import("./pages/HistoryPage").then((m) => ({ default: m.HistoryPage })));
export const LibraryPage = lazy(() => import("./pages/LibraryPage").then((m) => ({ default: m.LibraryPage })));
export const SettingsPanel = lazy(() => import("./pages/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
export const FloorPopup = lazy(() => import("./office/FloorPopup").then((m) => ({ default: m.FloorPopup })));
export const AddFloorForm = lazy(() => import("./pages/AddFloorForm").then((m) => ({ default: m.AddFloorForm })));
export const AddSkillFloorForm = lazy(() => import("./pages/AddSkillFloorForm").then((m) => ({ default: m.AddSkillFloorForm })));
export const SkillOverviewPopup = lazy(() => import("./components/skills/SkillOverviewPopup").then((m) => ({ default: m.SkillOverviewPopup })));
export const SkillFloorPopup = lazy(() => import("./components/skills/SkillFloorPopup").then((m) => ({ default: m.SkillFloorPopup })));
export const AddConnectionForm = lazy(() => import("./pages/AddConnectionForm").then((m) => ({ default: m.AddConnectionForm })));
export const ApiFloorPopup = lazy(() => import("./components/office/ApiFloorPopup").then((m) => ({ default: m.ApiFloorPopup })));
export const Design3DPopup = lazy(() => import("./components/workshop3d/Design3DPopups").then((m) => ({ default: m.Design3DPopup })));
export const Design3DFloorPopup = lazy(() => import("./components/workshop3d/Design3DPopups").then((m) => ({ default: m.Design3DFloorPopup })));
export const Workshop3DPopup = lazy(() => import("./components/workshop3d/Workshop3DPopup").then((m) => ({ default: m.Workshop3DPopup })));
export const CodeVideoCreatePopup = lazy(() => import("./components/codevideo/CodeVideoPopups").then((m) => ({ default: m.CodeVideoCreatePopup })));
export const CodeVideoRoomPopup = lazy(() => import("./components/codevideo/CodeVideoPopups").then((m) => ({ default: m.CodeVideoRoomPopup })));
export const CodeVideoSettingsPopup = lazy(() => import("./components/codevideo/CodeVideoPopups").then((m) => ({ default: m.CodeVideoSettingsPopup })));

/** Fetch the most-used popup chunks while the browser is idle, so the first click does not wait for the network. */
export function prefetchPopups(): void {
  const run = () => {
    void import("./pages/CommandPage");
    void import("./pages/RunsPage");
    void import("./pages/RunPage");
    void import("./pages/HistoryPage");
    void import("./pages/LibraryPage");
    void import("./pages/SettingsPanel");
    void import("./office/FloorPopup");
  };
  const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(run);
  else setTimeout(run, 1500);
}
