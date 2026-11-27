import { useEffect, useState } from "react";
import { pick } from "../../lib/lang";
import { ApiError } from "../../api";
import { codeVideoApi } from "../../codevideo/client";
import type { CvSettingsView } from "../../codevideo/client";
import { friendlyError } from "../../codevideo/logic";
import "./codevideo.css";

type ColorKey = "primary" | "accent" | "bg" | "text";

function colorLabel(k: ColorKey): string {
  if (k === "primary") return pick("Màu chính", "Primary color");
  if (k === "accent") return pick("Màu nhấn", "Accent color");
  if (k === "bg") return pick("Màu nền", "Background color");
  return pick("Màu chữ", "Text color");
}

const COLOR_KEYS: readonly ColorKey[] = ["primary", "accent", "bg", "text"];

/** Brand kit, self-review rounds and optional browser / ffmpeg paths of the code-driven Video Studio. */
export function CodeVideoSettings(props: { onSaved?: (s: CvSettingsView) => void }) {
  const [s, setS] = useState<CvSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    codeVideoApi
      .getSettings()
      .then((r) => {
        if (alive) setS(r);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof ApiError ? e.message : friendlyError(undefined, undefined));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!s) {
    return loadError ? <p className="cv-error" role="alert">{loadError}</p> : <p className="muted" role="status">{pick("Đang tải cài đặt...", "Loading settings...")}</p>;
  }

  const edit = (fn: (draft: CvSettingsView) => CvSettingsView) => {
    setSaved(false);
    setS((cur) => (cur ? fn(cur) : cur));
  };
  const setBrand = <K extends keyof CvSettingsView["brand"]>(k: K, v: CvSettingsView["brand"][K]) => edit((d) => ({ ...d, brand: { ...d.brand, [k]: v } }));

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await codeVideoApi.putSettings({
        brand: s.brand,
        reviewRounds: s.reviewRounds,
        browserPath: s.browserPath && s.browserPath.trim() ? s.browserPath.trim() : null,
        ffmpegPath: s.ffmpegPath && s.ffmpegPath.trim() ? s.ffmpegPath.trim() : null,
      });
      setS(r);
      setSaved(true);
      props.onSaved?.(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : friendlyError(undefined, undefined));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="cv-form"
      aria-label={pick("Cài đặt Xưởng Dựng Video", "Video studio settings")}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h4>{pick("Bộ nhận diện thương hiệu", "Brand kit")}</h4>
      <div className="cv-row">
        <label className="cv-field">
          <span>{pick("Tên thương hiệu", "Brand name")}</span>
          <input type="text" maxLength={120} value={s.brand.name} onChange={(e) => setBrand("name", e.target.value)} />
        </label>
        <label className="cv-field">
          <span>{pick("Khẩu hiệu", "Tagline")}</span>
          <input type="text" maxLength={200} value={s.brand.tagline} onChange={(e) => setBrand("tagline", e.target.value)} />
        </label>
      </div>
      <div className="cv-row">
        <label className="cv-field">
          <span>{pick("Hotline", "Hotline")}</span>
          <input type="text" maxLength={40} value={s.brand.hotline} onChange={(e) => setBrand("hotline", e.target.value)} />
        </label>
        <label className="cv-field">
          <span>{pick("Website", "Website")}</span>
          <input type="text" maxLength={120} value={s.brand.website} onChange={(e) => setBrand("website", e.target.value)} />
        </label>
      </div>

      <div className="cv-row">
        {COLOR_KEYS.map((k) => (
          <label className="cv-field cv-color" key={k}>
            <span>{colorLabel(k)}</span>
            <span className="cv-color-in">
              <input type="color" value={s.brand.colors[k]} aria-label={colorLabel(k)} onChange={(e) => edit((d) => ({ ...d, brand: { ...d.brand, colors: { ...d.brand.colors, [k]: e.target.value } } }))} />
              <code>{s.brand.colors[k]}</code>
            </span>
          </label>
        ))}
      </div>

      <div className="cv-row">
        <label className="cv-field">
          <span>{pick("Phông tiêu đề", "Heading font")}</span>
          <input type="text" maxLength={80} value={s.brand.fonts.heading} onChange={(e) => edit((d) => ({ ...d, brand: { ...d.brand, fonts: { ...d.brand.fonts, heading: e.target.value } } }))} />
        </label>
        <label className="cv-field">
          <span>{pick("Phông nội dung", "Body font")}</span>
          <input type="text" maxLength={80} value={s.brand.fonts.body} onChange={(e) => edit((d) => ({ ...d, brand: { ...d.brand, fonts: { ...d.brand.fonts, body: e.target.value } } }))} />
        </label>
      </div>

      <h4>{pick("Tự kiểm và công cụ", "Self-review and tools")}</h4>
      <label className="cv-field">
        <span>{pick("Số vòng tự kiểm (Claude xem bảng khung rồi tự sửa)", "Self-review rounds (Claude looks at the frame sheet and fixes it)")}</span>
        <select value={s.reviewRounds} onChange={(e) => edit((d) => ({ ...d, reviewRounds: Number(e.target.value) }))}>
          {[0, 1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? pick("0 (không tự kiểm)", "0 (no self-review)") : String(n)}
            </option>
          ))}
        </select>
      </label>
      <label className="cv-field">
        <span>{pick("Đường dẫn trình duyệt Edge/Chrome (tùy chọn, để trống = tự tìm)", "Edge/Chrome path (optional, empty = auto-detect)")}</span>
        <input type="text" value={s.browserPath ?? ""} onChange={(e) => edit((d) => ({ ...d, browserPath: e.target.value }))} placeholder="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" />
      </label>
      <label className="cv-field">
        <span>{pick("Đường dẫn ffmpeg (tùy chọn, để trống = tự tìm)", "ffmpeg path (optional, empty = auto-detect)")}</span>
        <input type="text" value={s.ffmpegPath ?? ""} onChange={(e) => edit((d) => ({ ...d, ffmpegPath: e.target.value }))} placeholder="C:\ffmpeg\bin\ffmpeg.exe" />
      </label>

      {error ? <p className="cv-error" role="alert">{error}</p> : null}
      {saved ? <p className="cv-ok" role="status">{pick("Đã lưu.", "Saved.")}</p> : null}
      <div className="cv-actions">
        <button type="submit" className="cv-primary" disabled={busy}>
          {busy ? pick("Đang lưu...", "Saving...") : pick("Lưu cài đặt", "Save settings")}
        </button>
      </div>
    </form>
  );
}
