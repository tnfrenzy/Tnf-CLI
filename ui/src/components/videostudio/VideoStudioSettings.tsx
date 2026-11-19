import { useState } from "react";
import { api, ApiError } from "../../api";
import { useT } from "../../i18n";
import { settingsFormToInput, settingsToForm, type VsSettingsForm } from "../../videostudio/forms";
import { VS_PROFILE_LIMITS, type VsLibraryItem, type VsProfile, type VsSettingsPublic } from "../../../../src/core/videostudio/plan-types";
import { VideoLibraryBox } from "./VideoLibraryBox";

/** Video Studio settings: voice, media providers and ffmpeg path. Empty token = keep the saved one. */
export function VideoStudioSettings(props: { settings: VsSettingsPublic | null; onChanged: () => void; library?: VsLibraryItem[] }) {
  const { t } = useT();
  const [form, setForm] = useState<VsSettingsForm>(() => settingsToForm(props.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof VsSettingsForm>(k: K, v: VsSettingsForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setProfile = (k: keyof VsProfile, v: string) => setForm((f) => ({ ...f, profile: { ...f.profile, [k]: v } }));
  const profileField = (k: keyof VsProfile, label: string, rows: number) => (
    <label key={k}>
      {label}
      {rows <= 1 ? (
        <input value={form.profile[k]} maxLength={VS_PROFILE_LIMITS[k]} onChange={(e) => setProfile(k, e.target.value)} />
      ) : (
        <textarea rows={rows} value={form.profile[k]} maxLength={VS_PROFILE_LIMITS[k]} onChange={(e) => setProfile(k, e.target.value)} />
      )}
    </label>
  );

  const external = form.voiceProvider === "http" || form.mediaProvider === "http";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.videoStudioSettingsPut(settingsFormToInput(form));
      setForm((f) => ({ ...f, voiceToken: "", mediaToken: "" }));
      props.onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vs-settings">
      <section className="vs-profile">
        <h4>{t.vs_p_title}</h4>
        <p className="muted">{t.vs_p_intro}</p>
        {profileField("brand", t.vs_p_brand ?? "", 1)}
        {profileField("slogan", t.vs_p_slogan ?? "", 1)}
        {profileField("about", t.vs_p_about ?? "", 3)}
        {profileField("products", t.vs_p_products ?? "", 4)}
        {profileField("facts", t.vs_p_facts ?? "", 5)}
        {profileField("contact", t.vs_p_contact ?? "", 2)}
        {profileField("avoid", t.vs_p_avoid ?? "", 3)}
      </section>
      <VideoLibraryBox files={props.library ?? []} onChanged={props.onChanged} />
      <label>
        {t.vs_set_ffmpeg_path}
        <input value={form.ffmpegPath} onChange={(e) => set("ffmpegPath", e.target.value)} />
      </label>
      {props.settings && !props.settings.ffmpegFound && <p className="error">{t.vs_ffmpeg_missing}</p>}
      <label>
        {t.vs_set_voice_provider}
        <select
          value={form.voiceProvider}
          onChange={(e) => set("voiceProvider", e.target.value === "http" ? "http" : e.target.value === "windows" ? "windows" : "none")}
        >
          <option value="none">none</option>
          <option value="windows">windows</option>
          <option value="http">http</option>
        </select>
      </label>
      <label>
        {t.vs_set_voice_name}
        <input value={form.voiceName} onChange={(e) => set("voiceName", e.target.value)} />
      </label>
      <label>
        {t.vs_set_voice_rate}
        <input type="number" min="-10" max="10" step="1" value={form.voiceRate} onChange={(e) => set("voiceRate", e.target.value)} />
      </label>
      {form.voiceProvider === "http" && (
        <>
          <label>
            {t.vs_set_voice_url}
            <input value={form.voiceUrl} onChange={(e) => set("voiceUrl", e.target.value)} />
          </label>
          <label>
            {t.vs_set_token}
            <input type="password" autoComplete="off" value={form.voiceToken} onChange={(e) => set("voiceToken", e.target.value)} />
          </label>
          {props.settings?.voice.hasToken && <p className="muted">{t.vs_set_token_saved}</p>}
        </>
      )}
      <label>
        {t.vs_set_media_provider}
        <select value={form.mediaProvider} onChange={(e) => set("mediaProvider", e.target.value === "http" ? "http" : "none")}>
          <option value="none">none</option>
          <option value="http">http</option>
        </select>
      </label>
      {form.mediaProvider === "http" && (
        <>
          <label>
            {t.vs_set_media_url}
            <input value={form.mediaUrl} onChange={(e) => set("mediaUrl", e.target.value)} />
          </label>
          <label>
            {t.vs_set_token}
            <input type="password" autoComplete="off" value={form.mediaToken} onChange={(e) => set("mediaToken", e.target.value)} />
          </label>
          {props.settings?.media.hasToken && <p className="muted">{t.vs_set_token_saved}</p>}
        </>
      )}
      {external && <p className="warning">{t.vs_external_warning}</p>}
      {error && <p className="error">{error}</p>}
      <button type="button" data-action="save-settings" disabled={busy} onClick={() => void save()}>
        {t.vs_btn_save}
      </button>
    </div>
  );
}
