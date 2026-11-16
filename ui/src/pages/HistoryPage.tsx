import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { fmtQuota } from "../components/run/AgentTree";
import { fmtQuotaRange } from "../run/quotaFormat";
import { Modal } from "../components/common/Modal";
import { TaskListModal } from "../components/run/TaskListModal";
import { ScoutReview } from "../components/queue/ScoutReview";
import { UsageBlocksPanel } from "../components/settings/UsageBlocksPanel";
import { useT } from "../i18n";
import { HISTORY_PAGE_SIZE, clampPage, pageCount, pageOffset } from "../lib/pagination";
import { isScoutPrompt } from "../queue/scoutAgent";
import { hideScoutRun, loadScoutHidden } from "../lib/prefs";
import type { RunRecord } from "../types";
import { RunTable } from "./RunsPage";

export function HistoryPage({ queueProject }: { queueProject?: string } = {}) {
  const { t, lang } = useT();
  // Queue runs are kept out of the normal history; they show only under the "Hàng đợi" tab.
  const [tab, setTab] = useState<"all" | "queue" | "scout">(queueProject ? "queue" : "all");
  const [repoProjects, setRepoProjects] = useState<string[]>([]);
  const [qProject, setQProject] = useState(queueProject ?? "");
  useEffect(() => {
    api.projects().then((r) => {
      const names = r.projects.filter((p) => p.repo_path).map((p) => p.name);
      setRepoProjects(names);
      setQProject((cur) => cur || names[0] || "");
    }).catch(() => {});
  }, []);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [days, setDays] = useState<{ day: string; cost_usd_est: number; quota_pct: number; runs: number }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [review, setReview] = useState<{ project: string; runId: string } | null>(null);
  const [scoutRuns, setScoutRuns] = useState<RunRecord[]>([]);
  const [reportOpen, setReportOpen] = useState(false);
  const [hidden, setHidden] = useState<string[]>(() => loadScoutHidden());
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pages = pageCount(total, HISTORY_PAGE_SIZE);

  // Changing any filter returns to the first page.
  useEffect(() => { setPage(1); }, [q, status, from, to, tab]);

  const load = useCallback(() => {
    // threads: a page holds HISTORY_PAGE_SIZE threads (root run + all its follow-ups), so replies never split across pages.
    const p: Parameters<typeof api.listRuns>[0] = { limit: HISTORY_PAGE_SIZE, offset: pageOffset(page, HISTORY_PAGE_SIZE), queue: tab === "queue" ? "only" : "exclude", threads: true };
    if (tab === "queue" && qProject) p.project = qProject;
    if (q) p.q = q;
    if (status) p.status = status;
    if (from) p.from = new Date(from).getTime();
    if (to) p.to = new Date(to).getTime() + 86_400_000 - 1;
    api.listRuns(p).then((r) => {
      setRuns(r.runs);
      const n = r.total ?? r.runs.length;
      setTotal(n);
      const last = clampPage(page, n, HISTORY_PAGE_SIZE);
      if (last !== page) setPage(last);
    }).catch((e: Error) => setErr(e.message));
    // "Duyệt đề xuất" list: its own query, independent of the current page and filters.
    api.listRuns({ scout: true, ...(tab === "scout" ? {} : { status: "done" }), limit: 50 }).then((r) => setScoutRuns(r.runs.filter((x) => isScoutPrompt(x.prompt)))).catch(() => {});
  }, [q, status, from, to, page, tab, qProject]);

  // Daily cost report: loaded only when the report modal opens.
  useEffect(() => {
    if (reportOpen) api.costsByDay().then((r) => setDays(r.days)).catch(() => {});
  }, [reportOpen]);

  useEffect(() => {
    const id = setTimeout(load, 200);
    return () => clearTimeout(id);
  }, [load]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" className={`mini${tab === "all" ? " active" : ""}`} aria-pressed={tab === "all"} onClick={() => setTab("all")}>{t.nav_history}</button>
        <button type="button" className={`mini${tab === "queue" ? " active" : ""}`} aria-pressed={tab === "queue"} onClick={() => setTab("queue")}>{t.queue_history_btn}</button>
        <button type="button" className={`mini${tab === "scout" ? " active" : ""}`} aria-pressed={tab === "scout"} onClick={() => setTab("scout")}>{t.scout_tab}</button>
      </div>
      {tab === "scout" && (
        <div className="card">
          {scoutRuns.filter((r) => !hidden.includes(r.id)).length === 0 ? <p className="muted">{t.scout_tab_empty}</p> : null}
          {scoutRuns.filter((r) => !hidden.includes(r.id)).map((r) => (
            <div key={r.id} className="row fine" style={{ marginBottom: 6 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
                {r.project} · <a href={"#/runs/" + r.id}>{r.id}</a> · {r.status} · {new Date(r.created_at).toLocaleString("vi-VN")} · {t.quota_5h}: {fmtQuotaRange(r.quota_start, r.quota_end, r.quota_pct)}{r.quota7_start != null ? ` · ${t.quota_week}: ${fmtQuotaRange(r.quota7_start, r.quota7_end, r.quota7_pct)}` : ""}
              </span>
              <button type="button" className="mini" disabled={r.status !== "done"} onClick={() => setReview({ project: r.project, runId: r.id })}>{t.scoutReview_reopen}</button>
              <button type="button" className="mini" onClick={() => { if (window.confirm(t.scout_delete_ask)) setHidden(hideScoutRun(r.id)); }}>{t.scout_delete}</button>
            </div>
          ))}
          <p className="muted">{t.scout_tab_note}</p>
        </div>
      )}
      {tab === "queue" && qProject && (
        <div className="card">
          {repoProjects.length > 1 && (
            <select aria-label={t.queue_history_btn} value={qProject} onChange={(e) => setQProject(e.target.value)} style={{ marginBottom: 8 }}>
              {repoProjects.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          <TaskListModal project={qProject} key={qProject} />
        </div>
      )}
      <div className="card">
        <div className="row">
          <input placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 260 }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t.all_status}</option>
            <option value="running">{t.status_running}</option>
            <option value="done">{t.status_done}</option>
            <option value="error">{t.status_error}</option>
            <option value="cancelled">{t.status_cancelled}</option>
          </select>
          <label className="muted">{t.from} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="muted">{t.to} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button onClick={load}>{t.reload}</button>
          <button type="button" className="icon-btn" title={t.history_report} aria-label={t.history_report} onClick={() => setReportOpen(true)} style={{ marginLeft: "auto" }}>📊</button>
        </div>
      </div>
        <div className="card" style={{ width: "100%" }}>
          {err && <p className="error">{err}</p>}
          {tab === "all" && scoutRuns.filter((r) => !hidden.includes(r.id)).map((r) => (
            <div key={r.id} className="row fine" style={{ marginBottom: 6 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{r.project} · {r.id}</span>
              <button type="button" className="mini" onClick={() => setReview({ project: r.project, runId: r.id })}>{t.scoutReview_reopen}</button>
            </div>
          ))}
          {runs.length === 0 ? <p className="muted">{t.no_runs}</p> : <RunTable runs={runs} />}
          <div className="row fine" style={{ marginTop: 8, justifyContent: "center" }}>
            <button type="button" className="mini" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t.history_prev}</button>
            <span>{t.history_page} {page}/{pages}</span>
            <button type="button" className="mini" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t.history_next}</button>
          </div>
          {review && (
            <Modal title={t.scoutReview_title} sub={review.project} size="large" onClose={() => setReview(null)}>
              <ScoutReview project={review.project} scoutRunId={review.runId} lang={lang} onClose={() => setReview(null)} />
            </Modal>
          )}
        </div>
      {reportOpen && (
        <Modal title={t.history_report_title} sub={t.cost_by_day} onClose={() => setReportOpen(false)}>
          <UsageBlocksPanel />
          <table>
            <thead><tr><th>{t.history_report_day}</th><th>{t.nav_runs}</th><th>{t.quota_used}</th></tr></thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}><td>{d.day}</td><td>{d.runs}</td><td>{fmtQuota(d.quota_pct)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{t.cost_note}</p>
        </Modal>
      )}
    </div>
  );
}
