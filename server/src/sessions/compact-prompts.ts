/**
 * TC-4B: Compact system prompt generator.
 *
 * Generates terse system prompts (~50% shorter) for routine bot operations
 * (polls, nudges, acks, bot-to-bot coordination). These replace the full
 * system prompt when compactMode=true to cut token usage on internal ops.
 *
 * Per TO8 spec: "Every bot has two prompt modes: full mode (complex tasks)
 * and compact mode (Hub checks, status updates, acknowledgments)."
 *
 * If a session has a custom compactSystemPrompt set, that takes priority.
 * Otherwise, we auto-generate one by detecting the bot's role from its name
 * or full system prompt.
 */

import type { SessionMeta } from "./store.js";

// Role detection patterns — matched against session name (case-insensitive)
type BotRole = "medusa" | "generic";

const ROLE_PATTERNS: [RegExp, BotRole][] = [
  [/\bmedusa\b/i, "medusa"],
];

/** Per-role compact prompts per TO8 spec table. */
const ROLE_COMPACT_PROMPTS: Record<BotRole, string> = {
  medusa:
    "You are Medusa, a hands-on coding assistant. You are NOT a PM. " +
    "Your job: write code, fix bugs, ship features, review code, help the user build software. " +
    "You may spin up sub-agents using the Agent tool for parallel work. " +
    "Post task completions via [TASK-DONE:]. Escalate blockers to @You immediately. " +
    "Use [HUB-POST: ...] only when the user needs to see it. Keep it under 50 tokens.\n" +
    "To create/update projects, read and edit ~/.claude-chat/projects.json using Read + Edit tools. " +
    "The server file-watches this path — changes appear in the Projects pane immediately. " +
    "Alternatively: bash ~/Documents/GIT/Medusa/scripts/manage-project.sh create --title '...' --summary '...' --content '...'\n" +
    "Schema: {id, title, summary, content, status:'active'|'complete', priority:'P0'-'P3', assignments:[{id,owner,task,status:'pending'|'in_progress'|'done'}], createdAt, updatedAt}",

  generic:
    "You are a hands-on assistant. Your job is to WRITE CODE and ship work, not manage projects. " +
    "When mentioned: read code, edit files, fix bugs. Only post to Hub with actual results. " +
    "Post task completions via [TASK-DONE:]. Be terse.",
};

/**
 * Detect the bot's role from its session name or system prompt content.
 */
function detectRole(session: SessionMeta): BotRole {
  // Check name first (faster, more reliable)
  for (const [pattern, role] of ROLE_PATTERNS) {
    if (pattern.test(session.name)) return role;
  }

  // Fallback: check system prompt content
  const prompt = session.systemPrompt || "";
  for (const [pattern, role] of ROLE_PATTERNS) {
    if (pattern.test(prompt)) return role;
  }

  return "generic";
}

/**
 * Get the compact system prompt for a session.
 *
 * Priority order:
 * 1. Custom compactSystemPrompt (if user set one explicitly)
 * 2. Auto-generated from detected role
 *
 * @returns Compact prompt string — always returns a value, never undefined.
 */
export function getCompactPrompt(session: SessionMeta): string {
  // Auto-generate from role detection
  // (the per-session compactSystemPrompt override was dropped with the bot roster)
  const role = detectRole(session);
  return ROLE_COMPACT_PROMPTS[role];
}

/**
 * Generate a compact prompt for a session (for preview/editing in UI).
 * Always uses the auto-generated version regardless of custom override.
 */
export function generateCompactPrompt(session: SessionMeta): string {
  const role = detectRole(session);
  return ROLE_COMPACT_PROMPTS[role];
}
