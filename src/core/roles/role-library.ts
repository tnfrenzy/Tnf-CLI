import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateExtraAgents, type ExtraAgentDef } from "../run/extras.js";

/** Global library of custom roles and skill/prompt text items (`data/library/library.json`). */
export const MAX_LIBRARY_ROLES = 30;
export const MAX_LIBRARY_ITEMS = 100;
export const MAX_ITEM_BYTES = 64 * 1024;
export const MAX_ITEM_NAME = 80;
/** Cap on the total library text appended to prompts in one run (all roles + coordinator). */
export const MAX_LIBRARY_APPEND_BYTES = 64 * 1024;

export type LibraryItemType = "skill" | "prompt";

export interface LibraryRole extends ExtraAgentDef {
  id: string;
}

export interface LibraryItem {
  id: string;
  name: string;
  type: LibraryItemType;
  content: string;
  /** Ids of roles (built-in or custom) whose prompt gets this item appended. Empty = coordinator context only. */
  roleIds: string[];
  createdAt: number;
}

export interface LibraryData {
  roles: LibraryRole[];
  items: LibraryItem[];
  /** Ids of built-in templates already seeded (never recreated once edited or deleted). */
  seeded?: string[];
  /** Saved snapshots of roles/items from before edits (bounded; see MAX_VERSIONS_*). */
  versions?: LibraryVersion[];
}

export const MAX_VERSIONS_PER_ENTRY = 10;
export const MAX_VERSIONS_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_VERSION_NOTE = 200;

export type LibraryEntryKind = "role" | "item";

export interface LibraryVersion {
  id: string;
  kind: LibraryEntryKind;
  entryId: string;
  at: number;
  note: string;
  role?: LibraryRole;
  item?: LibraryItem;
  truncated?: boolean;
}

const bytesCache = new WeakMap<LibraryVersion, number>();

export function versionBytes(v: LibraryVersion): number {
  const hit = bytesCache.get(v);
  if (hit !== undefined) return hit;
  const n = Buffer.byteLength(JSON.stringify(v), "utf8");
  bytesCache.set(v, n);
  return n;
}

function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

function cleanNote(n: string): string {
  return n.replace(/\s+/g, " ").trim().slice(0, MAX_VERSION_NOTE);
}

export function makeVersion(
  kind: LibraryEntryKind,
  entry: LibraryRole | LibraryItem,
  note: string,
  at: number,
  existing: LibraryVersion[],
): LibraryVersion {
  const copy = JSON.parse(JSON.stringify(entry)) as LibraryRole & LibraryItem;
  let truncated = false;
  if (kind === "role") {
    if (typeof copy.prompt === "string") {
      const t = truncateUtf8(copy.prompt, MAX_ITEM_BYTES);
      if (t !== copy.prompt) {
        copy.prompt = t;
        truncated = true;
      }
    }
  } else if (typeof copy.content === "string") {
    const t = truncateUtf8(copy.content, MAX_ITEM_BYTES);
    if (t !== copy.content) {
      copy.content = t;
      truncated = true;
    }
  }
  const used = new Set(existing.map((e) => e.id));
  let id = randomUUID();
  while (used.has(id)) id = randomUUID();
  const v: LibraryVersion = { id, kind, entryId: entry.id, at, note: cleanNote(String(note ?? "")) };
  if (kind === "role") v.role = copy as LibraryRole;
  else v.item = copy as LibraryItem;
  if (truncated) v.truncated = true;
  return v;
}

export function appendVersion(
  versions: LibraryVersion[],
  v: LibraryVersion,
  opts: { maxPerEntry?: number; maxTotalBytes?: number } = {},
): LibraryVersion[] {
  const maxPer = opts.maxPerEntry ?? MAX_VERSIONS_PER_ENTRY;
  const maxBytes = opts.maxTotalBytes ?? MAX_VERSIONS_TOTAL_BYTES;
  let out = [...versions, v];
  const oldest = (list: LibraryVersion[]): LibraryVersion | undefined => {
    let o: LibraryVersion | undefined;
    for (const x of list) if (x !== v && (!o || x.at < o.at)) o = x;
    return o;
  };
  for (;;) {
    const group = out.filter((x) => x.kind === v.kind && x.entryId === v.entryId);
    if (group.length <= maxPer) break;
    const o = oldest(group);
    if (!o) break;
    out = out.filter((x) => x !== o);
  }
  let total = out.reduce((s, x) => s + versionBytes(x), 0);
  while (total > maxBytes) {
    const o = oldest(out);
    if (!o) break;
    out = out.filter((x) => x !== o);
    total -= versionBytes(o);
  }
  return out;
}

export function normalizeVersions(raw: unknown): LibraryVersion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ok: LibraryVersion[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const kind = r["kind"];
    if (kind !== "role" && kind !== "item") continue;
    if (typeof r["id"] !== "string" || !r["id"] || typeof r["entryId"] !== "string" || !r["entryId"]) continue;
    if (typeof r["at"] !== "number" || !Number.isFinite(r["at"])) continue;
    const body = r[kind];
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    if (seen.has(r["id"])) continue;
    seen.add(r["id"]);
    const v: LibraryVersion = {
      id: r["id"],
      kind,
      entryId: r["entryId"],
      at: r["at"],
      note: typeof r["note"] === "string" ? cleanNote(r["note"]) : "",
    };
    if (kind === "role") v.role = body as LibraryRole;
    else v.item = body as LibraryItem;
    if (r["truncated"] === true) v.truncated = true;
    ok.push(v);
  }
  ok.sort((a, b) => a.at - b.at);
  let acc: LibraryVersion[] = [];
  for (const v of ok) acc = appendVersion(acc, v);
  return acc;
}

export function listVersions(versions: LibraryVersion[], kind: LibraryEntryKind, entryId: string): LibraryVersion[] {
  return versions.filter((v) => v.kind === kind && v.entryId === entryId).sort((a, b) => b.at - a.at);
}

export function findVersion(
  versions: LibraryVersion[],
  kind: LibraryEntryKind,
  entryId: string,
  versionId: string,
): LibraryVersion | undefined {
  return versions.find((v) => v.kind === kind && v.entryId === entryId && v.id === versionId);
}

/** Error carrying an HTTP status; messages are Vietnamese. */
export class LibraryError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = canon(o[k]);
    return out;
  }
  return v;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

const ID_RE =/^[a-z0-9-]{1,40}$/;

/** Strip accents (đ → d), lowercase, non-alphanumerics → "-", max 40 chars. May return "" when nothing is left. */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .toLowerCase()
    .replace(new RegExp("\\u0111", "g"), "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export class RoleLibrary {
  private readonly file: string;

  /** `builtinNames` = names of the built-in roles (coding + research), read lazily. */
  constructor(dir: string, private readonly builtinNames: () => string[]) {
    this.file = path.join(dir, "library.json");
  }

  private read(): LibraryData {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<LibraryData>;
      const out: LibraryData = { roles: Array.isArray(j.roles) ? j.roles : [], items: Array.isArray(j.items) ? j.items : [] };
      if (Array.isArray(j.seeded)) out.seeded = j.seeded.filter((x) => typeof x === "string");
      const versions = normalizeVersions(j.versions);
      if (versions.length > 0) out.versions = versions;
      return out;
    } catch {
      return { roles: [], items: [] };
    }
  }

  /** Add built-in prompt templates once (by fixed id). Skips ids already seeded; writes only on change. */
  seedTemplates(templates: { id: string; name: string; content: string }[]): void {
    const d = this.read();
    const seeded = new Set(d.seeded ?? []);
    let changed = false;
    for (const t of templates) {
      if (seeded.has(t.id)) continue;
      if (d.items.some((i) => i.id === t.id)) {
        seeded.add(t.id);
        changed = true;
        continue;
      }
      if (d.items.length >= MAX_LIBRARY_ITEMS) continue;
      d.items.push({ id: t.id, name: t.name, type: "prompt", content: t.content, roleIds: [], createdAt: Date.now() });
      seeded.add(t.id);
      changed = true;
    }
    if (changed) this.write({ ...d, seeded: [...seeded] });
  }

  private write(d: LibraryData): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // other I/O error: do not overwrite
    }
    if (existing !== null) {
      let parseable = true;
      try {
        JSON.parse(existing);
      } catch {
        parseable = false;
      }
      if (!parseable) fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  list(): LibraryData & { builtinRoles: string[] } {
    const { versions: _versions, ...rest } = this.read();
    void _versions;
    return { ...rest, builtinRoles: this.builtinNames() };
  }

  // ---- roles -------------------------------------------------------------------------------------------------

  private cleanRole(id: string, body: Record<string, unknown>): LibraryRole {
    if (!ID_RE.test(id)) throw new LibraryError("Mã vai không hợp lệ (chỉ a-z, 0-9, dấu gạch ngang; tối đa 40 ký tự).");
    if (this.builtinNames().includes(id)) throw new LibraryError(`Mã vai "${id}" trùng với vai có sẵn.`);
    const def: Record<string, unknown> = {};
    for (const k of ["description", "prompt", "tools", "model"]) if (body[k] !== undefined) def[k] = body[k];
    try {
      const out = validateExtraAgents({ [id]: def }, this.builtinNames());
      return { id, ...out[id]! };
    } catch (e) {
      throw new LibraryError(e instanceof Error ? e.message : String(e));
    }
  }

  createRole(body: Record<string, unknown>): LibraryRole {
    const rawId = typeof body["id"] === "string" ? body["id"] : "";
    const id = normalizeName(rawId);
    if (!id) throw new LibraryError("Thiếu mã vai.");
    const d = this.read();
    if (d.roles.length >= MAX_LIBRARY_ROLES) throw new LibraryError(`Thư viện tối đa ${MAX_LIBRARY_ROLES} vai.`);
    if (d.roles.some((r) => r.id === id)) throw new LibraryError(`Vai "${id}" đã có trong thư viện.`, 409);
    const role = this.cleanRole(id, body);
    d.roles.push(role);
    this.write(d);
    return role;
  }

  updateRole(id: string, body: Record<string, unknown>): LibraryRole {
    const d = this.read();
    const i = d.roles.findIndex((r) => r.id === id);
    if (i < 0) throw new LibraryError("Không tìm thấy vai trong thư viện.", 404);
    const note = typeof body["note"] === "string" ? body["note"] : "";
    const { note: _note, ...rest } = body;
    void _note;
    const prev = d.roles[i]!;
    const role = this.cleanRole(id, { ...prev, ...rest });
    if (sameJson(role, prev)) return prev;
    const v = makeVersion("role", prev, note, Date.now(), d.versions ?? []);
    d.versions = appendVersion(d.versions ?? [], v);
    d.roles[i] = role;
    this.write(d);
    return role;
  }

  /** Saved versions of a role/item, newest first. 404 when the entry is gone and has no history. */
  history(kind: LibraryEntryKind, id: string): LibraryVersion[] {
    const d = this.read();
    const vs = listVersions(d.versions ?? [], kind, id);
    if (vs.length === 0) {
      const exists = kind === "role" ? d.roles.some((r) => r.id === id) : d.items.some((x) => x.id === id);
      if (!exists) throw new LibraryError("Không tìm thấy mục trong lịch sử.", 404);
    }
    return vs;
  }

  /**
   * Restore a role/item to a saved version (also when the entry was deleted). History is never dropped here except
   * by appendVersion's caps. Truncated snapshots are restorable on purpose (the user chose that version).
   */
  restoreVersion(kind: LibraryEntryKind, id: string, versionId: string, note?: string): { role?: LibraryRole; item?: LibraryItem } {
    const d = this.read();
    const ver = findVersion(d.versions ?? [], kind, id, versionId);
    if (!ver) throw new LibraryError("Không tìm thấy bản lịch sử cần khôi phục.", 404);
    if (kind === "role") {
      if (this.builtinNames().includes(id)) throw new LibraryError(`Mã vai "${id}" trùng với vai có sẵn.`, 409);
      const restored = this.cleanRole(id, (ver.role ?? {}) as unknown as Record<string, unknown>);
      const i = d.roles.findIndex((r) => r.id === id);
      if (i >= 0) {
        const n = (note ?? "").trim() || `Trước khi khôi phục bản ${versionId}`;
        const v = makeVersion("role", d.roles[i]!, n, Date.now(), d.versions ?? []);
        d.versions = appendVersion(d.versions ?? [], v);
        d.roles[i] = restored;
      } else {
        if (d.roles.length >= MAX_LIBRARY_ROLES) throw new LibraryError(`Thư viện tối đa ${MAX_LIBRARY_ROLES} vai.`);
        d.roles.push(restored);
      }
      this.write(d);
      return { role: restored };
    }
    const snap = (ver.item ?? {}) as Partial<LibraryItem>;
    const known = new Set([...this.builtinNames(), ...d.roles.map((r) => r.id)]);
    const roleIds = (Array.isArray(snap.roleIds) ? snap.roleIds : []).filter((r) => typeof r === "string" && known.has(r));
    const clean = this.cleanItem({ name: snap.name, type: snap.type, content: snap.content, roleIds }, d);
    const i = d.items.findIndex((x) => x.id === id);
    let item: LibraryItem;
    if (i >= 0) {
      const prev = d.items[i]!;
      const n = (note ?? "").trim() || `Trước khi khôi phục bản ${versionId}`;
      const v = makeVersion("item", prev, n, Date.now(), d.versions ?? []);
      d.versions = appendVersion(d.versions ?? [], v);
      item = { id, ...clean, createdAt: prev.createdAt };
      d.items[i] = item;
    } else {
      if (d.items.length >= MAX_LIBRARY_ITEMS) throw new LibraryError(`Thư viện tối đa ${MAX_LIBRARY_ITEMS} mục.`);
      item = { id, ...clean, createdAt: Date.now() };
      d.items.push(item);
    }
    this.write(d);
    return { item };
  }

  deleteRole(id: string): void {
    const d = this.read();
    if (!d.roles.some((r) => r.id === id)) throw new LibraryError("Không tìm thấy vai trong thư viện.", 404);
    d.roles = d.roles.filter((r) => r.id !== id);
    for (const it of d.items) it.roleIds = it.roleIds.filter((r) => r !== id);
    this.write(d);
  }

  // ---- items -------------------------------------------------------------------------------------------------

  private cleanItem(body: Record<string, unknown>, d: LibraryData, prev?: LibraryItem): Omit<LibraryItem, "id" | "createdAt"> {
    const name = typeof body["name"] === "string" ? body["name"].replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > MAX_ITEM_NAME) throw new LibraryError(`Tên mục phải có 1-${MAX_ITEM_NAME} ký tự.`);
    const type = body["type"];
    if (type !== "skill" && type !== "prompt") throw new LibraryError('Loại mục phải là "skill" hoặc "prompt".');
    const content = typeof body["content"] === "string" ? body["content"] : "";
    if (!content.trim()) throw new LibraryError("Nội dung mục trống.");
    if (Buffer.byteLength(content, "utf8") > MAX_ITEM_BYTES) throw new LibraryError(`Nội dung mục vượt ${MAX_ITEM_BYTES / 1024} KB.`);
    const rawIds = body["roleIds"] ?? prev?.roleIds ?? [];
    if (!Array.isArray(rawIds) || rawIds.some((r) => typeof r !== "string")) throw new LibraryError("roleIds phải là mảng chuỗi.");
    const roleIds = [...new Set(rawIds as string[])];
    const known = new Set([...this.builtinNames(), ...d.roles.map((r) => r.id)]);
    for (const r of roleIds) if (!known.has(r)) throw new LibraryError(`Vai "${r}" không tồn tại (không phải vai có sẵn hay vai trong thư viện).`);
    return { name, type, content, roleIds };
  }

  createItem(body: Record<string, unknown>): LibraryItem {
    const d = this.read();
    if (d.items.length >= MAX_LIBRARY_ITEMS) throw new LibraryError(`Thư viện tối đa ${MAX_LIBRARY_ITEMS} mục.`);
    const clean = this.cleanItem(body, d);
    const base = normalizeName(clean.name) || "item";
    let id = base;
    for (let n = 2; d.items.some((x) => x.id === id); n++) id = `${base.slice(0, 40 - String(n).length - 1)}-${n}`;
    const item: LibraryItem = { id, ...clean, createdAt: Date.now() };
    d.items.push(item);
    this.write(d);
    return item;
  }

  updateItem(id: string, body: Record<string, unknown>): LibraryItem {
    const d = this.read();
    const i = d.items.findIndex((x) => x.id === id);
    if (i < 0) throw new LibraryError("Không tìm thấy mục trong thư viện.", 404);
    const prev = d.items[i]!;
    const note = typeof body["note"] === "string" ? body["note"] : "";
    const { note: _note, ...rest } = body;
    void _note;
    const clean = this.cleanItem({ name: prev.name, type: prev.type, content: prev.content, ...rest }, d, prev);
    const item: LibraryItem = { id, ...clean, createdAt: prev.createdAt };
    if (sameJson(item, prev)) return prev;
    const v = makeVersion("item", prev, note, Date.now(), d.versions ?? []);
    d.versions = appendVersion(d.versions ?? [], v);
    d.items[i] = item;
    this.write(d);
    return item;
  }

  deleteItem(id: string): void {
    const d = this.read();
    if (!d.items.some((x) => x.id === id)) throw new LibraryError("Không tìm thấy mục trong thư viện.", 404);
    d.items = d.items.filter((x) => x.id !== id);
    this.write(d);
  }

  /** Items by id for a run; unknown ids → 400 in Vietnamese. */
  getItems(ids: string[]): LibraryItem[] {
    const d = this.read();
    return [...new Set(ids)].map((id) => {
      const it = d.items.find((x) => x.id === id);
      if (!it) throw new LibraryError(`Không tìm thấy mục thư viện "${id}".`);
      return it;
    });
  }

  getRole(id: string): LibraryRole | undefined {
    return this.read().roles.find((r) => r.id === id);
  }
}
