import { Fragment, useState } from "react";
import { api, ApiError } from "../api";
import { CatalogSearch } from "../components/skills/CatalogSearch";
import { AgentMdImport } from "../components/skills/AgentMdImport";
import { LibraryHistory } from "../components/skills/LibraryHistory";
import { RoleEvalPanel } from "../components/skills/RoleEvalPanel";
import { showEvalButton } from "../skills/roleEval";
import { RoleStatsTable } from "../components/skills/RoleStatsTable";
import { roleLabel, useT } from "../i18n";
import { formatBytes, roleChoices, utf8Bytes } from "../skills/library";
import { SAFE_AGENT_TOOLS, type LibraryItem, type LibraryRole, type StatusResponse } from "../types";
import { useLibrary } from "../skills/useLibrary";

const MAX_ITEM_BYTES = 64 * 1024;

type RoleDraft = { id: string; description: string; prompt: string; tools: string[]; model: string; isNew: boolean };
type ItemDraft = { id?: string; name: string; type: "skill" | "prompt"; content: string; roleIds: string[] };

const emptyRole = (): RoleDraft => ({ id: "", description: "", prompt: "", tools: ["Read", "Grep", "Glob"], model: "", isNew: true });
const emptyItem = (): ItemDraft => ({ name: "", type: "prompt", content: "", roleIds: [] });

export function LibraryPage({ status }: { status: StatusResponse | null }) {
  const { t, lang } = useT();
  const { lib, error, reload } = useLibrary();
  const [role, setRole] = useState<RoleDraft | null>(null);
  const [item, setItem] = useState<ItemDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [saveNote, setSaveNote] = useState("");
  const [histOpen, setHistOpen] = useState<{ kind: "role" | "item"; id: string } | null>(null);
  const [evalRoleId, setEvalRoleId] = useState<string | null>(null);
  const [roleStatsOpen, setRoleStatsOpen] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveRole = () =>
    run(async () => {
      if (!role) return;
      const body: LibraryRole = { id: role.id.trim(), description: role.description, prompt: role.prompt, tools: role.tools };
      if (role.model) body.model = role.model;
      const n = saveNote.trim();
      await api.saveLibraryRole(body, role.isNew, !role.isNew && n ? n : undefined);
      setSaveNote("");
      setRole(null);
      setNote(t.lib_saved);
    });
  const saveItem = () =>
    run(async () => {
      if (!item) return;
      const n = saveNote.trim();
      await api.saveLibraryItem({ ...(item.id ? { id: item.id } : {}), name: item.name, type: item.type, content: item.content, roleIds: item.roleIds }, item.id && n ? n : undefined);
      setSaveNote("");
      setItem(null);
      setNote(t.lib_saved);
    });

  const models = status?.models ?? [];
  const choices = lib ? roleChoices(lib.builtinRoles, lib.roles) : [];

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t.lib_page_title}</h2>
      <p className="muted">{t.lib_page_hint}</p>
      {error && <p className="error">{t.lib_load_error}: {error}</p>}
      {err && <p className="error">{t.err_prefix}: {err}</p>}
      {note && <p className="muted">{note}</p>}
      {!lib && !error && <p className="muted">{t.lib_loading}</p>}

      <div className="row" style={{ marginBottom: 8 }}>
        {!importOpen && <button onClick={() => setImportOpen(true)}>{t.lib_import_button}</button>}
      </div>
      {importOpen && (
        <div className="card lib-editor">
          <AgentMdImport
            onImported={() => {
              setImportOpen(false);
              void reload().then(() => setNote(t.lib_import_done));
            }}
            onCancel={() => setImportOpen(false)}
          />
        </div>
      )}

      {lib && (
        <>
          <section className="lib-section">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>{t.lib_roles} ({lib.roles.length})</h3>
              {!role && <button onClick={() => setRole(emptyRole())}>{t.lib_role_new}</button>}
            </div>
            {lib.roles.length === 0 && !role && <p className="muted">{t.lib_empty_roles}</p>}
            {lib.roles.map((r) => (
              <Fragment key={r.id}>
              <div className="lib-row">
                <div>
                  <b className="mono">{r.id}</b> <span className="muted">{r.description}</span>
                  <div className="chips">
                    {(r.tools ?? []).map((tool) => <span className="chip tool" key={tool}>{tool}</span>)}
                    {r.model && <span className="chip">{r.model}</span>}
                  </div>
                </div>
                <div className="lib-actions">
                  <button disabled={busy} onClick={() => setRole({ id: r.id, description: r.description, prompt: r.prompt, tools: r.tools ?? [], model: r.model ?? "", isNew: false })}>{t.lib_edit}</button>
                  {showEvalButton({ kind: "role" }) && <button onClick={() => setEvalRoleId(evalRoleId === r.id ? null : r.id)}>{t.lib_eval_button}</button>}
                  <button className="danger" disabled={busy} onClick={() => { if (confirm(t.lib_delete_role_confirm)) { if (r.id === evalRoleId) setEvalRoleId(null); void run(() => api.deleteLibraryRole(r.id).then(() => undefined)); } }}>{t.lib_delete}</button>
                </div>
              </div>
              {evalRoleId === r.id && <RoleEvalPanel roleId={r.id} />}
              </Fragment>
            ))}
            {role && (
              <div className="card lib-editor">
                <b>{role.isNew ? t.lib_role_new : `${t.lib_role_edit}: ${roleLabel(role.id, lang === "en" ? "en" : "vi")}`}</b>
                <div className="row" style={{ marginTop: 8 }}>
                  <div className="field">
                    <label>{t.lib_role_id}</label>
                    <input className="mono" value={role.id} disabled={!role.isNew} onChange={(e) => setRole({ ...role, id: e.target.value })} style={{ width: 200 }} />
                  </div>
                  <div className="field" style={{ flex: 1, minWidth: 200 }}>
                    <label>{t.lib_role_desc}</label>
                    <input value={role.description} maxLength={300} onChange={(e) => setRole({ ...role, description: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>{t.lib_role_model}</label>
                    <select value={role.model} onChange={(e) => setRole({ ...role, model: e.target.value })}>
                      <option value="">{t.lib_model_default}</option>
                      {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="field" style={{ marginTop: 8 }}>
                  <label>{t.lib_role_prompt} ({role.prompt.length}/4000)</label>
                  <textarea value={role.prompt} maxLength={4000} onChange={(e) => setRole({ ...role, prompt: e.target.value })} />
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="muted">{t.lib_role_tools}:</label>
                  {SAFE_AGENT_TOOLS.map((tool) => (
                    <label key={tool} className="inline-check">
                      <input type="checkbox" checked={role.tools.includes(tool)} onChange={(e) => setRole({ ...role, tools: e.target.checked ? [...role.tools, tool] : role.tools.filter((x) => x !== tool) })} />
                      {tool}
                    </label>
                  ))}
                </div>
                {!role.isNew && (
                  <div className="field" style={{ marginTop: 8 }}>
                    <label>{t.lib_hist_note_label}</label>
                    <input value={saveNote} maxLength={200} placeholder={t.lib_hist_note_placeholder} onChange={(e) => setSaveNote(e.target.value)} />
                  </div>
                )}
                <div className="row" style={{ marginTop: 10 }}>
                  {!role.isNew && <button disabled={busy} onClick={() => setHistOpen(histOpen?.kind === "role" && histOpen.id === role.id ? null : { kind: "role", id: role.id })}>{t.lib_hist_button}</button>}
                  <button className="primary" disabled={busy || !role.id.trim() || !role.description.trim() || !role.prompt.trim()} onClick={() => void saveRole()}>{t.lib_save}</button>
                  <button disabled={busy} onClick={() => { setRole(null); setSaveNote(""); setHistOpen(null); }}>{t.lib_cancel}</button>
                </div>
                {!role.isNew && histOpen?.kind === "role" && histOpen.id === role.id && (
                  <LibraryHistory
                    kind="role"
                    id={role.id}
                    current={{ role: ((s) => ({ id: role.id, description: s ? s.description : role.description, prompt: s ? s.prompt : role.prompt, ...((s ? s.tools : role.tools) ? { tools: (s ? s.tools : role.tools) as string[] } : {}), ...((s ? s.model : role.model) ? { model: (s ? s.model : role.model) as string } : {}) }))(lib.roles.find((r) => r.id === role.id)) }}
                    onClose={() => setHistOpen(null)}
                    onRestored={() => { setHistOpen(null); setRole(null); void reload().then(() => setNote(t.lib_hist_restored)); }}
                  />
                )}
              </div>
            )}
          </section>

          <section className="lib-section">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>{t.lib_items} ({lib.items.length})</h3>
              {!item && <button onClick={() => setItem(emptyItem())}>{t.lib_item_new}</button>}
            </div>
            {lib.items.length === 0 && !item && <p className="muted">{t.lib_empty_items}</p>}
            {lib.items.map((it: LibraryItem) => (
              <div className="lib-row" key={it.id}>
                <div>
                  <b>{it.name}</b> <span className="chip">{it.type === "skill" ? t.lib_item_skill : t.lib_item_prompt}</span>
                  <span className="muted"> · {formatBytes(utf8Bytes(it.content))} · {t.lib_applies_to}: {it.roleIds.length ? it.roleIds.map((r) => roleLabel(r, lang === "en" ? "en" : "vi")).join(", ") : t.lib_coordinator_only}</span>
                </div>
                <div className="lib-actions">
                  <button disabled={busy} onClick={() => setItem({ id: it.id, name: it.name, type: it.type, content: it.content, roleIds: it.roleIds })}>{t.lib_edit}</button>
                  <button className="danger" disabled={busy} onClick={() => { if (confirm(t.lib_delete_item_confirm)) void run(() => api.deleteLibraryItem(it.id).then(() => undefined)); }}>{t.lib_delete}</button>
                </div>
              </div>
            ))}
            {item && (
              <div className="card lib-editor">
                <b>{item.id ? `${t.lib_item_edit}: ${item.name}` : t.lib_item_new}</b>
                <div className="row" style={{ marginTop: 8 }}>
                  <div className="field" style={{ flex: 1, minWidth: 200 }}>
                    <label>{t.lib_item_name}</label>
                    <input value={item.name} maxLength={80} onChange={(e) => setItem({ ...item, name: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>{t.lib_item_type}</label>
                    <select value={item.type} onChange={(e) => setItem({ ...item, type: e.target.value as "skill" | "prompt" })}>
                      <option value="prompt">{t.lib_item_prompt}</option>
                      <option value="skill">{t.lib_item_skill}</option>
                    </select>
                  </div>
                </div>
                <div className="field" style={{ marginTop: 8 }}>
                  <label>{t.lib_item_content} ({formatBytes(utf8Bytes(item.content))} / {formatBytes(MAX_ITEM_BYTES)})</label>
                  <textarea value={item.content} style={{ minHeight: 140 }} onChange={(e) => setItem({ ...item, content: e.target.value })} />
                </div>
                <div style={{ marginTop: 8 }}>
                  <span className="muted">{t.lib_item_roles}:</span>
                  <div className="row" style={{ marginTop: 4 }}>
                    {choices.map((c) => (
                      <label key={c.id} className="inline-check">
                        <input type="checkbox" checked={item.roleIds.includes(c.id)} onChange={(e) => setItem({ ...item, roleIds: e.target.checked ? [...item.roleIds, c.id] : item.roleIds.filter((x) => x !== c.id) })} />
                        <span className="mono" title={c.id}>{roleLabel(c.id, lang === "en" ? "en" : "vi")}</span>{c.builtin && <span className="muted"> ({t.lib_item_builtin})</span>}
                      </label>
                    ))}
                  </div>
                </div>
                {item.id && (
                  <div className="field" style={{ marginTop: 8 }}>
                    <label>{t.lib_hist_note_label}</label>
                    <input value={saveNote} maxLength={200} placeholder={t.lib_hist_note_placeholder} onChange={(e) => setSaveNote(e.target.value)} />
                  </div>
                )}
                <div className="row" style={{ marginTop: 10 }}>
                  {item.id && <button disabled={busy} onClick={() => setHistOpen(histOpen?.kind === "item" && histOpen.id === item.id ? null : { kind: "item", id: item.id as string })}>{t.lib_hist_button}</button>}
                  <button className="primary" disabled={busy || !item.name.trim() || !item.content.trim() || utf8Bytes(item.content) > MAX_ITEM_BYTES} onClick={() => void saveItem()}>{t.lib_save}</button>
                  <button disabled={busy} onClick={() => { setItem(null); setSaveNote(""); setHistOpen(null); }}>{t.lib_cancel}</button>
                </div>
                {item.id && histOpen?.kind === "item" && histOpen.id === item.id && (
                  <LibraryHistory
                    kind="item"
                    id={item.id}
                    current={{ item: ((s) => ({ id: item.id, name: s ? s.name : item.name, type: s ? s.type : item.type, content: s ? s.content : item.content, roleIds: s ? s.roleIds : item.roleIds }))(lib.items.find((i) => i.id === item.id)) }}
                    onClose={() => setHistOpen(null)}
                    onRestored={() => { setHistOpen(null); setItem(null); void reload().then(() => setNote(t.lib_hist_restored)); }}
                  />
                )}
              </div>
            )}
          </section>
        </>
      )}

      <section className="lib-section">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>{t.rs_title}</h3>
          <button onClick={() => setRoleStatsOpen((o) => !o)}>{roleStatsOpen ? t.rs_toggle_hide : t.rs_toggle_show}</button>
        </div>
        {roleStatsOpen && <RoleStatsTable />}
      </section>

      <section className="lib-section">
        <h3 style={{ margin: "0 0 6px" }}>{t.catalog_title}</h3>
        <CatalogSearch onAdded={() => void reload()} />
      </section>
    </div>
  );
}
