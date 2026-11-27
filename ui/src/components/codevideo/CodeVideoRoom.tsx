import { useCallback, useEffect, useRef, useState } from "react";
import { pick } from "../../lib/lang";
import { ApiError } from "../../api";
import { codeVideoApi, downloadCodeVideo } from "../../codevideo/client";
import type { CvDetail } from "../../codevideo/client";
import {
  assetKindLabel,
  elapsedSince,
  formatBytes,
  formatCost,
  formatDuration,
  frameSizeText,
  friendlyError,
  isBusyState,
  jobPercent,
  jobProgressText,
  projectErrorText,
  sheetCandidates,
  stateLabel,
} from "../../codevideo/logic";
import { useBlobUrl } from "../../codevideo/useBlobUrl";
import "./codevideo.css";

const POLL_MS = 1500;
const SHEETS = sheetCandidates();

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : friendlyError(undefined, undefined);
}

/** Rendered video of the project, fetched with the token header and played from an object URL. */
function VideoBox(props: { slug: string; rel: string; stamp: string }) {
  const { url, status } = useBlobUrl(props.slug, [props.rel], props.stamp);
  if (status === "missing") return <p className="cv-error" role="alert">{pick("Không tải được video.", "The video could not be loaded.")}</p>;
  if (!url) return <p className="muted" role="status">{pick("Đang tải video...", "Loading the video...")}</p>;
  return <video className="cv-player" src={url} controls preload="metadata" aria-label={pick("Video đã dựng", "Rendered video")} />;
}

/** Latest contact sheet the coder looked at (out/sheet-N.png); renders nothing when there is none yet. */
function SheetBox(props: { slug: string; stamp: string }) {
  const { url, status, rel } = useBlobUrl(props.slug, SHEETS, props.stamp);
  if (status !== "ready" || !url) return null;
  return (
    <figure className="cv-sheet">
      <img src={url} alt={pick("Bảng khung hình để kiểm tra video", "Frame sheet used to check the video")} />
      <figcaption className="muted">{pick("Bảng khung mới nhất", "Latest frame sheet")} ({rel})</figcaption>
    </figure>
  );
}

/**
 * Project room: player + download, live job progress (polls every 1.5 s while a job runs), the latest frame sheet,
 * a box to ask for changes, cancel / rebuild, the footage list with upload, and the estimated cost (view only).
 */
export function CodeVideoRoom(props: { slug: string; onDeleted: () => void; onChanged?: () => void }) {
  const { slug } = props;
  const [detail, setDetail] = useState<CvDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const fetching = useRef(false);

  const refetch = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const d = await codeVideoApi.get(slug);
      if (!mounted.current) return;
      setDetail(d);
      setLoadError(null);
    } catch (e) {
      if (mounted.current) setLoadError(errMsg(e));
    } finally {
      fetching.current = false;
    }
  }, [slug]);

  useEffect(() => {
    mounted.current = true;
    void refetch();
    return () => {
      mounted.current = false;
    };
  }, [refetch]);

  const job = detail?.job ?? null;
  const polling = !!job || (detail ? isBusyState(detail.state) : false);
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      setNow(Date.now());
      void refetch();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [polling, refetch]);

  // Tell the parent (tower badges) once when a job ends.
  const hadJob = useRef(false);
  useEffect(() => {
    if (hadJob.current && !job) props.onChanged?.();
    hadJob.current = !!job;
  }, [job, props]);

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setActionError(errMsg(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
    await refetch();
    props.onChanged?.();
  };

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setUploading(true);
    setActionError(null);
    try {
      for (const f of Array.from(list)) {
        try {
          await codeVideoApi.uploadAsset(slug, f);
        } catch (e) {
          if (mounted.current) setActionError(`${f.name}: ${errMsg(e)}`);
        }
      }
    } finally {
      if (mounted.current) setUploading(false);
      await refetch();
    }
  };

  if (!detail) {
    return loadError ? (
      <div className="cv-room">
        <p className="cv-error" role="alert">{loadError}</p>
        <button type="button" className="cv-secondary" onClick={() => void refetch()}>{pick("Thử lại", "Try again")}</button>
      </div>
    ) : (
      <p className="muted" role="status">{pick("Đang tải dự án...", "Loading the project...")}</p>
    );
  }

  const running = !!job;
  const pct = job ? jobPercent(job) : null;
  const stamp = `${detail.updatedAt}|${detail.video ?? ""}`;
  const sheetStamp = `${detail.updatedAt}|${job ? `${job.phase}-${job.round}` : "idle"}`;
  const showSheet = running || detail.state === "done" || detail.state === "failed";

  return (
    <div className="cv-room">
      <header className="cv-room-head">
        <span className={`cv-badge cv-badge-${detail.state}`}>{stateLabel(detail.state)}</span>
        <span className="muted">{frameSizeText(detail.width, detail.height, detail.fps)} - {formatDuration(detail.duration)}</span>
        <span className="muted" title={pick("Chi phí ước tính chỉ để xem, không có trần.", "Estimated cost, for viewing only; there is no cap.")}>
          {pick("Chi phí ước tính", "Estimated cost")}: {formatCost(detail.costUsd)} ({pick(`${detail.rounds} vòng`, `${detail.rounds} rounds`)})
        </span>
      </header>

      {loadError ? <p className="cv-error" role="alert">{loadError}</p> : null}
      {detail.error && !running ? <p className="cv-error" role="alert">{projectErrorText(detail.error)}</p> : null}
      {actionError ? <p className="cv-error" role="alert">{actionError}</p> : null}

      {running && job ? (
        <section className="cv-progress" aria-label={pick("Tiến độ", "Progress")}>
          <p role="status">
            {jobProgressText(job)} <span className="muted">({pick("đã chạy", "elapsed")} {elapsedSince(job.startedAt, now)})</span>
          </p>
          {pct !== null ? (
            <div className="cv-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={pick("Tiến độ dựng", "Render progress")}>
              <div className="cv-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          ) : (
            <div className="cv-bar cv-bar-wait" role="progressbar" aria-label={pick("Claude đang làm việc", "Claude is working")}>
              <div className="cv-bar-fill" />
            </div>
          )}
          <button type="button" className="cv-danger" disabled={busy} onClick={() => void act(() => codeVideoApi.cancel(slug))}>
            {pick("Hủy", "Cancel")}
          </button>
        </section>
      ) : null}

      <section className="cv-stage" aria-label={pick("Video", "Video")}>
        {detail.video ? (
          <>
            <VideoBox slug={slug} rel={detail.video} stamp={stamp} />
            <div className="cv-actions">
              <button type="button" className="cv-secondary" onClick={() => void downloadCodeVideo(slug, `${detail.title || "video"}.mp4`).catch((e: unknown) => setActionError(errMsg(e)))}>
                {pick("Tải video về", "Download video")}
              </button>
            </div>
          </>
        ) : (
          <p className="cv-empty">{running ? pick("Video đang được làm, sẽ hiện ở đây khi xong.", "The video is being made and will appear here when done.") : pick("Chưa có video. Bấm Tạo video để Claude viết và dựng.", "No video yet. Press Create video to have Claude write and render it.")}</p>
        )}
      </section>

      {showSheet ? <SheetBox slug={slug} stamp={sheetStamp} /> : null}

      <section className="cv-revise" aria-label={pick("Sửa video", "Revise the video")}>
        <label className="cv-field">
          <span>{pick("Nhắn Claude sửa video", "Ask Claude to change the video")}</span>
          <textarea
            rows={3}
            value={instruction}
            disabled={running}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={pick("Ví dụ: cảnh 2 chữ to hơn, đổi nền sang màu xanh đậm, thêm số hotline ở cuối.", "Example: make the text in scene 2 bigger, use a dark blue background, add the hotline at the end.")}
          />
        </label>
        <div className="cv-actions">
          <button
            type="button"
            className="cv-primary"
            disabled={busy || running || instruction.trim() === ""}
            onClick={() => void act(async () => { await codeVideoApi.revise(slug, instruction.trim()); setInstruction(""); })}
          >
            {pick("Sửa video", "Revise video")}
          </button>
          {detail.video ? (
            <button type="button" className="cv-secondary" disabled={busy || running} onClick={() => void act(() => codeVideoApi.render(slug))}>
              {pick("Dựng lại", "Render again")}
            </button>
          ) : (
            <button type="button" className="cv-primary" disabled={busy || running} onClick={() => void act(() => codeVideoApi.generate(slug))}>
              {pick("Tạo video", "Create video")}
            </button>
          )}
        </div>
      </section>

      <section className="cv-assets" aria-label={pick("Tư liệu", "Footage")}>
        <h4>{pick("Tư liệu", "Footage")} ({detail.assets.length})</h4>
        {detail.assets.length === 0 ? (
          <p className="muted">{pick("Chưa có tư liệu. Tải ảnh, video, âm thanh hoặc phông để Claude dùng.", "No footage yet. Upload images, video, audio or fonts for Claude to use.")}</p>
        ) : (
          <ul className="cv-files">
            {detail.assets.map((a) => (
              <li key={a.path}>
                <span className="cv-kind">{assetKindLabel(a.kind)}</span>
                <span className="cv-name" title={a.path}>{a.path.replace(/^assets\//, "")}</span>
                <span className="muted">{formatBytes(a.bytes)}</span>
              </li>
            ))}
          </ul>
        )}
        <label className="cv-field">
          <span>{uploading ? pick("Đang tải lên...", "Uploading...") : pick("Tải thêm tư liệu", "Upload more footage")}</span>
          <input type="file" multiple disabled={uploading || running} aria-label={pick("Tải thêm tư liệu", "Upload more footage")} onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
        </label>
      </section>

      <section className="cv-danger-zone">
        {confirmDelete ? (
          <>
            <span>{pick("Xóa vĩnh viễn dự án này và mọi tệp của nó?", "Delete this project and all its files permanently?")}</span>
            <button
              type="button"
              className="cv-danger"
              disabled={busy || running}
              onClick={() => void (async () => {
                setBusy(true);
                try {
                  await codeVideoApi.remove(slug);
                  props.onDeleted();
                } catch (e) {
                  setActionError(errMsg(e));
                  setBusy(false);
                  setConfirmDelete(false);
                }
              })()}
            >
              {pick("Xóa hẳn", "Delete for good")}
            </button>
            <button type="button" className="cv-secondary" onClick={() => setConfirmDelete(false)}>{pick("Giữ lại", "Keep")}</button>
          </>
        ) : (
          <button type="button" className="cv-secondary" disabled={busy || running} onClick={() => setConfirmDelete(true)}>
            {pick("Xóa dự án", "Delete project")}
          </button>
        )}
      </section>
    </div>
  );
}
