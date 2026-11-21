import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { roleLabel, useT } from "../../i18n";
import type {
  CliAccountPublic,
  CliAccountRuntimeStatus,
  CliAccountsSettings,
  CliProviderId,
  RoleAccountMap,
} from "../../types";

const CONFIGURABLE_ROLES = [
  "analyst",
  "planner",
  "critic",
  "implementer",
  "qa",
  "debug",
  "idea-interviewer",
  "idea-splitter",
  "idea-critic",
  "cad-modeler",
  "visual-reviewer",
  "video-director",
] as const;

export function CliAccountsSection() {
  const { t, lang } = useT();
  const [accounts, setAccounts] = useState<CliAccountPublic[]>([]);
  const [settings, setSettings] = useState<Required<CliAccountsSettings>>({ autoFailover: false, crossProviderFailover: false });
  const [roleAccounts, setRoleAccounts] = useState<RoleAccountMap>({});
  const [statuses, setStatuses] = useState<Record<string, CliAccountRuntimeStatus>>({});
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<CliProviderId>("claude");
  const [isolated, setIsolated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.cliAccounts();
      setAccounts(r.accounts);
      setSettings(r.settings);
      setRoleAccounts(r.role_accounts ?? {});
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const addAccount = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      await api.addCliAccount({
        label: label.trim(),
        provider,
        isolated: provider === "claude" || provider === "codex" ? isolated : false,
      });
      setLabel("");
      await load();
      setNotice(t.cli_acc_saved);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkAccount = async (id: string) => {
    setCheckingId(id);
    setErr(null);
    try {
      const r = await api.checkCliAccount(id);
      setStatuses((prev) => ({ ...prev, [id]: r.status }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCheckingId(null);
    }
  };

  const loginAccount = async (id: string) => {
    setErr(null);
    setNotice(null);
    try {
      await api.loginCliAccount(id);
      setNotice(t.cli_acc_login_opened);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  const setDefault = async (id: string) => {
    setErr(null);
    try {
      await api.updateCliAccount(id, { isDefault: true, enabled: true });
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  const toggleEnabled = async (acc: CliAccountPublic) => {
    setErr(null);
    try {
      await api.updateCliAccount(acc.id, { enabled: !acc.enabled });
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  const removeAccount = async (id: string) => {
    setErr(null);
    try {
      await api.deleteCliAccount(id);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  const updateSettings = async (patch: CliAccountsSettings) => {
    setErr(null);
    try {
      const r = await api.saveCliAccountsSettings(patch);
      setSettings(r.settings);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  const saveRoles = async () => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await api.saveRoleAccounts(roleAccounts);
      setRoleAccounts(r.role_accounts);
      setNotice(t.cli_acc_saved);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <b>{t.cli_acc_title}</b>
        <div className="muted">{t.cli_acc_policy}</div>
      </div>

      {err ? <div className="error">{err}</div> : null}
      {notice ? <div className="pill ok">{notice}</div> : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {accounts.map((acc) => {
          const st = statuses[acc.id];
          return (
            <div key={acc.id} className="card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <b>{acc.label}</b>
                <span className="pill">
                  {acc.provider === "antigravity"
                    ? "Antigravity CLI"
                    : acc.provider === "codex"
                      ? "OpenAI Codex CLI"
                      : "Claude Code"}
                </span>
                {acc.isDefault ? <span className="pill ok">{t.cli_acc_default}</span> : null}
                <span className={`pill ${acc.enabled ? "ok" : "err"}`}>{acc.enabled ? t.cli_acc_enabled : t.cli_acc_disabled}</span>
                {st ? (
                  <span className={`pill ${st.loggedIn ? "ok" : "err"}`}>
                    {st.loggedIn ? t.cli_acc_logged_in : t.cli_acc_not_logged_in}
                    {st.email ? ` · ${st.email}` : ""}
                    {st.version ? ` · v${st.version}` : ""}
                  </span>
                ) : null}
              </div>
              {acc.configDir ? <div className="muted mono" style={{ fontSize: 12 }}>{acc.configDir}</div> : null}
              {st?.error ? <div className="error" style={{ fontSize: 12 }}>{st.error}</div> : null}
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                <button type="button" disabled={checkingId === acc.id} onClick={() => void checkAccount(acc.id)}>
                  {t.cli_acc_check}
                </button>
                <button type="button" onClick={() => void loginAccount(acc.id)}>
                  {t.cli_acc_login}
                </button>
                {!acc.isDefault ? (
                  <button type="button" onClick={() => void setDefault(acc.id)}>
                    {t.cli_acc_set_default}
                  </button>
                ) : null}
                <button type="button" onClick={() => void toggleEnabled(acc)}>
                  {acc.enabled ? t.cli_acc_disabled : t.cli_acc_enabled}
                </button>
                {accounts.length > 1 ? (
                  <button type="button" onClick={() => void removeAccount(acc.id)}>
                    {t.cli_acc_delete}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <b>{t.cli_acc_add_title}</b>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <select aria-label={t.cli_acc_provider} value={provider} onChange={(e) => setProvider(e.target.value as CliProviderId)}>
            <option value="claude">Claude Code CLI</option>
            <option value="antigravity">Antigravity CLI (agy)</option>
            <option value="codex">OpenAI Codex CLI (ChatGPT)</option>
          </select>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t.cli_acc_label}
            style={{ flex: "1 1 180px" }}
          />
          <button type="button" className="primary" disabled={busy || !label.trim()} onClick={() => void addAccount()}>
            {t.cli_acc_add_btn}
          </button>
        </div>
        {provider === "claude" || provider === "codex" ? (
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={isolated} onChange={(e) => setIsolated(e.target.checked)} />
            <span>{t.cli_acc_isolated}</span>
          </label>
        ) : null}
      </div>

      <div className="card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={settings.autoFailover}
            onChange={(e) => void updateSettings({ autoFailover: e.target.checked })}
          />
          <span>{t.cli_acc_failover}</span>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={settings.crossProviderFailover}
            disabled={!settings.autoFailover}
            onChange={(e) => void updateSettings({ crossProviderFailover: e.target.checked })}
          />
          <span>{t.cli_acc_cross_failover}</span>
        </label>
      </div>

      <div className="card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <b>{t.cli_acc_roles_title}</b>
        <div className="muted">{t.cli_acc_roles_hint}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
          {CONFIGURABLE_ROLES.map((r) => (
            <label key={r} className="field" style={{ gap: 4 }}>
              <span>{roleLabel(r, lang)}</span>
              <select
                value={roleAccounts[r]?.accountId ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setRoleAccounts((prev) => {
                    const next = { ...prev };
                    if (!val) delete next[r];
                    else next[r] = { ...prev[r], accountId: val };
                    return next;
                  });
                }}
              >
                <option value="">{t.cli_acc_pick_default}</option>
                {accounts.filter((a) => a.enabled).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} ({a.provider})
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <div>
          <button type="button" className="primary" disabled={busy} onClick={() => void saveRoles()}>
            {t.cli_acc_roles_save}
          </button>
        </div>
      </div>
    </div>
  );
}
