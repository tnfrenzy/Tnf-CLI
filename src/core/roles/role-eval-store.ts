import fs from "node:fs";
import path from "node:path";
import { validateRoleEvalCases, type RoleEvalCase, type RoleEvalRunResult } from "./role-eval.js";
import { LibraryError } from "./role-library.js";

const ID_RE = /^[a-z0-9-]{1,40}$/;
const MAX_RESULTS = 50;
const DEFAULT_LIMIT = 20;

interface RoleEvalFile {
  cases: RoleEvalCase[];
  results: RoleEvalRunResult[];
}

/** Persists eval cases and run results per role: `<dir>/<roleId>.json` = `{ cases, results }`. */
export class RoleEvalStore {
  constructor(private readonly dir: string) {}

  private fileFor(roleId: string): string {
    if (typeof roleId !== "string" || !ID_RE.test(roleId)) {
      throw new LibraryError("roleId không hợp lệ", 400);
    }
    return path.join(this.dir, `${roleId}.json`);
  }

  private read(roleId: string): RoleEvalFile {
    const file = this.fileFor(roleId);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<RoleEvalFile> | null;
      return {
        cases: Array.isArray(raw?.cases) ? raw.cases : [],
        results: Array.isArray(raw?.results) ? raw.results : [],
      };
    } catch {
      return { cases: [], results: [] };
    }
  }

  private write(roleId: string, data: RoleEvalFile): void {
    const file = this.fileFor(roleId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  getCases(roleId: string): RoleEvalCase[] {
    return this.read(roleId).cases;
  }

  setCases(roleId: string, cases: unknown): RoleEvalCase[] {
    this.fileFor(roleId);
    const v = validateRoleEvalCases(cases);
    if (!v.ok) throw new LibraryError(v.errors[0] ?? "Ca đánh giá không hợp lệ", 400);
    const cur = this.read(roleId);
    this.write(roleId, { cases: v.cases, results: cur.results });
    return v.cases;
  }

  appendResult(r: RoleEvalRunResult): void {
    const cur = this.read(r.roleId);
    const results = [...cur.results, r].slice(-MAX_RESULTS);
    this.write(r.roleId, { cases: cur.cases, results });
  }

  listResults(roleId: string, limit: number = DEFAULT_LIMIT): RoleEvalRunResult[] {
    const all = this.read(roleId).results;
    let n = DEFAULT_LIMIT;
    if (typeof limit === "number" && !Number.isNaN(limit)) n = limit < 0 ? 0 : Math.floor(limit);
    return all.slice().reverse().slice(0, n);
  }

  remove(roleId: string): void {
    fs.rmSync(this.fileFor(roleId), { force: true });
  }
}
