// src/core/codevideo/store.ts
// File store of code-driven video projects under <dataDir>/codevideo/<slug>/. All paths are checked to stay inside.
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../app/config.js";
import { CV_DEFAULT_SIZE, CV_LIMITS, CvError } from "./types.js";
import type { CvAssetInfo, CvBrand, CvListItem, CvProject, CvState } from "./types.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const ASSET_KINDS: Record<string, CvAssetInfo["kind"]> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".svg": "image",
  ".mp4": "video", ".webm": "video", ".mov": "video",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio",
  ".ttf": "font", ".otf": "font", ".woff": "font", ".woff2": "font",
  ".json": "data",
};

export function isValidSlug(s: unknown): s is string {
  return typeof s === "string" && SLUG_RE.test(s);
}

/** ASCII slug from a (Vietnamese) title; never empty. */
export function slugFromTitle(title: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base || "video";
}

/** A file name safe to keep under assets/: letters, digits, dot, dash, underscore; known extension only. */
export function safeAssetName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (!(ext in ASSET_KINDS)) throw new CvError("Loại tệp tư liệu này chưa được hỗ trợ.", 400);
  const stem = path
    .basename(name, path.extname(name))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return `${stem || "tu-lieu"}${ext}`;
}

export function assetKind(file: string): CvAssetInfo["kind"] | null {
  return ASSET_KINDS[path.extname(file).toLowerCase()] ?? null;
}

function clamp(n: unknown, lo: number, hi: number, dflt: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

export interface CvCreateInput {
  title: string;
  brief: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  model3dSession?: string;
}

export function brandJs(brand: CvBrand): string {
  return [
    "// Copy of brand.json as a script (file:// pages cannot fetch JSON). Keep both in sync.",
    `window.TNF_BRAND = ${JSON.stringify(brand, null, 2)};`,
    "",
  ].join("\n");
}

export interface CvStore {
  root: string;
  list(): CvListItem[];
  get(slug: string): CvProject;
  dir(slug: string): string;
  create(input: CvCreateInput, brand: CvBrand): CvProject;
  update(slug: string, patch: Partial<Omit<CvProject, "slug" | "createdAt">>): CvProject;
  setState(slug: string, state: CvState, error?: string): CvProject;
  remove(slug: string): void;
  addAsset(slug: string, name: string, data: Buffer): CvAssetInfo;
  listAssets(slug: string): CvAssetInfo[];
  /** Absolute path of a file inside the project folder, or throws when it escapes it. */
  resolveInside(slug: string, rel: string): string;
  writeBrand(slug: string, brand: CvBrand): void;
}

export function createCvStore(dataDir: string): CvStore {
  const root = path.join(dataDir, "codevideo");
  fs.mkdirSync(root, { recursive: true });
  const templateDir = path.join(REPO_ROOT, "config", "codevideo", "template");
  const libDir = path.join(REPO_ROOT, "config", "codevideo", "lib");

  const dir = (slug: string): string => {
    if (!isValidSlug(slug)) throw new CvError("Mã dự án video không hợp lệ.", 400);
    return path.join(root, slug);
  };
  const file = (slug: string): string => path.join(dir(slug), "project.json");

  const read = (slug: string): CvProject => {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file(slug), "utf8"));
    } catch {
      throw new CvError("Không tìm thấy dự án video.", 404);
    }
    const o = (raw && typeof raw === "object" ? raw : {}) as Partial<CvProject>;
    const now = new Date().toISOString();
    return {
      slug,
      title: typeof o.title === "string" && o.title ? o.title : slug,
      state: (["draft", "coding", "rendering", "done", "failed"] as const).includes(o.state as CvState) ? (o.state as CvState) : "draft",
      width: clamp(o.width, CV_LIMITS.minSide, CV_LIMITS.maxSide, CV_DEFAULT_SIZE.width),
      height: clamp(o.height, CV_LIMITS.minSide, CV_LIMITS.maxSide, CV_DEFAULT_SIZE.height),
      fps: CV_LIMITS.fps.includes(o.fps as number) ? (o.fps as number) : CV_DEFAULT_SIZE.fps,
      duration: clamp(o.duration, CV_LIMITS.minDuration, CV_LIMITS.maxDuration, CV_DEFAULT_SIZE.duration),
      brief: typeof o.brief === "string" ? o.brief : "",
      ...(typeof o.error === "string" && o.error ? { error: o.error } : {}),
      ...(typeof o.video === "string" && o.video ? { video: o.video } : {}),
      ...(typeof o.audio === "string" && o.audio ? { audio: o.audio } : {}),
      ...(typeof o.model3dSession === "string" && o.model3dSession ? { model3dSession: o.model3dSession } : {}),
      createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : now,
      costUsd: typeof o.costUsd === "number" && Number.isFinite(o.costUsd) ? o.costUsd : 0,
      rounds: typeof o.rounds === "number" && Number.isInteger(o.rounds) && o.rounds >= 0 ? o.rounds : 0,
    };
  };

  const write = (p: CvProject): CvProject => {
    const next = { ...p, updatedAt: new Date().toISOString() };
    const tmp = `${file(p.slug)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, file(p.slug));
    return next;
  };

  const resolveInside = (slug: string, rel: string): string => {
    const base = path.resolve(dir(slug));
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new CvError("Đường dẫn nằm ngoài thư mục dự án.", 400);
    return abs;
  };

  const listAssets = (slug: string): CvAssetInfo[] => {
    const adir = path.join(dir(slug), "assets");
    if (!fs.existsSync(adir)) return [];
    const out: CvAssetInfo[] = [];
    for (const f of fs.readdirSync(adir)) {
      const kind = assetKind(f);
      const st = fs.statSync(path.join(adir, f));
      if (kind && st.isFile()) out.push({ path: `assets/${f}`, kind, bytes: st.size });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  };

  return {
    root,
    dir,
    resolveInside,
    listAssets,
    list() {
      const items: CvListItem[] = [];
      for (const name of fs.readdirSync(root)) {
        if (!isValidSlug(name)) continue;
        try {
          const p = read(name);
          items.push({
            slug: p.slug,
            title: p.title,
            state: p.state,
            updatedAt: p.updatedAt,
            width: p.width,
            height: p.height,
            duration: p.duration,
            hasVideo: !!p.video && fs.existsSync(path.join(dir(name), p.video)),
          });
        } catch {
          /* broken project folder: skip */
        }
      }
      return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    get: read,
    create(input, brand) {
      const title = (input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!title) throw new CvError("Hãy nhập tiêu đề video.", 400);
      const brief = (input.brief ?? "").trim();
      if (!brief) throw new CvError("Hãy mô tả video bạn muốn dựng.", 400);
      if (brief.length > CV_LIMITS.maxBriefChars) throw new CvError(`Mô tả quá dài (tối đa ${CV_LIMITS.maxBriefChars} ký tự).`, 400);
      if (countProjects(root) >= CV_LIMITS.maxProjects) throw new CvError("Đã đạt số dự án video tối đa.", 409);
      let slug = slugFromTitle(title);
      for (let n = 2; fs.existsSync(path.join(root, slug)); n++) slug = `${slugFromTitle(title).slice(0, 50)}-${n}`;
      const now = new Date().toISOString();
      const project: CvProject = {
        slug,
        title,
        state: "draft",
        width: clamp(input.width, CV_LIMITS.minSide, CV_LIMITS.maxSide, CV_DEFAULT_SIZE.width),
        height: clamp(input.height, CV_LIMITS.minSide, CV_LIMITS.maxSide, CV_DEFAULT_SIZE.height),
        fps: CV_LIMITS.fps.includes(input.fps as number) ? (input.fps as number) : CV_DEFAULT_SIZE.fps,
        duration: clamp(input.duration, CV_LIMITS.minDuration, CV_LIMITS.maxDuration, CV_DEFAULT_SIZE.duration),
        brief,
        ...(input.model3dSession ? { model3dSession: input.model3dSession } : {}),
        createdAt: now,
        updatedAt: now,
        costUsd: 0,
        rounds: 0,
      };
      const d = dir(slug);
      fs.mkdirSync(path.join(d, "assets"), { recursive: true });
      fs.mkdirSync(path.join(d, "out"), { recursive: true });
      fs.cpSync(templateDir, d, { recursive: true });
      fs.cpSync(libDir, path.join(d, "lib"), { recursive: true });
      // The motion API reference travels with the project so the coder (sandboxed to this folder) can read it.
      const motionDoc = path.join(REPO_ROOT, "config", "codevideo", "MOTION.md");
      if (fs.existsSync(motionDoc)) fs.copyFileSync(motionDoc, path.join(d, "MOTION.md"));
      fs.writeFileSync(path.join(d, "brand.json"), JSON.stringify(brand, null, 2), "utf8");
      fs.writeFileSync(path.join(d, "brand.js"), brandJs(brand), "utf8");
      return write(project);
    },
    update(slug, patch) {
      return write({ ...read(slug), ...patch, slug });
    },
    setState(slug, state, error) {
      const cur = read(slug);
      const next: CvProject = { ...cur, state };
      if (error) next.error = error;
      else delete next.error;
      return write(next);
    },
    remove(slug) {
      fs.rmSync(dir(slug), { recursive: true, force: true });
    },
    addAsset(slug, name, data) {
      read(slug);
      if (data.length > CV_LIMITS.maxAssetBytes) throw new CvError("Tệp tư liệu quá lớn (tối đa 200 MB).", 413);
      const safe = safeAssetName(name);
      const adir = path.join(dir(slug), "assets");
      fs.mkdirSync(adir, { recursive: true });
      let finalName = safe;
      for (let n = 2; fs.existsSync(path.join(adir, finalName)); n++) {
        const ext = path.extname(safe);
        finalName = `${path.basename(safe, ext)}-${n}${ext}`;
      }
      fs.writeFileSync(path.join(adir, finalName), data);
      const kind = assetKind(finalName)!;
      return { path: `assets/${finalName}`, kind, bytes: data.length };
    },
    writeBrand(slug, brand) {
      const d = dir(slug);
      fs.writeFileSync(path.join(d, "brand.json"), JSON.stringify(brand, null, 2), "utf8");
      fs.writeFileSync(path.join(d, "brand.js"), brandJs(brand), "utf8");
    },
  };
}

function countProjects(root: string): number {
  return fs.readdirSync(root).filter((n) => isValidSlug(n)).length;
}
