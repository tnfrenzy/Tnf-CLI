import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import type { Workshop3DSession, Workshop3DTurntableOptions } from "../../types";
import {
  DEFAULT_TURNTABLE_FORM, TURNTABLE_MAX_SEC, TURNTABLE_MIN_SEC, TURNTABLE_SIZES, clampDuration, turntableBody, turntableBlockReason, turntableCanStart,
  turntableFile, turntableRunning, turntableStatus, type TurntableForm, type TurntableSize,
} from "./turntable-logic";

/** Injectable calls (tests); default is the real API with the token header. */
export interface TurntableActions {
  start: (slug: string, opts: Workshop3DTurntableOptions) => Promise<unknown>;
  cancel: (slug: string) => Promise<unknown>;
  file: (slug: string, rel: string) => Promise<Blob>;
  download: (slug: string, rel: string) => Promise<void>;
}
const realActions: TurntableActions = {
  start: (slug, opts) => api.workshop3dTurntable(slug, opts),
  cancel: (slug) => api.workshop3dTurntableCancel(slug),
  file: (slug, rel) => api.workshop3dFile(slug, rel),
  download: (slug, rel) => api.workshop3dDownload(slug, rel),
};

/** Object URL of the finished video (token header, never a token in the URL); revoked on change / unmount. */
function useVideoUrl(actions: TurntableActions, slug: string, rel: string | null, rev: string): { url: string | null; loading: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!rel) { setUrl(null); setLoading(false); return; }
    let dead = false;
    let made: string | null = null;
    setLoading(true);
    actions.file(slug, rel).then((b) => {
      const u = URL.createObjectURL(b);
      if (dead) { URL.revokeObjectURL(u); return; }
      made = u;
      setUrl(u);
    }).catch(() => undefined).finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [actions, slug, rel, rev]);
  return { url, loading };
}

/** "Video quay tròn" block of the 3D workshop room: options, render / cancel, progress bar, player and download. */
export function TurntablePanel(props: { slug: string; session: Workshop3DSession; onChanged: () => void; actions?: TurntableActions }) {
  const { t } = useT();
  const d = t as unknown as Record<string, string>;
  const actions = props.actions ?? realActions;
  const tt = props.session.turntable ?? null;
  const running = turntableRunning(tt);
  const [form, setForm] = useState<TurntableForm>(DEFAULT_TURNTABLE_FORM);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = turntableFile(props.session.files);
  const status = turntableStatus(tt);
  const { onChanged } = props;

  // The session poll stops once a session is done, so poll here while a render runs.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => { if (!document.hidden) onChanged(); }, 2000);
    return () => clearInterval(id);
  }, [running, onChanged]);

  const video = useVideoUrl(actions, props.slug, running ? null : file, tt?.phase === "done" ? (tt.file ?? "") : "");
  const canStart = turntableCanStart(props.session.files, running, busy, props.session.turntableReady);
  const blocked = turntableBlockReason(props.session.turntableReady, props.session.turntableWhy, d["w3t_blocked"]!);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await actions.start(props.slug, turntableBody(form));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const cancel = async () => {
    setBusy(true);
    setErr(null);
    try {
      await actions.cancel(props.slug);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const label = status.kind === "render" ? d["w3t_phase_render"]!.replace("{done}", String(status.done)).replace("{total}", String(status.total))
    : status.kind === "encode" ? d["w3t_phase_encode"] : status.kind === "preparing" ? d["w3t_preparing"] : "";
  const percent = status.kind === "render" || status.kind === "encode" ? status.percent : 0;

  return (
    <section className="w3x-card" data-w3x="turntable" aria-labelledby="w3t-title">
      <h4 id="w3t-title">{d["w3t_title"]}</h4>
      <div className="fine">{d["w3t_hint"]}</div>
      <div className="row" style={{ gap: 12, flexWrap: "wrap", margin: "8px 0", alignItems: "flex-end" }}>
        <label>
          <span className="fine">{d["w3t_bg"]}</span><br />
          <select data-w3t="background" value={form.transparent ? "transparent" : "brand"} disabled={running}
            onChange={(e) => setForm({ ...form, transparent: e.target.value === "transparent" })}>
            <option value="brand">{d["w3t_bg_brand"]}</option>
            <option value="transparent">{d["w3t_bg_transparent"]}</option>
          </select>
        </label>
        <label>
          <span className="fine">{d["w3t_size"]}</span><br />
          <select data-w3t="size" value={form.size} disabled={running}
            onChange={(e) => setForm({ ...form, size: Number(e.target.value) as TurntableSize })}>
            {TURNTABLE_SIZES.map((n) => <option key={n} value={n}>{d[`w3t_size_${n}`]}</option>)}
          </select>
        </label>
        <label>
          <span className="fine">{d["w3t_duration"]}</span><br />
          <input data-w3t="duration" type="number" min={TURNTABLE_MIN_SEC} max={TURNTABLE_MAX_SEC} step={1} value={form.durationSec} disabled={running}
            onChange={(e) => setForm({ ...form, durationSec: e.target.value === "" ? TURNTABLE_MIN_SEC : Number(e.target.value) })}
            onBlur={() => setForm((f) => ({ ...f, durationSec: clampDuration(f.durationSec) }))} />
        </label>
        <button type="button" className="primary" data-w3t="start" disabled={!canStart} onClick={() => void start()}>{d["w3t_render"]}</button>
        {running ? <button type="button" data-w3t="cancel" disabled={busy} onClick={() => void cancel()}>{d["w3t_cancel"]}</button> : null}
      </div>
      {!running && !file && !(props.session.files ?? []).some((f) => typeof f === "string" && f.endsWith(".glb")) ? <div className="fine">{d["w3t_need_glb"]}</div> : null}
      {blocked ? <div className="fine" role="status" data-w3t="blocked">{blocked}</div> : null}
      {running ? (
        <div data-w3t="progress" role="status">
          <div className="fine">{label}</div>
          <progress max={100} value={percent} aria-label={d["w3t_title"]} style={{ width: "100%" }} />
        </div>
      ) : null}
      {!running && tt?.phase === "cancelled" ? <div className="fine" role="status">{d["w3t_cancelled"]}</div> : null}
      {!running && tt?.phase === "failed" && tt.error ? <div className="error" role="alert">{tt.error}</div> : null}
      {err ? <div className="error" role="alert" data-w3t="error">{err}</div> : null}
      {!running && file ? (
        <div data-w3t="result">
          {video.url ? (
            <video src={video.url} controls loop playsInline aria-label={d["w3t_video_label"]} style={{ maxWidth: "100%", maxHeight: 360 }} />
          ) : video.loading ? <div className="fine">{d["w3t_loading_video"]}</div> : null}
          <div style={{ marginTop: 6 }}>
            <button type="button" data-w3t="download" onClick={() => { setErr(null); actions.download(props.slug, file).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))); }}>{d["w3t_download"]}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
