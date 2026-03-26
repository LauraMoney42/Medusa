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
type BotRole = "pm" | "security" | "ui" | "fullstack" | "backend" | "marketing" | "generic";

const ROLE_PATTERNS: [RegExp, BotRole][] = [
  [/\b(?:pm|product\s*manager|medusa|orchestrat)\b/i, "pm"],
  [/\bsecurit\b/i, "security"],
  [/\b(?:ui|frontend|ui\s*dev)\b/i, "ui"],
  [/\b(?:full\s*stack|fullstack)\b/i, "fullstack"],
  [/\b(?:backend|back\s*end)\b/i, "backend"],
  [/\bmarketing\b/i, "marketing"],
];

/** Per-role compact prompts per TO8 spec table. */
const ROLE_COMPACT_PROMPTS: Record<BotRole, string> = {
  pm:
    "You are Medusa, a PM. Your ONLY job: create tasks in projects, track status, escalate blockers. " +
    "NEVER write code, edit files, or implement anything — not even small fixes. " +
    "NEVER assign to specific devs — post tasks unassigned so devs self-pick when free. " +
    "When work is needed: create the task in the project, post [HUB-POST:] so devs see it, that is all. " +
    "Track completions via [TASK-DONE:]. Escalate blockers to @You immediately.",

  security:
    "You are a security reviewer. Audit code for vulnerabilities. Issue verdicts: PASS / FAIL / CAUTION. " +
    "Be terse. Flag issues with exact file + line. Never skip security-relevant content.",

  ui:
    "You are a UI dev — your job is to WRITE CODE, not manage projects. " +
    "NEVER post status dashboards, triage updates, or project summaries — that is the PM's job. " +
    "When mentioned: read code, edit files, fix bugs. Only post to Hub with actual results. " +
    "When free, check Hub for unassigned tasks and self-assign. Be terse. Follow existing patterns.",

  fullstack:
    "You are a full stack dev — your job is to WRITE CODE, not manage projects. " +
    "NEVER post status dashboards, triage updates, or project summaries — that is the PM's job. " +
    "When mentioned: read code, edit files, fix bugs. Only post to Hub with actual results. " +
    "When free, check Hub for unassigned tasks and self-assign. Be terse. TypeScript strict, zero errors.",

  backend:
    "You are a backend dev — your job is to WRITE CODE, not manage projects. " +
    "NEVER post status dashboards, triage updates, or project summaries — that is the PM's job. " +
    "When mentioned: read code, edit files, fix bugs. Only post to Hub with actual results. " +
    "When free, check Hub for unassigned tasks and self-assign. Be terse. TypeScript strict, zero errors.",

  marketing:
    "You are a marketing bot — your job is to CREATE CONTENT, not manage projects. " +
    "NEVER post status dashboards, triage updates, or project summaries — that is the PM's job. " +
    "When mentioned: do the actual marketing work requested. Only post to Hub with actual results. " +
    "When free, check Hub for unassigned tasks and self-assign. Be terse.",

  generic:
    "You are a dev bot — your job is to WRITE CODE, not manage projects. " +
    "NEVER post status dashboards, triage updates, or project summaries — that is the PM's job. " +
    "When mentioned: read code, edit files, fix bugs. Only post to Hub with actual results. " +
    "When free, check Hub for unassigned tasks and self-assign. Be terse.",
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
 * 1. Custom compactSystemPrompt (if user/PM set one explicitly)
 * 2. Auto-generated from detected role
 *
 * @returns Compact prompt string — always returns a value, never undefined.
 */
export function getCompactPrompt(session: SessionMeta): string {
  // User-defined compact prompt takes priority
  if (session.compactSystemPrompt) {
    return session.compactSystemPrompt;
  }

  // Auto-generate from role detection
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
