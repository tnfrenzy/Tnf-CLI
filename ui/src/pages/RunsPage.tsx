import { useEffect, useMemo, useState } from "react";
import { api, openSocket } from "../api";
import { useT } from "../i18n";
import { RunTree } from "../components/run/RunTree";
import type { RunRecord } from "../types";

export const RUNS_SHOWN = 50;

/** Live list of runs (overview WebSocket), one tab per environment/project. */
export function RunsPage() {
  const { t } = useT();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(() => {
    try {
      return localStorage.getItem("tnf.runs.project");
    } catch {
      return null;
    }
  });

  useEffect(() => {
    // Only the newest RUNS_SHOWN runs: the full list was ~6 MB (~0.7 s) to open this popup; History keeps the full list.
    api.listRuns({ limit: RUNS_SHOWN }).then((r) => setRuns(r.runs.slice(0, RUNS_SHOWN))).catch((e: Error) => setErr(e.message));
    const ws = openSocket("/ws/overview", (m) => {
      if (m.type === "runs") setRuns(m.runs.slice(0, RUNS_SHOWN));
      if (m.type === "run") setRuns((rs) => (rs.some((r) => r.id === m.run.id) ? rs.map((r) => (r.id === m.run.id ? m.run : r)) : [m.run, ...rs].slice(0, RUNS_SHOWN)));
    });
    return () => ws.close();
  }, []);

  const projects = useMemo(() => {
    const m = new Map<string, { runs: number; running: number; cost: number }>();
    for (const r of runs) {
      const p = m.get(r.project) ?? { runs: 0, running: 0, cost: 0 };
      p.runs++;
      if (r.status === "running") p.running++;
      p.cost += r.cost_usd_est;
      m.set(r.project, p);
    }
    return [...m.entries()];
  }, [runs]);
  const active = project && projects.some(([p]) => p === project) ? project : null;
  const pick = (p: string | null) => {
    setProject(p);
    try {
      if (p) localStorage.setItem("tnf.runs.project", p);
      else localStorage.removeItem("tnf.runs.project");
    } catch {
      /* ignore */
    }
  };
  const shown = active ? runs.filter((r) => r.project === active) : runs;
  const name = (p: string) => (p === "default" ? t.project_default : p);

  return (
    <div className="card">
      {err && <p className="error">{err}</p>}
      <div className="tabs project-tabs">
        <button className={!active ? "active" : ""} onClick={() => pick(null)}>{t.project_all} <span className="count">{runs.length}</span></button>
        {projects.map(([p, s]) => (
          <button key={p} className={active === p ? "active" : ""} onClick={() => pick(p)} title={`${t.quota_used}`}>
            {s.running > 0 ? <span className="live-dot" /> : null}{name(p)} <span className="count">{s.runs}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className="muted">{t.no_runs}</p> : <RunTable runs={shown} showProject={!active} />}
      {runs.length >= RUNS_SHOWN ? <p className="muted fine">{t.runs_recent_hint}</p> : null}
    </div>
  );
}

/** Run list used by RunsPage and HistoryPage: threads (root run + follow-ups) via the shared RunTree. */
export function RunTable({ runs, showProject = true }: { runs: RunRecord[]; showProject?: boolean }) {
  return <RunTree runs={runs} showProject={showProject} />;
}
