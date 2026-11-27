// Pure helpers for role eval: tool-name extraction from stream.jsonl and role version hash.
import { createHash } from "node:crypto";
import type { LibraryRole } from "./role-library.js";

const MAX_STREAM_CHARS = 5 * 1024 * 1024;

/** Distinct tool names from `assistant` events' `tool_use` blocks, in order of first appearance. */
export function extractToolNames(streamJsonl: string): string[] {
  const head = streamJsonl.length > MAX_STREAM_CHARS ? streamJsonl.slice(0, MAX_STREAM_CHARS) : streamJsonl;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof ev !== "object" || ev === null) continue;
    const e = ev as { type?: unknown; message?: { content?: unknown } };
    if (e.type !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (typeof b !== "object" || b === null) continue;
      const blk = b as { type?: unknown; name?: unknown };
      if (blk.type === "tool_use" && typeof blk.name === "string" && !seen.has(blk.name)) {
        seen.add(blk.name);
        out.push(blk.name);
      }
    }
  }
  return out;
}

/** First 12 hex chars of sha256 over the canonical role definition (tools order-insensitive). */
export function roleVersionHash(role: LibraryRole): string {
  const canon = JSON.stringify({
    description: role.description ?? "",
    prompt: role.prompt ?? "",
    tools: [...(role.tools ?? [])].sort(),
    model: role.model ?? "",
  });
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}
