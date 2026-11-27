import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_ROLE_CALLS_CEILING, type AuthMode, type ControllerConfig, type RunKind } from "../app/config.js";
import type { CliProviderId } from "../shared-types.js";
import { MAX_LIBRARY_APPEND_BYTES, RoleLibrary, type LibraryItem } from "../roles/role-library.js";
import type { ExtraAgentDef } from "./extras.js";

export interface StartRunInput {
  prompt: string;
  mode?: AuthMode;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** false = single agent (no --agents / coordinator prompt), used for A/B tests. */
  roles?: boolean;
  /** Per-role model override, e.g. { searcher: "haiku", synthesizer: "opus" }. Written to a per-run roles file. */
  roleModels?: Record<string, string>;
  allowedTools?: string[];
  /** Scout run: adds read-only WebSearch/WebFetch (coding runs only; never inherited by follow-ups). */
  scout?: boolean;
  /** Project name (target repo or plain label); follow-ups inherit the parent's. */
  project?: string;
  /** Default: coding when the project has a repo_path, research otherwise. */
  kind?: RunKind;
  /** Staging id from `POST /api/inbox`: its files move into `<run-dir>/inbox/` before the run starts. */
  inboxStage?: string;
  /** New coding worktree starts from this ref (e.g. a dependency's branch) instead of the project's base branch. Ignored for follow-ups. */
  baseRef?: string;
  /** Internal only (never read from HTTP): reuse the worktree/branch of this earlier coding run; base_sha = its current HEAD. */
  reuseWorktreeOf?: string;
  /** Internal only: branches merged into a new worktree right after it is created (idea task depending on several branches). */
  mergeBranches?: string[];
  /** Internal only (never read from raw HTTP; validated by `resumeFrom()`): new worktree/branch starts at this commit of an earlier coding run. */
  resumeFrom?: { runId: string; sha: string };
  /** Internal only (read-only role calls): continue the Claude session of this earlier run (same run dir, new run id). Ignored unless that run finished with a session id in the same project. */
  resumeSessionOf?: string;
  /** Internal only: list this run in the same history thread as that earlier run (workshop3d role calls of one session); no resume semantics. */
  threadWith?: string;
  /** Extra subagents for this run only (name → definition); rejected in single mode. Validated by `extras.ts`. */
  extraAgents?: Record<string, ExtraAgentDef>;
  /** Skills allowed for this run as `Skill(<name>)`. */
  skills?: string[];
  /** Library item ids: their text is appended to the prompts of the roles each item ticks (no tools are added). */
  libraryItemIds?: string[];
  /**
   * Max subagent calls the coordinator may make (user input, before extras are added). Applies to coding runs only;
   * research runs ignore it. Validated against `limits.maxRoleCallsCeiling` (Vietnamese error, HTTP 400).
   */
  maxRoleCalls?: number;
  /** Read-only single-agent run (idea-splitter): no worktree, no coordinator, no Bash/Edit/Write/Agent. */
  readOnly?: ReadOnlySpec;
  /** Optional CLI account id (takes precedence over project default and global default). */
  accountId?: string | null;
  /** Optional preferred CLI provider when no explicit accountId is set. */
  provider?: CliProviderId;
  /** Custom agent name for providers that support `--agent <name>` (provider-specific). */
  agentName?: string;
  /** Optional reasoning effort. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ReadOnlySpec {
  systemPrompt: string;
  allowedTools: string[];
  addDirs: string[];
  /**
   * Sandbox-write mode (code-driven video coder): Write/Edit are allowed, but only scoped to these folders. Bash, agents
   * and network tools stay refused. Absent = fully read-only.
   */
  writeDirs?: string[];
}

/**
 * Base role-call budget of a run, before extra agents are added. Coding: the validated user input or the effective default
 * (>= 20). Research: always the configured default (the input is ignored). Throws a Vietnamese error when the input is
 * not an integer in 1..ceiling.
 */
export function resolveMaxRoleCalls(input: { maxRoleCalls?: unknown }, config: ControllerConfig, kind: RunKind): number {
  const kd = kind === "coding" ? config.defaults.coding : config.defaults.research;
  if (kind !== "coding") return kd.maxRoleCalls;
  const v = input.maxRoleCalls;
  if (v === undefined || v === null) return kd.maxRoleCalls;
  const ceiling = config.limits.maxRoleCallsCeiling ?? DEFAULT_MAX_ROLE_CALLS_CEILING;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > ceiling) {
    throw new Error(`Số lượt gọi vai tối đa phải là số nguyên từ 1 đến ${ceiling}.`);
  }
  return v;
}

export interface LibraryAppendPlan {
  /** role name → texts to append to that role's prompt */
  byRole: Record<string, string[]>;
  /** texts for items that tick no role: shown to the coordinator only */
  coordinator: string[];
  /** custom library roles pulled in by ticks (added like extra agents) */
  extraAgents: Record<string, ExtraAgentDef>;
  totalBytes: number;
}

/**
 * Decide where each library item goes. Ticks for built-in roles of another run kind are skipped; ticks for custom
 * library roles pull that role into the run. Throws (Vietnamese) when the appended text exceeds MAX_LIBRARY_APPEND_BYTES.
 */
export function planLibraryAppend(items: LibraryItem[], kindRoles: string[], library: RoleLibrary): LibraryAppendPlan {
  const allBuiltin = new Set(library.list().builtinRoles);
  const plan: LibraryAppendPlan = { byRole: {}, coordinator: [], extraAgents: {}, totalBytes: 0 };
  for (const item of items) {
    const text = `## ${item.type === "skill" ? "Skill" : "Prompt"}: ${item.name}\n\n${item.content}`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (!item.roleIds.length) {
      plan.coordinator.push(text);
      plan.totalBytes += bytes;
      continue;
    }
    for (const r of item.roleIds) {
      if (kindRoles.includes(r)) {
        // built-in role of this run
      } else if (allBuiltin.has(r)) {
        continue;
      } else {
        const custom = library.getRole(r);
        if (!custom) throw new Error(`Vai "${r}" của mục "${item.name}" không còn trong thư viện.`);
        if (!(r in plan.extraAgents)) {
          const { id: _id, ...def } = custom;
          plan.extraAgents[r] = def;
        }
      }
      (plan.byRole[r] ??= []).push(text);
      plan.totalBytes += bytes;
    }
  }
  if (plan.totalBytes > MAX_LIBRARY_APPEND_BYTES) {
    throw new Error(`Tổng nội dung thư viện nối vào prompt (${Math.ceil(plan.totalBytes / 1024)} KB) vượt giới hạn ${MAX_LIBRARY_APPEND_BYTES / 1024} KB; bỏ bớt mục hoặc bỏ tick vai.`);
  }
  return plan;
}

/** Trim/collapse a project label; empty → 'default'. */
export function normalizeProject(raw: string | undefined | null): string {
  const v = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return v || "default";
}

/** Read the role definitions file; returns {} when missing/invalid. */
export function readRoles(file: string): Record<string, Record<string, unknown>> {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
    return typeof j === "object" && j !== null ? j : {};
  } catch {
    return {};
  }
}

/**
 * Fill `{{name}}` placeholders of a coordinator prompt template (e.g. `{{maxRoleCalls}}`). Returns the template path
 * unchanged when it has no placeholders; otherwise writes the rendered copy to `outFile` and returns that path.
 */
export function renderSystemPrompt(templateFile: string, outFile: string, vars: Record<string, string>): string {
  if (!fs.existsSync(templateFile)) return templateFile;
  const text = fs.readFileSync(templateFile, "utf8");
  if (!/\{\{\s*\w+\s*\}\}/.test(text)) return templateFile;
  const rendered = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => (name in vars ? vars[name]! : m));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, rendered, "utf8");
  return outFile;
}

/**
 * Fill `{{name}}` placeholders in every role prompt in place. A placeholder left without a value throws a Vietnamese
 * error naming the role, so a typo in a role file fails the run early instead of reaching the model.
 */
export function renderRolePlaceholders(roles: Record<string, Record<string, unknown>>, vars: Record<string, string>): void {
  for (const [role, def] of Object.entries(roles)) {
    const prompt = def["prompt"];
    if (typeof prompt !== "string") continue;
    const rendered = prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => (name in vars ? vars[name]! : m));
    const left = rendered.match(/\{\{\s*\w+\s*\}\}/);
    if (left) throw new Error(`Prompt của vai "${role}" còn placeholder chưa thay: ${left[0]}`);
    roles[role] = { ...def, prompt: rendered };
  }
}

/** Default model per role from roles.json (for the UI selects). */
export function roleDefaultModels(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, def] of Object.entries(readRoles(file))) if (typeof def["model"] === "string") out[role] = def["model"];
  return out;
}
