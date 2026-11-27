import { buildImportPreview, type AgentMdPreview } from "./agent-md.js";
import {
  LibraryError,
  type LibraryEntryKind,
  type LibraryItem,
  type LibraryRole,
  type LibraryVersion,
  type RoleLibrary,
} from "./role-library.js";

function oneLine(s: unknown): string {
  return String(s ?? "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build agent-md style import text from a saved version (frontmatter + verbatim body). */
export function versionToImportText(v: LibraryVersion): string {
  const lines: string[] = ["---"];
  let body = "";
  if (v.kind === "role") {
    const r: Partial<LibraryRole> = v.role ?? {};
    lines.push(`name: "${oneLine(r.id ?? v.entryId)}"`);
    lines.push(`description: "${oneLine(r.description)}"`);
    const tools = Array.isArray(r.tools) ? r.tools.map((t) => oneLine(t)).filter((t) => t !== "") : [];
    if (tools.length > 0) lines.push(`tools: [${tools.join(", ")}]`);
    if (r.model) lines.push(`model: ${oneLine(r.model)}`);
    body = String(r.prompt ?? "");
  } else {
    const it: Partial<LibraryItem> = v.item ?? {};
    const name = oneLine(it.name ?? v.entryId);
    lines.push(`name: "${name}"`);
    lines.push(`description: "${name}"`);
    body = String(it.content ?? "");
  }
  lines.push("---");
  return lines.join("\n") + "\n" + body;
}

export interface RestorePreview {
  version: LibraryVersion;
  preview: AgentMdPreview;
}

export function previewRestore(lib: RoleLibrary, kind: LibraryEntryKind, id: string, versionId: string): RestorePreview {
  const version = lib.history(kind, id).find((v) => v.id === versionId);
  if (!version) throw new LibraryError("Không tìm thấy phiên bản cần khôi phục.", 404);
  const data = lib.list();
  const as: "role" | "skill" | "prompt" = kind === "role" ? "role" : (version.item?.type ?? "prompt");
  const preview = buildImportPreview(versionToImportText(version), {
    as,
    id,
    builtinRoles: data.builtinRoles,
    libraryRoleIds: data.roles.map((r) => r.id).filter((rid) => rid !== id),
    libraryItemCount: data.items.length,
  });
  return { version, preview };
}

export function restoreWithCheck(
  lib: RoleLibrary,
  kind: LibraryEntryKind,
  id: string,
  versionId: string,
  opts: { confirm?: boolean; note?: string } = {},
): { preview: AgentMdPreview; role?: LibraryRole; item?: LibraryItem } {
  const { preview } = previewRestore(lib, kind, id, versionId);
  if (preview.dangerKeywords.length > 0 && opts.confirm !== true) {
    throw new LibraryError(
      `Phiên bản này chứa từ khóa nguy hiểm: ${preview.dangerKeywords.join(", ")}. Cần xác nhận rõ ràng để khôi phục.`,
      400,
    );
  }
  if (preview.blocked === "empty") {
    throw new LibraryError("Phiên bản này rỗng hoặc thiếu nội dung, không thể khôi phục.", 400);
  }
  // id_conflict / library_full / license_not_permissive are ignored: restoreVersion checks its own limits.
  const out = lib.restoreVersion(kind, id, versionId, opts.note);
  return { preview, ...out };
}
