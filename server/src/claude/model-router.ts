/**
 * Model routing logic for tiered model selection.
 * Routes interactions to the cheapest model that can handle them:
 * - haiku: Hub checks, status updates, acknowledgments, [NO-ACTION], simple Q&A
 * - sonnet: Coding tasks, code edits, feature implementation, devlog writes (default)
 * - opus: Architecture decisions, complex reviews, multi-step planning
 */

export type ModelTier = "haiku" | "sonnet" | "opus";

/** Map tier to next tier up on escalation (for retry on failure) */
export const NEXT_TIER: Record<ModelTier, ModelTier | null> = {
  haiku: "sonnet",
  sonnet: "opus",
  opus: null, // Already at max tier
};

/** Interaction context used to classify the appropriate model tier. */
export interface RoutingContext {
  /** The prompt text being sent */
  prompt: string;
  /** Where the interaction originates */
  source: "user" | "poll" | "mention" | "nudge";
  /** Optional override from session config */
  modelOverride?: string;
}

// Patterns that suggest architecture/planning work (-> opus)
const OPUS_PATTERNS = [
  /architect/i,
  /design.*system/i,
  /trade-?offs?/i,
  /refactor.*entire/i,
  /migration.*plan/i,
  /security.*review/i,
  /code.*review/i,
  /RFC/,
  /spec.*review/i,
];

// Patterns that suggest simple/routine work (-> haiku)
const HAIKU_PATTERNS = [
  /\[Hub Check\]/i,
  /\[NO-ACTION\]/i,
  /status.*check/i,
  /status.*update/i,
  /acknowledge/i,
  /confirm/i,
  /standing by/i,
  /no pending/i,
];

/**
 * Classify the interaction and return the appropriate model tier.
 * Uses a simple heuristic — source type first, then pattern matching.
 */
export function selectModel(ctx: RoutingContext): ModelTier {
  // Explicit override always wins
  if (ctx.modelOverride) {
    const lower = ctx.modelOverride.toLowerCase();
    if (lower === "haiku" || lower === "sonnet" || lower === "opus") {
      return lower;
    }
    // If it's a full model name, pass it through (handled by caller)
    return "sonnet";
  }

  // Poll checks and nudges are always cheap
  if (ctx.source === "poll" || ctx.source === "nudge") {
    return "haiku";
  }

  // Mention delivery: haiku for simple acks, sonnet for task work
  if (ctx.source === "mention") {
    // Short mentions are likely acks/status — use haiku
    if (ctx.prompt.length < 200) return "haiku";
    return "sonnet";
  }

  // User messages: check patterns
  for (const pattern of HAIKU_PATTERNS) {
    if (pattern.test(ctx.prompt)) return "haiku";
  }

  for (const pattern of OPUS_PATTERNS) {
    if (pattern.test(ctx.prompt)) return "opus";
  }

  // Default for user messages: sonnet (coding tasks)
  return "sonnet";
}
