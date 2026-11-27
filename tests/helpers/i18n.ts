import { dicts } from "../../ui/src/i18n.js";

const LANGS = ["vi", "en"] as const;

/**
 * Languages whose dictionary has a non-empty string for `key`; a complete key gives ["vi", "en"].
 * Tests use this instead of searching the i18n source files as text, so moving or reformatting the dictionaries
 * cannot break them.
 */
export function langsWithKey(key: string): string[] {
  return LANGS.filter((lang) => {
    const v = (dicts[lang] as Record<string, unknown>)[key];
    return typeof v === "string" && v.length > 0;
  });
}

export const BOTH_LANGS: string[] = [...LANGS];
