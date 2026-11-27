import { useEffect, useState } from "react";
import { pick } from "../../lib/lang";
import { ApiError } from "../../api";
import { codeVideoApi } from "../../codevideo/client";
import {
  FPS_CHOICES,
  FRAME_PRESETS,
  MAX_BRIEF,
  MAX_DURATION,
  MAX_TITLE,
  MIN_DURATION,
  formatBytes,
  friendlyError,
  presetLabel,
  validateAssetFile,
  validateCreateForm,
} from "../../codevideo/logic";
import type { FramePreset } from "../../codevideo/logic";
import "./codevideo.css";

const ACCEPT = "image/*,video/*,audio/*,.ttf,.otf,.woff,.woff2,.svg,.json";

/**
 * Create form of the code-driven Video Studio: title, description, frame preset, duration, footage files.
 * "Create and build" makes the project, uploads the files and starts the coder; "Create only" stops before building.
 */
export function CodeVideoCreate(props: { onCreated: (slug: string) => void; onClose?: () => void }) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [preset, setPreset] = useState<FramePreset["id"]>("portrait");
  const [duration, setDuration] = useState(30);
  const [fps, setFps] = useState(30);
  const [session, setSession] = useState("");
  const [models, setModels] = useState<Array<{ session: string; title: string; hasTurntable: boolean }>>([]);
  useEffect(() => {
    let alive = true;
    codeVideoApi.models3d().then((r) => alive && setModels(r.models)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<{ browser: boolean; ffmpeg: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    codeVideoApi
      .list()
      .then((r) => {
        if (alive) setTools(r.tools);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const frame = FRAME_PRESETS.find((p) => p.id === preset) ?? FRAME_PRESETS[0]!;

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      const bad = validateAssetFile(f.name, f.size);
      if (bad) {
        setError(`${f.name}: ${bad}`);
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setFiles(next);
  };

  const submit = async (build: boolean) => {
    const problem = validateCreateForm({ title, brief, width: frame.width, height: frame.height, duration, fps });
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await codeVideoApi.create({
        title: title.trim(),
        brief: brief.trim(),
        width: frame.width,
        height: frame.height,
        fps,
        duration,
        ...(session.trim() ? { model3dSession: session.trim() } : {}),
      });
      // One failed upload never undoes the project; the room lists the assets and can upload again.
      let failed = 0;
      for (const f of files) {
        try {
          await codeVideoApi.uploadAsset(project.slug, f);
        } catch {
          failed += 1;
        }
      }
      if (build) {
        try {
          await codeVideoApi.generate(project.slug);
        } catch {
          /* the room shows the error and the rebuild button */
        }
      }
      if (failed > 0) setError(pick(`${failed} tệp chưa tải lên được; hãy tải lại trong phòng dự án.`, `${failed} file(s) could not be uploaded; upload them again in the project room.`));
      props.onCreated(project.slug);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : friendlyError(undefined, undefined));
    } finally {
      setBusy(false);
    }
  };

  const missing = tools && (!tools.browser || !tools.ffmpeg);

  return (
    <form
      className="cv-form"
      aria-label={pick("Tạo video bằng mã", "Create a code-built video")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit(true);
      }}
    >
      {missing ? (
        <p className="cv-warn" role="status">
          {pick(
            "Máy chưa có " + [!tools.browser ? "Edge/Chrome" : "", !tools.ffmpeg ? "ffmpeg" : ""].filter(Boolean).join(" và ") + ". Có thể tạo dự án nhưng chưa dựng được; chỉ đường dẫn trong Cài đặt.",
            "This computer is missing " + [!tools.browser ? "Edge/Chrome" : "", !tools.ffmpeg ? "ffmpeg" : ""].filter(Boolean).join(" and ") + ". You can create the project but not render it yet; set the paths in Settings.",
          )}
        </p>
      ) : null}

      <label className="cv-field">
        <span>{pick("Tiêu đề video", "Video title")}</span>
        <input type="text" value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} placeholder={pick("Ví dụ: Giới thiệu thang máy gia đình", "Example: Home elevator introduction")} />
      </label>

      <label className="cv-field">
        <span>{pick("Mô tả video bạn muốn", "Describe the video you want")}</span>
        <textarea value={brief} maxLength={MAX_BRIEF} rows={6} onChange={(e) => setBrief(e.target.value)} placeholder={pick("Nội dung, các cảnh chính, giọng điệu, lời kêu gọi hành động...", "Content, main scenes, tone, call to action...")} />
        <small className="muted">{brief.length}/{MAX_BRIEF}</small>
      </label>

      <fieldset className="cv-field cv-fieldset">
        <legend>{pick("Cỡ khung", "Frame size")}</legend>
        <div className="cv-chips" role="radiogroup" aria-label={pick("Cỡ khung", "Frame size")}>
          {FRAME_PRESETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} className={preset === p.id ? "cv-chip active" : "cv-chip"} onClick={() => setPreset(p.id)}>
              {presetLabel(p.id)}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="cv-row">
        <label className="cv-field">
          <span>{pick(`Thời lượng (giây, ${MIN_DURATION}-${MAX_DURATION})`, `Duration (seconds, ${MIN_DURATION}-${MAX_DURATION})`)}</span>
          <input type="number" min={MIN_DURATION} max={MAX_DURATION} step={1} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
        </label>
        <label className="cv-field">
          <span>{pick("Khung hình/giây", "Frames per second")}</span>
          <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {FPS_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} fps
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="cv-field">
        <span>{pick("Tư liệu (ảnh, video, âm thanh, phông)", "Footage (images, video, audio, fonts)")}</span>
        <input type="file" multiple accept={ACCEPT} aria-label={pick("Chọn tệp tư liệu", "Choose footage files")} onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        {files.length === 0 ? (
          <small className="muted">{pick("Chưa chọn tệp nào. Có thể tải thêm sau trong phòng dự án.", "No files chosen. You can add more later in the project room.")}</small>
        ) : (
          <ul className="cv-files">
            {files.map((f) => (
              <li key={`${f.name}-${f.size}`}>
                <span className="cv-name" title={f.name}>{f.name}</span>
                <span className="muted">{formatBytes(f.size)}</span>
                <button type="button" className="cv-link" aria-label={pick(`Bỏ ${f.name}`, `Remove ${f.name}`)} onClick={() => setFiles(files.filter((x) => x !== f))}>
                  {pick("Bỏ", "Remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <label className="cv-field">
        <span>{pick("Phiên xưởng 3D (tùy chọn)", "3D workshop session (optional)")}</span>
        <select value={session} onChange={(e) => setSession(e.target.value)}>
          <option value="">{pick("Không dùng cảnh 3D", "No 3D scene")}</option>
          {models.map((m) => (
            <option key={m.session} value={m.session}>
              {m.title}{m.hasTurntable ? pick(" (đã có video quay)", " (turntable ready)") : ""}
            </option>
          ))}
        </select>
        <small className="muted">{pick("Dùng cho cảnh cabin 3D ở giai đoạn sau; hiện có thể để trống.", "For the 3D cabin scene in a later stage; you can leave it empty for now.")}</small>
      </label>

      {error ? (
        <p className="cv-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="cv-actions">
        <button type="submit" className="cv-primary" disabled={busy}>
          {busy ? pick("Đang tạo...", "Creating...") : pick("Tạo và Dựng", "Create and build")}
        </button>
        <button type="button" className="cv-secondary" disabled={busy} onClick={() => void submit(false)}>
          {pick("Chỉ tạo, chưa dựng", "Create only")}
        </button>
        {props.onClose ? (
          <button type="button" className="cv-secondary" disabled={busy} onClick={props.onClose}>
            {pick("Đóng", "Close")}
          </button>
        ) : null}
      </div>
    </form>
  );
}
