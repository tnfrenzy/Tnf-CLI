/**
 * Automatic model distribution by logical role tiers ("light" | "balanced" | "strong")
 * for Claude Code CLI accounts.
 */
import type { CliModelChoice, CliProviderId, ModelTier } from "../../shared-types.js";

/** Default tier assigned to each known role when distributing models automatically. */
export const ROLE_DEFAULT_TIER: Record<string, ModelTier> = {
  // Coding roles
  analyst: "light",
  critic: "light",
  qa: "light",
  planner: "balanced",
  implementer: "balanced",
  debug: "balanced",
  // Research roles
  searcher: "light",
  analyzer: "balanced",
  synthesizer: "strong",
  // Idea / queue roles
  "idea-interviewer": "strong",
  "idea-splitter": "strong",
  "idea-critic": "strong",
  // Video studio roles
  "video-director": "balanced",
  "video-editor": "balanced",
  // 3D workshop roles
  "tiep-nhan-3d": "light",
  "detail-planner": "balanced",
  "art-director": "balanced",
  "cad-modeler": "strong",
  "material-artist": "balanced",
  "render-director": "light",
  "visual-reviewer": "strong",
  "render-presenter": "light",
  "ar-optimizer": "light",
};

/** Infer a logical tier from any model id. */
export function inferModelTier(modelId: string): ModelTier {
  const m = modelId.trim().toLowerCase();
  if (!m) return "balanced";
  if (m.includes("haiku") || m.endsWith("-low")) return "light";
  if (m.includes("opus") || m.includes("fable")) return "strong";
  return "balanced";
}

/** Check whether a model id looks native to Claude Code CLI. */
export function isModelNativeToProvider(_provider: CliProviderId, modelId: string): boolean {
  const m = modelId.trim().toLowerCase();
  if (!m) return false;
  return m === "haiku" || m === "sonnet" || m === "opus" || m.startsWith("claude-");
}

const CLAUDE_PREF_BY_TIER: Record<ModelTier, readonly string[]> = {
  light: ["haiku", "sonnet"],
  balanced: ["sonnet", "opus", "haiku"],
  strong: ["opus", "claude-fable-5-2", "sonnet"],
};

/** Pick the best available Claude model for a tier. */
export function pickModelForTier(
  _provider: CliProviderId,
  tier: ModelTier,
  available: readonly CliModelChoice[],
): string {
  const availIds = new Set(available.map((m) => m.id));
  const prefs = CLAUDE_PREF_BY_TIER[tier];
  for (const cand of prefs) {
    if (availIds.size === 0 || availIds.has(cand)) return cand;
  }
  const byTier = available.find((m) => (m.tier ?? inferModelTier(m.id)) === tier);
  if (byTier) return byTier.id;
  return available[0]?.id ?? prefs[0] ?? "sonnet";
}

/**
 * Resolve a requested model for Claude Code CLI:
 * 1. If requestedModel is valid/native (or explicitly present in `available`), keep it.
 * 2. Otherwise infer its tier and map to the best available Claude model.
 * 3. If no requestedModel, use accountDefaultModel (if valid) or role's default tier.
 */
export function resolveModelForProvider(input: {
  provider: CliProviderId;
  requestedModel?: string | null | undefined;
  accountDefaultModel?: string | null | undefined;
  role?: string | undefined;
  available: readonly CliModelChoice[];
}): string {
  const { provider, available } = input;
  const availIds = new Set(available.map((m) => m.id));
  const req = input.requestedModel?.trim() || "";
  if (req) {
    if (availIds.has(req) || isModelNativeToProvider(provider, req)) return req;
    const tier = inferModelTier(req);
    return pickModelForTier(provider, tier, available);
  }
  const def = input.accountDefaultModel?.trim() || "";
  if (def && (availIds.has(def) || isModelNativeToProvider(provider, def))) return def;
  const tier = (input.role && ROLE_DEFAULT_TIER[input.role]) || "balanced";
  return pickModelForTier(provider, tier, available);
}

/** Auto-distribute models across a set of roles. */
export function autoDistributeRoleModels(
  provider: CliProviderId,
  roles: readonly string[],
  available: readonly CliModelChoice[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of roles) {
    const tier = ROLE_DEFAULT_TIER[r] ?? "balanced";
    out[r] = pickModelForTier(provider, tier, available);
  }
  return out;
}
