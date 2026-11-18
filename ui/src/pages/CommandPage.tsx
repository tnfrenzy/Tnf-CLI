import { useEffect, useMemo, useState } from "react";
import { PREF_PROJECT, recall, remember } from "../lib/prefs";
import { api, ApiError } from "../api";
import { navigate } from "../App";
import { AttachBox } from "../components/common/AttachBox";
import { roleLabel, useT } from "../i18n";
import { SAFE_AGENT_TOOLS, type InboxFile, type ProjectSummary, type RunKind, type StatusResponse } from "../types";
import { ClaudeGuide, needsGuide } from "../components/skills/ClaudeGuide";
import { RunLibraryPicker } from "../components/skills/RunLibraryPicker";
import { MAX_RUN_AGENTS, extractSlots, planRunAgents } from "../skills/library";
import { dailyWarning, formatEstimate, liveQuotaLabel, localDayKey, type CostStats } from "../run/costEstimate";
import { effectiveKind as pickEffectiveKind } from "../run/runKind";
import { useLibrary } from "../skills/useLibrary";
import { DEFAULT_MAX_ROLE_CALLS, DEFAULT_MAX_ROLE_CALLS_CEILING, validateMaxRoleCalls } from "../run/runLimits";

const ROLE_ORDER = ["analyst", "planner", "critic", "implementer", "qa", "debug", "searcher", "analyzer", "synthesizer"];
const NEW = "__new__";


type RepoCheck = { ok: boolean; head_sha: string | null; dirty: boolean; branches: string[]; error: string | null };

export function CommandPage({ status, onRecheck, initialPrompt, initialProject, initialRolesOpen }: { status: StatusResponse | null; onRecheck?: () => void; initialPrompt?: string; initialProject?: string; initialRolesOpen?: boolean }) {
  const { t, lang } = useT();
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [maxTurns, setMaxTurns] = useState(40);
  const [budget, setBudget] = useState(3);
  const [model, setModel] = useState("");
  const [project, setProject] = useState(() => (initialProject !== undefined ? (initialProject === "default" ? "" : initialProject) : recall(PREF_PROJECT)));
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [roleModels, setRoleModels] = useState<Record<string, string>>({});
  const [extraRows, setExtraRows] = useState<{ name: string; description: string; prompt: string; tools: string[] }[]>([]);
  const [skillsText, setSkillsText] = useState("");
  const [maxRoleCalls, setMaxRoleCalls] = useState(String(DEFAULT_MAX_ROLE_CALLS));
  // Library (roles / skill and prompt items) ticked for this run.
  const { lib, error: libError, reload: reloadLib } = useLibrary();
  const [tickedRoles, setTickedRoles] = useState<string[]>([]);
  const [tickedItems, setTickedItems] = useState<string[]>([]);
  const toggle = (set: (f: (l: string[]) => string[]) => void) => (id: string, on: boolean) =>
    set((l) => (on ? (l.includes(id) ? l : [...l, id]) : l.filter((x) => x !== id)));
  const updateRow = (i: number, patch: Partial<{ name: string; description: string; prompt: string; tools: string[] }>) =>
    setExtraRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // attachments staged before the run exists (5.5): POST /api/inbox → stage id → POST /api/runs {inbox_stage}
  const [stage, setStage] = useState<string | null>(null);
  const [inbox, setInbox] = useState<InboxFile[]>([]);
  const uploadStaged = async (f: File) => {
    const r = await api.stageInbox(f, stage);
    setStage(r.stage_id);
    setInbox(r.files);
    return r.files;
  };
  // "new project" form
  const [np, setNp] = useState({ name: "", repo_path: "", base_branch: "main" });
  const [npCheck, setNpCheck] = useState<RepoCheck | null>(null);
  const [npBusy, setNpBusy] = useState(false);

  const loadProjects = () => api.projects().then((r) => setProjects(r.projects)).catch(() => {});
  useEffect(() => { void loadProjects(); }, []);
  const [costStats, setCostStats] = useState<CostStats | null>(null);
  const [todayCost, setTodayCost] = useState(0);
  useEffect(() => {
    api.codingCostStats().then(setCostStats).catch(() => {});
    api.costsByDay().then((r) => setTodayCost(r.days.find((d) => d.day === localDayKey(new Date()))?.cost_usd_est ?? 0)).catch(() => {});
  }, []);

  const current = projects.find((p) => p.name === project) ?? null;
  const hasRepo = !!current?.repo_path;
  // No run-type choice: a project with a repo always runs coding (the server decides the same way).
  const effectiveKind: RunKind = pickEffectiveKind(hasRepo);
  const defaultRoleModels = useMemo(() => (effectiveKind === "coding" ? status?.role_models_coding ?? {} : status?.role_models ?? {}), [status, effectiveKind]);
  // What the run would contain: ticked library roles + hand-written rows + roles pulled in by ticked items (server cap: 5).
  const agentPlan = useMemo(
    () =>
      planRunAgents({
        libraryRoles: lib?.roles ?? [],
        tickedRoleIds: tickedRoles,
        rows: extraRows,
        tickedItems: (lib?.items ?? []).filter((i) => tickedItems.includes(i.id)),
        kindRoles: Object.keys(defaultRoleModels),
        builtinRoles: lib?.builtinRoles ?? [],
      }),
    [lib, tickedRoles, tickedItems, extraRows, defaultRoleModels],
  );
  const planWarning = agentPlan.error === "limit" ? `${t.lib_agent_limit} (${agentPlan.names.length}/${MAX_RUN_AGENTS})` : agentPlan.error === "clash" ? `${t.lib_agent_clash}: ${agentPlan.clash}` : null;

  useEffect(() => {
    if (status) {
      setMaxTurns(status.defaults.maxTurns);
      setBudget(status.defaults.maxBudgetUsd);
      setMaxRoleCalls(String(status.defaults.coding?.maxRoleCalls ?? DEFAULT_MAX_ROLE_CALLS));
      setModel((m) => m || status.defaults.model);
    }
  }, [status]);
  // Role models follow the role set of the selected kind.
  useEffect(() => { setRoleModels({ ...defaultRoleModels }); }, [defaultRoleModels]);

  const mrcCeiling = status?.limits.maxRoleCallsCeiling ?? DEFAULT_MAX_ROLE_CALLS_CEILING;
  const models = status?.models ?? [];
  const modelOptions = (cur: string) => {
    const list = models.some((m) => m.id === cur) || !cur ? models : [...models, { id: cur, label: cur }];
    return list.map((m) => (
      <option key={m.id} value={m.id}>{m.label}</option>
    ));
  };

  const pickProject = (v: string) => {
    setProject(v);
    setNpCheck(null);
    if (v !== NEW) remember(PREF_PROJECT, v);
  };

  const validateNew = async () => {
    setNpBusy(true);
    try {
      setNpCheck(await api.validateProject({ repo_path: np.repo_path.trim(), base_branch: np.base_branch.trim() || "main" }));
    } catch (e) {
      setNpCheck({ ok: false, head_sha: null, dirty: false, branches: [], error: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setNpBusy(false);
    }
  };
  const createNew = async () => {
    setNpBusy(true);
    setErr(null);
    try {
      const body: { name: string; repo_path?: string; base_branch?: string } = { name: np.name.trim() };
      if (np.repo_path.trim()) {
        body.repo_path = np.repo_path.trim();
        body.base_branch = np.base_branch.trim() || "main";
      }
      const { project: created } = await api.addProject(body);
      await loadProjects();
      pickProject(created.name);
      setNp({ name: "", repo_path: "", base_branch: "main" });
      setNpCheck(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setNpBusy(false);
    }
  };

  const submit = async () => {
    setErr(null);
    const unfilled = extractSlots(prompt);
    if (unfilled.length) {
      setErr(`${t.err_unfilled_slots}: ${unfilled.map((n) => `{{${n}}}`).join(", ")}`);
      return;
    }
    setBusy(true);
    try {
      const body: Parameters<typeof api.startRun>[0] = { prompt, max_turns: maxTurns, budget_usd: budget, roles: true };
      if (model) body.model = model;
      body.project = project && project !== NEW ? project : "default";
      remember(PREF_PROJECT, body.project === "default" ? "" : body.project);
      if (stage && inbox.length) body.inbox_stage = stage;
      if (effectiveKind === "coding") {
        const v = validateMaxRoleCalls(maxRoleCalls, mrcCeiling);
        if (!v.ok) throw new ApiError(`${t.max_role_calls_err} ${mrcCeiling}.`, 400, "bad_request");
        body.max_role_calls = v.value;
      }
      if (agentPlan.error) throw new ApiError(planWarning ?? agentPlan.error, 400, "bad_request");
      if (Object.keys(agentPlan.agents).length) body.agents = agentPlan.agents;
      // Only ids that still exist in the library (another tab may have deleted one).
      const itemIds = tickedItems.filter((id) => lib?.items.some((i) => i.id === id));
      if (itemIds.length) body.libraryItemIds = itemIds;
      const skills = skillsText.split(",").map((s) => s.trim()).filter(Boolean);
      if (skills.length) body.skills = skills;
      if (body.roles) {
        const overrides: Record<string, string> = {};
        for (const [role, m] of Object.entries(roleModels)) if (m && m !== defaultRoleModels[role]) overrides[role] = m;
        if (Object.keys(overrides).length) body.role_models = overrides;
      }
      const { run } = await api.startRun(body);
      navigate(`/runs/${encodeURIComponent(run.id)}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const roleNames = ROLE_ORDER.filter((r) => r in defaultRoleModels).concat(Object.keys(defaultRoleModels).filter((r) => !ROLE_ORDER.includes(r)));
  const showRoles = true;

  return (
    <div className="card">
      {needsGuide(status) && status && <ClaudeGuide status={status} onRecheck={onRecheck ?? (() => location.reload())} />}
      <div className="field">
        <label>{t.prompt_label}</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={effectiveKind === "coding" ? t.prompt_placeholder_coding : t.prompt_placeholder} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit(); }} />
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label>{t.attach}</label>
        <AttachBox files={inbox} onUpload={uploadStaged} disabled={busy} />
      </div>
      {effectiveKind === "coding" && costStats && <p className="muted" style={{ marginBottom: 0 }}>{formatEstimate(costStats)}</p>}
      {liveQuotaLabel(status?.rate_limit, []).pct && <p className="muted" style={{ margin: 0, fontSize: 12 }}>{t.quota_account} · {t.cmd_rate_limit}: {liveQuotaLabel(status?.rate_limit, []).pct}</p>}
      {dailyWarning(todayCost, status?.ui?.dailyCostWarnUsd) && (
        <p style={{ marginBottom: 0, padding: 8, background: "#fff3cd", color: "#664d03", border: "1px solid #ffecb5", borderRadius: 6 }}>
          {dailyWarning(todayCost, status?.ui?.dailyCostWarnUsd)} {t.cmd_daily_warn_note}
        </p>
      )}
      <div className="row cmd-row" style={{ marginTop: 12 }}>
        <div className="field">
          <label>{t.project}</label>
          <select value={project} onChange={(e) => pickProject(e.target.value)} aria-label={t.project}>
            <option value="">{t.project_default} ({t.kind_research})</option>
            {projects.filter((p) => p.name !== "default").map((p) => (
              <option key={p.name} value={p.name}>{p.repo_path ? `${p.name} — ${p.repo_path}` : p.name}</option>
            ))}
            <option value={NEW}>＋ {t.project_new}</option>
          </select>
        </div>
        <div className="field">
          <label>{t.model_main}</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>{modelOptions(model)}</select>
        </div>
        <div className="field">
          <label>{t.max_turns}</label>
          <input type="number" min={1} max={status?.limits.maxTurnsCeiling ?? 100} value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} style={{ width: 110 }} />
        </div>
        <div className="field">
          <label>{t.budget}</label>
          <input type="number" min={0.05} step={0.5} max={status?.limits.maxBudgetUsdCeiling ?? 10} value={budget} onChange={(e) => setBudget(Number(e.target.value))} style={{ width: 110 }} />
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="primary" disabled={busy || !prompt.trim() || project === NEW || !!agentPlan.error} onClick={() => void submit()}>
          {busy ? t.running : t.run}
        </button>
      </div>
      {current?.repo_path && (
        <p className="muted mono" style={{ marginTop: 8, marginBottom: 0, wordBreak: "break-all" }}>
          {t.env_repo}: {current.repo_path} · {t.env_base_branch}: {current.base_branch ?? "main"}{current.allowed_commands.length ? ` · ${t.allowed_commands}: ${current.allowed_commands.join(", ")}` : ""}
        </p>
      )}
      {project === NEW && (
        <div className="card" style={{ marginTop: 12, marginBottom: 0, background: "var(--bg)" }}>
          <b>{t.project_new}</b>
          <p className="muted" style={{ margin: "4px 0 8px" }}>{t.project_new_hint}</p>
          <div className="row">
            <div className="field">
              <label>{t.project_name}</label>
              <input value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} placeholder="my-app" style={{ width: 160 }} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <label>{t.env_repo}</label>
              <input value={np.repo_path} onChange={(e) => { setNp({ ...np, repo_path: e.target.value }); setNpCheck(null); }} placeholder="D:\path\to\repo" className="mono" />
            </div>
            <div className="field">
              <label>{t.env_base_branch}</label>
              <input value={np.base_branch} onChange={(e) => { setNp({ ...np, base_branch: e.target.value }); setNpCheck(null); }} style={{ width: 120 }} list="tnf-branches" />
              <datalist id="tnf-branches">{(npCheck?.branches ?? []).map((b) => <option key={b} value={b} />)}</datalist>
            </div>
            <button disabled={npBusy || !np.repo_path.trim()} onClick={() => void validateNew()}>{t.project_validate}</button>
            <button className="primary" disabled={npBusy || !np.name.trim() || (!!np.repo_path.trim() && !npCheck?.ok)} onClick={() => void createNew()}>{t.project_create}</button>
          </div>
          {npCheck && (
            npCheck.ok
              ? <p className="muted" style={{ marginBottom: 0 }}>✓ {t.project_valid} · HEAD {npCheck.head_sha?.slice(0, 7)}{npCheck.dirty ? ` · ${t.project_dirty}` : ""}</p>
              : <p className="error" style={{ marginBottom: 0 }}>{npCheck.error}</p>
          )}
        </div>
      )}
      {showRoles && roleNames.length > 0 && (
        <details style={{ marginTop: 12 }} {...(initialRolesOpen ? { open: true } : {})}>
          <summary className="muted" style={{ cursor: "pointer" }}>{t.advanced}: {t.model_roles} ({effectiveKind === "coding" ? t.kind_coding : t.kind_research})</summary>
          <div className="row" style={{ marginTop: 8 }}>
            {roleNames.map((role) => (
              <div className="field" key={role}>
                <label>{roleLabel(role, lang === "en" ? "en" : "vi")}</label>
                <select value={roleModels[role] ?? ""} onChange={(e) => setRoleModels((rm) => ({ ...rm, [role]: e.target.value }))}>{modelOptions(roleModels[role] ?? "")}</select>
              </div>
            ))}
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>{t.model_hint}</p>
        </details>
      )}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer" }}>
          <b>{t.lib_run_title}</b>
          {tickedRoles.length + tickedItems.length > 0 && <span className="muted"> · {tickedRoles.length} / {tickedItems.length}</span>}
        </summary>
        <RunLibraryPicker
          lib={lib}
          error={libError}
          tickedRoles={tickedRoles}
          tickedItems={tickedItems}
          kindRoles={Object.keys(defaultRoleModels)}
          warning={planWarning}
          onToggleRole={toggle(setTickedRoles)}
          onToggleItem={toggle(setTickedItems)}
          onFillPrompt={setPrompt}
          onCatalogAdded={(id) => {
            void reloadLib();
            setTickedRoles((l) => (l.includes(id) ? l : [...l, id]));
          }}
        />
      </details>
      <details style={{ marginTop: 12 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>{t.advanced}: {t.extras_title}</summary>
        <p className="muted" style={{ margin: "8px 0" }}>{t.extras_hint}</p>
        {extraRows.map((a, i) => (
          <div className="card" key={i} style={{ background: "var(--bg)", marginBottom: 8 }}>
            <div className="row">
              <div className="field">
                <label>{t.extras_agent_name}</label>
                <input value={a.name} onChange={(e) => updateRow(i, { name: e.target.value })} style={{ width: 170 }} className="mono" />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 200 }}>
                <label>{t.extras_agent_desc}</label>
                <input value={a.description} onChange={(e) => updateRow(i, { description: e.target.value })} maxLength={300} />
              </div>
              <button onClick={() => setExtraRows((rows) => rows.filter((_, j) => j !== i))}>{t.extras_remove}</button>
            </div>
            <div className="field" style={{ marginTop: 8 }}>
              <label>{t.extras_agent_prompt}</label>
              <textarea value={a.prompt} onChange={(e) => updateRow(i, { prompt: e.target.value })} maxLength={4000} />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <label className="muted">{t.extras_agent_tools}:</label>
              {SAFE_AGENT_TOOLS.map((tool) => (
                <label key={tool} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <input type="checkbox" checked={a.tools.includes(tool)} onChange={(e) => updateRow(i, { tools: e.target.checked ? [...a.tools, tool] : a.tools.filter((x) => x !== tool) })} />
                  {tool}
                </label>
              ))}
            </div>
          </div>
        ))}
        {extraRows.length < 5 && (
          <button onClick={() => setExtraRows((rows) => [...rows, { name: "", description: "", prompt: "", tools: ["Read", "Grep", "Glob"] }])}>{t.extras_add_agent}</button>
        )}
        {effectiveKind === "coding" && (
          <div className="field" style={{ marginTop: 8 }}>
            <label>{t.max_role_calls}</label>
            <input type="number" min={1} max={mrcCeiling} step={1} value={maxRoleCalls} onChange={(e) => setMaxRoleCalls(e.target.value)} style={{ width: 100 }} />
            <span className="muted"> {t.max_role_calls_hint} {mrcCeiling}.</span>
          </div>
        )}
        <div className="field" style={{ marginTop: 8 }}>
          <label>{t.extras_skills}</label>
          <input value={skillsText} onChange={(e) => setSkillsText(e.target.value)} className="mono" placeholder="pdf, docx" />
        </div>
      </details>
      {err && <p className="error" style={{ marginTop: 12 }}>{t.err_prefix}: {err}</p>}
      <p className="muted" style={{ marginTop: 12 }}>{t.cost_note} Ctrl+Enter = {t.run}.</p>
    </div>
  );
}
