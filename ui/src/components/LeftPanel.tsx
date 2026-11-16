import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./common/Modal";
import { ScoutReview } from "./queue/ScoutReview";
import { api, openSocket, type WsMessage } from "../api";
import { nextConfirmStep, type ConfirmAction, type ConfirmState } from "../lib/confirm";
import { useT } from "../i18n";
import { quotaNoticeText } from "../run/costEstimate";
import { showQueue } from "../office/floors";
import { initialChips,reduceChips, type ChipsState } from "../office/role-chips";
import { buildScoutPrompt, canScout, scoutConfirmText, SCOUT_FOCUS_IDS, type ScoutFocus } from "../queue/scoutAgent";
import { loadSkipped } from "../queue/scoutSkipped";
import { loadScoutFocus, saveScoutFocus } from "../lib/prefs";
import type { PopupId, PopupPayload } from "../lib/popup";
import type { ViewMode } from "../lib/view-mode";
import type { ProjectSummary, RunRecord, StatusResponse } from "../types";

/** At most this many running runs get a live WebSocket for role chips. */
const MAX_LIVE_RUNS = 2;

function useProjectsAndRuns(reloadKey: number, intervalMs = 5000): { projects: ProjectSummary[]; running: RunRecord[] } {
  const [state, setState] = useState<{ projects: ProjectSummary[]; running: RunRecord[] }>({ projects: [], running: [] });
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const { projects } = await api.projects();
        const running = projects.some((p) => p.running > 0) ? (await api.listRuns({ status: "running" })).runs : [];
        if (!dead) setState({ projects, running });
      } catch {
        /* keep previous state */
      }
    };
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, intervalMs);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [intervalMs, reloadKey]);
  return state;
}

function useRunChips(runId: string | null, roles: string[]): ChipsState {
  const rolesKey = roles.join("|");
  const [state, setState] = useState<ChipsState>(() => initialChips(roles));
  useEffect(() => {
    setState(initialChips(rolesKey ? rolesKey.split("|") : []));
    if (!runId) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = openSocket(
        `/ws/runs/${encodeURIComponent(runId)}?after=0`,
        (m: WsMessage) => {
          if (m.type === "event") setState((s) => reduceChips(s, m.stored.event));
        },
        () => {
          if (!closed) timer = setTimeout(connect, 2000);
        },
      );
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [runId, rolesKey]);
  return state;
}

function EnvRow(props: { project: ProjectSummary; floorNo: number; selected: boolean; onSelect: () => void; runId: string | null; roles: string[]; onDeleted: (name: string) => void; onOpen: (id: PopupId, payload?: PopupPayload) => void }) {
  const { project, floorNo, selected, onSelect, runId, roles, onDeleted, onOpen } = props;
  const { t, lang } = useT();
  const [scoutBusy, setScoutBusy] = useState(false);
  const [reviewRun, setReviewRun] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [focus, setFocus] = useState<ScoutFocus[]>(() => loadScoutFocus());
  const toggleFocus = (id: ScoutFocus) => {
    const next = focus.includes(id) ? focus.filter((x) => x !== id) : [...focus, id];
    if (next.length === 0) return; // the last ticked group cannot be unticked
    const ordered = SCOUT_FOCUS_IDS.filter((x) => next.includes(x));
    setFocus(ordered);
    saveScoutFocus(ordered);
  };
  const scoutOk = canScout({ hasRepo: project.repo_path != null, running: project.running, busy: scoutBusy });
  const scout = async () => {
    if (!scoutOk || !window.confirm(scoutConfirmText(lang))) return;
    setScoutBusy(true);
    setErr(null);
    try {
      const { run } = await api.startRun({ prompt: buildScoutPrompt(project.name, lang, { focus, skipped: loadSkipped(project.name) }), project: project.name, kind: "coding", scout: true });
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        if (!alive.current) return;
        const meta = await api.getRun(run.id);
        if (meta.run.status === "running") continue;
        if (meta.run.status === "done") setReviewRun(run.id);
        else onOpen("run", { runId: run.id });
        break;
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setScoutBusy(false);
    }
  };
  const { chips } = useRunChips(runId, roles);
  const busy = project.running > 0;
  const [step, setStep] = useState<ConfirmState>("idle");
  const [err, setErr] = useState<string | null>(null);
  const advance = (action: ConfirmAction) => {
    const next = nextConfirmStep(step, action);
    setStep(next);
    if (next !== "execute") return;
    setErr(null);
    api.deleteProject(project.name).then(
      () => { setStep(nextConfirmStep("execute", "done")); onDeleted(project.name); },
      (e: unknown) => { setStep("idle"); setErr(e instanceof Error ? e.message : String(e)); },
    );
  };
  return (
    <div className={`run-row env-row${selected ? " selected" : ""}`} onClick={onSelect} role="radio" aria-checked={selected}>
      <div className="env-main" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, width: "100%" }}>
        <span className={`dot${busy ? "" : " idle"}`} />
        <div className="env-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "40%", flex: "0 1 auto" }}>{project.name}</div>
        <div className="steps" style={{ margin: 0, flex: "1 1 auto", minWidth: 0 }}>
          {chips.map((c) => (
            <span key={c.role} className={`step ${c.state === "working" ? "doing" : c.state === "done" ? "done" : c.state === "error" ? "bad" : ""}`}>{c.role}</span>
          ))}
        </div>
        <div className="env-actions" style={{ display: "flex", flexWrap: "nowrap", gap: 4, marginLeft: "auto" }}>
          {showQueue(project.name, project.repo_path) && (
            <button type="button" className="mini" onClick={(e) => { e.stopPropagation(); onOpen("floor", { projectName: project.name, floorNo }); }}>{t.queue_title}</button>
          )}
          <button type="button" className="mini" disabled={!scoutOk} title={scoutOk ? t.env_scout_tip : t.env_scout_need_repo} onClick={(e) => { e.stopPropagation(); void scout(); }}>{scoutBusy ? t.env_scout_busy : t.env_scout}</button>
          {project.name !== "default" && step === "idle" && (
            <button type="button" className="mini" onClick={(e) => { e.stopPropagation(); advance("ask"); }}>{t.floor_delete}</button>
          )}
        </div>
      </div>
      <div style={{ minWidth: 0, width: "100%" }}>
        {project.repo_path != null && (
          <div className="fine scout-focus" style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
            <span>{t.scoutFocus_title}:</span>
            {SCOUT_FOCUS_IDS.map((id) => {
              const on = focus.includes(id);
              return (
                <label key={id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <input type="checkbox" checked={on} disabled={on && focus.length === 1} onChange={() => toggleFocus(id)} />
                  {t[`scoutFocus_${id}`]}
                </label>
              );
            })}
          </div>
        )}
        {step === "confirm" && (
          <div className="fine" onClick={(e) => e.stopPropagation()}>
            <span className="warn">{t.floor_delete_confirm1}</span>{" "}
            <button type="button" className="mini" onClick={() => advance("confirm")}>{t.floor_delete_confirm2}</button>{" "}
            <button type="button" className="mini" onClick={() => advance("cancel")}>{t.cleanup_no}</button>
          </div>
        )}
        {err && <div className="fine" style={{ color: "var(--err)" }}>{err}</div>}
        {reviewRun && (
          <div onClick={(e) => e.stopPropagation()}>
            <Modal title={t.scoutReview_title} sub={project.name} size="large" onClose={() => setReviewRun(null)}>
              <ScoutReview project={project.name} scoutRunId={reviewRun} lang={lang} onClose={() => setReviewRun(null)} />
            </Modal>
          </div>
        )}
      </div>
    </div>
  );
}

export function LeftPanel(props: { apiFloors?: { id: string; name: string; text: string }[]; status: StatusResponse | null; statusErr: string | null; towerName: string; env: string; pickEnv: (name: string) => void; onOpen: (id: PopupId, payload?: PopupPayload) => void; view: ViewMode; onToggleView: () => void }) {
  const { t } = useT();
  const { apiFloors = [], status, statusErr, towerName, onOpen, env, pickEnv, view, onToggleView } = props;
  const [draft, setDraft] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const { projects, running } = useProjectsAndRuns(reloadKey);
  const onDeleted = (name: string) => {
    // The chosen floor was deleted: fall back to the first remaining floor, else default.
    if ((env || "default") === name) {
      const next = projects.find((p) => p.name !== name && p.name !== "default");
      pickEnv(next ? next.name : "default");
    }
    setReloadKey((k) => k + 1);
  };
  const roles = useMemo(() => Object.keys(status?.role_models_coding ?? {}), [status]);
  const liveRunByProject = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of [...running].sort((a, b) => b.created_at - a.created_at)) {
      if (m.size >= MAX_LIVE_RUNS) break;
      if (!m.has(r.project)) m.set(r.project, r.id);
    }
    return m;
  }, [running]);

  const notices: { key: string; text: string; err: boolean }[] = [];
  if (statusErr) notices.push({ key: "se", text: statusErr, err: true });
  if (status?.auth_error) notices.push({ key: "ae", text: status.auth_error, err: true });
  if (status?.claude_error) notices.push({ key: "ce", text: status.claude_error, err: true });
  if (status?.git_error) notices.push({ key: "ge", text: status.git_error, err: true });
  const rl = status?.rate_limit;
  if (rl) {
    const hot = (rl.five_hour_pct ?? 0) >= 90 || (rl.seven_day_pct ?? 0) >= 90;
    notices.push({ key: "rl", text: quotaNoticeText(rl, running, t), err: hot });
  }

  const viewLabel = view === "city" ? t.view_to_office : t.view_to_city;
  // Quick chat always targets the default environment (research), whatever floor is selected.
  const submit = () => onOpen("cmd", { projectName: "default", ...(draft.trim() ? { prompt: draft.trim() } : {}) });
  const pickRoles = () => onOpen("cmd", { projectName: "default", rolesOpen: true, ...(draft.trim() ? { prompt: draft.trim() } : {}) });

  return (
    <aside className="side">
      <div className="side-head">
        <img className="logo" src="/logo.png" alt="" width={36} height={36} />
        <div className="brand">{t.app}<small>{towerName}</small></div>
      </div>
      <div className="work">
        <div>
          <h4>{t.ss_work}</h4>
          <div className="cmd">
            <input value={draft} placeholder={t.ss_cmd_placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            <button type="button" className="btn" onClick={submit}>{t.ss_send}</button>
          </div>
          <div className="env-current"><button type="button" className="mini" onClick={pickRoles}>{t.ss_pick_roles}</button></div>
        </div>
        <div className="card">
          <h4>{towerName} · {t.ss_envs}<button type="button" className="mini" onClick={() => onOpen("addFloor")}>＋ {t.ss_add_floor}</button></h4>
          {projects.length === 0 ? <div className="fine">{t.ss_no_envs}</div> : null}
          {projects.map((p, i) => (
            <EnvRow key={p.name} project={p} floorNo={i + 1} selected={(env || "default") === p.name} onSelect={() => pickEnv(p.name)} runId={liveRunByProject.get(p.name) ?? null} roles={roles} onDeleted={onDeleted} onOpen={onOpen} />
          ))}
        </div>
        <div className="card">
          <h4>{t.tower_api}<button type="button" className="mini" onClick={() => onOpen("addApiFloor")}>＋ {t.api_add_short}</button></h4>
          {apiFloors.length === 0 ? <div className="fine">{t.api_none}</div> : null}
          {apiFloors.map((f) => (
            <button type="button" key={f.id} className="mini" style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 4 }} onClick={() => onOpen("apiFloor", { connectionId: f.id })}>
              <b>{f.name}</b> <span className="fine">{f.text}</span>
            </button>
          ))}
        </div>
        <div className="card">
          <h4>{t.ss_notices}</h4>
          <div className="fine" style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {notices.length === 0 ? <span>{t.ss_no_notices}</span> : notices.map((n) => <span key={n.key} style={n.err ? { color: "var(--err)" } : undefined}>{n.text}</span>)}
          </div>
        </div>
      </div>
      <nav className="nav">
        <button type="button" title={t.ss_btn_run} aria-label={t.ss_btn_run} onClick={() => onOpen("cmd")}>▶</button>
        <button type="button" title={t.nav_history} aria-label={t.nav_history} onClick={() => onOpen("history")}>🕘</button>
        <button type="button" className="view-toggle" title={viewLabel} aria-label={viewLabel} onClick={onToggleView}>{view === "city" ? "🏢" : "🏙"}</button>
        <button type="button" title={t.ss_settings} aria-label={t.ss_settings} onClick={() => onOpen("settings")}>⚙</button>
      </nav>
      <div className="note">{t.cost_note}</div>
    </aside>
  );
}
