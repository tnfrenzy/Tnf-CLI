import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import { clampTimeoutSec, clientCheckPattern, commandSuggestions, patternsToText, textToPatterns } from "../../settings/worktreeSetupView";

/** Settings > Worktree setup: gitignored files to copy plus an optional setup command, per environment. */
export function WorktreeSetupSection() {
  const { t } = useT();
  const [envs, setEnvs] = useState<string[]>([]);
  const [env, setEnv] = useState("");
  const [text, setText] = useState("");
  const [command, setCommand] = useState<string | null>(null);
  const [timeout, setTimeoutSec] = useState(180);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [envsLoaded, setEnvsLoaded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.projects().then((r) => {
      const names = r.projects.map((p) => p.name);
      setEnvs(names);
      setEnv((cur) => cur || names[0] || "");
      setEnvsLoaded(true);
    }).catch(() => setEnvsLoaded(true));
  }, []);
  useEffect(() => {
    if (!env) return;
    let cancelled = false;
    setLoaded(false);
    setErr(null);
    setMsg(null);
    api.worktreeSetupGet(env)
      .then((r) => {
        if (cancelled) return;
        setText(patternsToText(r.setup.files));
        setCommand(r.setup.command);
        setTimeoutSec(r.setup.timeoutSec);
        setAllowed(r.allowedCommands);
        setLoaded(true);
      })
      .catch((e: Error) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [env]);

  const patterns = textToPatterns(text);
  const patternErr = patterns.map((p) => clientCheckPattern(p)).find((m) => m !== null) ?? null;
  const options = commandSuggestions(allowed, "");
  const shown = command && !options.includes(command) ? [command, ...options] : options;

  const save = () => {
    if (!env || saving || patternErr) return;
    setSaving(true);
    setErr(null);
    api.worktreeSetupPut(env, { files: patterns, command, timeoutSec: clampTimeoutSec(timeout) })
      .then((r) => {
        setText(patternsToText(r.setup.files));
        setCommand(r.setup.command);
        setTimeoutSec(r.setup.timeoutSec);
        setMsg(t.wts_saved);
        setTimeout(() => setMsg(null), 2000);
      })
      .catch((e: Error) => setErr(`${t.wts_error}: ${e.message}`))
      .finally(() => setSaving(false));
  };

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }} data-testid="worktree-setup-section">
      <h4>{t.wts_title}</h4>
      <div className="muted fine">{t.wts_desc}</div>
      <label className="row" style={{ flexWrap: "wrap" }}>
        <span>{t.wts_env}</span>
        <select value={env} onChange={(e) => setEnv(e.target.value)} aria-label={t.wts_env} disabled={saving} style={{ maxWidth: "100%" }}>
          {envs.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      {err ? <div className="error" role="alert">{err}</div> : null}
      {!loaded ? (err || (envsLoaded && !env) ? null : <div className="muted fine">{t.wts_loading}</div>) : (
        <>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <b>{t.wts_files_label}</b>
            <textarea className="mono" rows={5} value={text} disabled={saving} onChange={(e) => setText(e.target.value)} aria-label={t.wts_files_label} placeholder=".env" />
          </label>
          <div className="muted fine">{t.wts_files_hint}</div>
          {patternErr ? <div className="error fine" role="alert">{patternErr}</div> : null}
          <div className="error fine">{t.wts_secret_warning}</div>
          <label className="row" style={{ flexWrap: "wrap" }}>
            <b>{t.wts_command_label}</b>
            <select value={command ?? ""} disabled={saving} aria-label={t.wts_command_label} onChange={(e) => setCommand(e.target.value || null)} style={{ maxWidth: "100%" }}>
              <option value="">{t.wts_command_none}</option>
              {shown.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div className="muted fine">{allowed.length === 0 ? t.wts_no_allowed : t.wts_command_hint}</div>
          <label className="row" style={{ flexWrap: "wrap" }}>
            <b>{t.wts_timeout_label}</b>
            <input type="number" min={10} max={900} value={timeout} disabled={saving} aria-label={t.wts_timeout_label} onChange={(e) => setTimeoutSec(Number(e.target.value))} onBlur={() => setTimeoutSec(clampTimeoutSec(timeout))} />
          </label>
          <div className="muted fine">{t.wts_timeout_hint}</div>
          <div className="row">
            <button type="button" disabled={saving || !!patternErr} onClick={save}>{t.wts_save}</button>
            {msg ? <span className="muted fine" role="status">{msg}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
