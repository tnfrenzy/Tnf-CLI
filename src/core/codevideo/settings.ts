// src/core/codevideo/settings.ts
// Global settings of the code-driven Video Studio: brand kit, review rounds, optional tool paths.
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../app/config.js";
import { CvError } from "./types.js";
import type { CvBrand } from "./types.js";

export interface CvSettings {
  brand: CvBrand;
  /** How many times the coder looks at a draft contact sheet and fixes it (0 to 3). */
  reviewRounds: number;
  /** Optional absolute paths overriding auto-detection. */
  browserPath: string | null;
  ffmpegPath: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function defaultBrand(): CvBrand {
  const file = path.join(REPO_ROOT, "config", "codevideo", "brand.example.json");
  return normalizeBrand(JSON.parse(fs.readFileSync(file, "utf8")), null);
}

function str(v: unknown, max: number, dflt: string): string {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : dflt;
}

function color(v: unknown, dflt: string): string {
  return typeof v === "string" && HEX.test(v) ? v : dflt;
}

/** Brand from untrusted input; `base` supplies defaults for missing fields. */
export function normalizeBrand(input: unknown, base: CvBrand | null): CvBrand {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const c = (o.colors && typeof o.colors === "object" ? o.colors : {}) as Record<string, unknown>;
  const f = (o.fonts && typeof o.fonts === "object" ? o.fonts : {}) as Record<string, unknown>;
  const b: CvBrand = base ?? {
    name: "THƯƠNG HIỆU",
    tagline: "",
    logo: "assets/logo.svg",
    colors: { primary: "#1e5bff", accent: "#ffc400", bg: "#06174a", text: "#ffffff" },
    fonts: { heading: "Segoe UI", body: "Segoe UI" },
    hotline: "",
    website: "",
  };
  const logo = typeof o.logo === "string" ? o.logo.trim() : b.logo;
  if (logo && (/^[a-z]+:/i.test(logo) || logo.startsWith("/") || logo.includes(".."))) {
    throw new CvError("Đường dẫn logo phải nằm trong thư mục dự án (ví dụ assets/logo.svg).", 400);
  }
  return {
    name: str(o.name, 120, b.name),
    tagline: typeof o.tagline === "string" ? o.tagline.trim().slice(0, 200) : b.tagline,
    logo: logo || b.logo,
    colors: {
      primary: color(c.primary, b.colors.primary),
      accent: color(c.accent, b.colors.accent),
      bg: color(c.bg, b.colors.bg),
      text: color(c.text, b.colors.text),
    },
    fonts: { heading: str(f.heading, 80, b.fonts.heading), body: str(f.body, 80, b.fonts.body) },
    hotline: typeof o.hotline === "string" ? o.hotline.trim().slice(0, 40) : b.hotline,
    website: typeof o.website === "string" ? o.website.trim().slice(0, 120) : b.website,
  };
}

export interface CvSettingsStore {
  get(): CvSettings;
  update(patch: unknown): CvSettings;
}

export function createCvSettingsStore(dataDir: string): CvSettingsStore {
  const file = path.join(dataDir, "codevideo", "settings.json");
  const load = (): CvSettings => {
    let raw: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
    } catch {
      /* first run or unreadable: defaults */
    }
    const base = defaultBrand();
    let brand = base;
    try {
      brand = normalizeBrand(raw.brand, base);
    } catch {
      /* keep default */
    }
    const rr = raw.reviewRounds;
    return {
      brand,
      reviewRounds: typeof rr === "number" && Number.isInteger(rr) && rr >= 0 && rr <= 3 ? rr : 1,
      browserPath: typeof raw.browserPath === "string" && raw.browserPath.trim() ? raw.browserPath.trim() : null,
      ffmpegPath: typeof raw.ffmpegPath === "string" && raw.ffmpegPath.trim() ? raw.ffmpegPath.trim() : null,
    };
  };
  return {
    get: load,
    update(patch) {
      const cur = load();
      const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
      const next: CvSettings = { ...cur };
      if (p.brand !== undefined) next.brand = normalizeBrand(p.brand, cur.brand);
      if (p.reviewRounds !== undefined) {
        const v = p.reviewRounds;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 3) throw new CvError("Số vòng tự kiểm phải là số nguyên từ 0 đến 3.", 400);
        next.reviewRounds = v;
      }
      for (const k of ["browserPath", "ffmpegPath"] as const) {
        if (p[k] === undefined) continue;
        const v = p[k];
        if (v === null || v === "") next[k] = null;
        else if (typeof v === "string" && path.isAbsolute(v) && fs.existsSync(v)) next[k] = v;
        else throw new CvError(`Đường dẫn ${k === "browserPath" ? "trình duyệt" : "ffmpeg"} không tồn tại.`, 400);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
      return next;
    },
  };
}
