import { useCallback, useEffect, useRef, useState } from "react";
import { codeVideoApi } from "../codevideo/client";
import { codeVideoBadge, type CodeVideoListItem } from "./codevideo-floors";

const BUSY_MS = 5_000;
const IDLE_MS = 30_000;

/**
 * Code-driven Video Studio tower: GET /api/codevideo. Reloads every 5 s while a project is busy, every 30 s otherwise;
 * the previous list is kept when a request fails (the studio may answer 503 while unavailable).
 */
export function useCodeVideoFloors(): { projects: CodeVideoListItem[]; reload: () => void } {
  const [projects, setProjects] = useState<CodeVideoListItem[]>([]);
  const busy = useRef(false);
  const load = useCallback(async () => {
    try {
      const r = await codeVideoApi.list();
      const list = Array.isArray(r.projects) ? r.projects : [];
      busy.current = list.some((p) => codeVideoBadge(p.state) === "running");
      setProjects(list);
    } catch {
      /* keep the previous state */
    }
  }, []);
  useEffect(() => {
    void load();
    let last = Date.now();
    const id = setInterval(() => {
      if (document.hidden) return;
      const due = busy.current ? BUSY_MS : IDLE_MS;
      if (Date.now() - last >= due - 200) {
        last = Date.now();
        void load();
      }
    }, BUSY_MS);
    return () => clearInterval(id);
  }, [load]);
  return { projects, reload: () => void load() };
}
