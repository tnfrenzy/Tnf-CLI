import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import { buildVersionPatch, versionText } from "../../skills/versionDiff";
import type { LibraryEntryKind, LibraryItem, LibraryRestoreResponse, LibraryRole, LibraryVersion } from "../../types";
import { DiffView } from "../run/DiffView";

export interface LibraryHistoryViewProps {
  versions: LibraryVersion[] | null;
  selectedId: string | null;
  patch: string;
  dangerKeywords: string[];
  confirming: boolean;
  busy: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onRestore: (id: string) => void;
  onConfirm: (id: string) => void;
  onClose: () => void;
}

/** Server already returns newest first; keep that order (no reversing). */
export function orderVersions(list: LibraryVersion[]): LibraryVersion[] {
  return [...list];
}

/** Pure render of the history panel (no fetching), so it can be tested statically. */
export function LibraryHistoryView(p: LibraryHistoryViewProps) {
  const { t } = useT();
  const when = (at: number) => new Date(at).toLocaleString();
  const list = p.versions;
  return (
    <div className="card">
      <div className="row">
        <strong>{t.lib_hist_title}</strong>
        <button onClick={p.onClose}>{t.lib_hist_close}</button>
      </div>
      {p.error && <div className="err">{p.error}</div>}
      {list === null && <div>{t.lib_hist_loading}</div>}
      {list !== null && list.length === 0 && <div>{t.lib_hist_empty}</div>}
      {list !== null && list.length > 0 && (
        <ul>
          {list.map((v, i) => (
            <li key={v.id}>
              <span>{t.lib_hist_version_label} {list.length - i} · {when(v.at)}{v.note ? ` · ${v.note}` : ""}</span>{" "}
              <button onClick={() => p.onSelect(v.id)}>{t.lib_hist_compare}</button>{" "}
              <button disabled={p.busy} onClick={() => p.onRestore(v.id)}>{t.lib_hist_restore}</button>
            </li>
          ))}
        </ul>
      )}
      {p.selectedId && p.dangerKeywords.length > 0 && (
        <div className="warn">
          <div>{t.lib_hist_danger}</div>
          <div>{p.dangerKeywords.map((x) => <span className="chip" key={x}>{x}</span>)}</div>
          {p.confirming && <button disabled={p.busy} onClick={() => p.onConfirm(p.selectedId as string)}>{t.lib_hist_restore_confirm}</button>}
        </div>
      )}
      {p.selectedId && (p.patch ? <DiffView patch={p.patch} /> : <div>{t.lib_hist_no_diff}</div>)}
    </div>
  );
}

export interface LibraryHistoryProps {
  kind: LibraryEntryKind;
  id: string;
  current: { role?: Partial<LibraryRole>; item?: Partial<LibraryItem> };
  onClose: () => void;
  onRestored: (res: LibraryRestoreResponse) => void;
}

export function LibraryHistory({ kind, id, current, onClose, onRestored }: LibraryHistoryProps) {
  const [versions, setVersions] = useState<LibraryVersion[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [danger, setDanger] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.libraryHistory(kind, id);
      setVersions(orderVersions(r.versions));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVersions([]);
    }
  }, [kind, id]);

  useEffect(() => { void load(); }, [load]);

  const selected = versions?.find((v) => v.id === selectedId) ?? null;
  const patch = selected ? buildVersionPatch(id, versionText(selected), versionText(current)) : "";

  const select = (vid: string) => { setSelectedId(vid); setDanger([]); setConfirming(false); setError(null); };

  const doRestore = async (vid: string, confirm: boolean) => {
    const res = await api.restoreLibraryVersion(kind, id, confirm ? { versionId: vid, confirm: true } : { versionId: vid });
    setDanger([]);
    setConfirming(false);
    onRestored(res);
    await load();
  };

  const restore = async (vid: string) => {
    setSelectedId(vid);
    setBusy(true);
    setError(null);
    try {
      const dry = await api.restoreLibraryVersion(kind, id, { versionId: vid, dryRun: true });
      const kw = dry.preview.dangerKeywords ?? [];
      if (kw.length > 0) { setDanger(kw); setConfirming(true); return; }
      await doRestore(vid, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (vid: string) => {
    setBusy(true);
    setError(null);
    try { await doRestore(vid, true); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <LibraryHistoryView
      versions={versions} selectedId={selectedId} patch={patch} dangerKeywords={danger}
      confirming={confirming} busy={busy} error={error}
      onSelect={select} onRestore={(v) => void restore(v)} onConfirm={(v) => void confirm(v)} onClose={onClose}
    />
  );
}
