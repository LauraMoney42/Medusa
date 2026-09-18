/**
 * The Medusa layer's prompt composition (spec section C, addendum "The Medusa
 * layer").
 *
 * One prompt is built here and injected identically into every engine. The
 * only engine-dependent part is how the subagent tools are *named*: the claude
 * CLI presents MCP tools as `mcp__<server>__<tool>`, while the other harnesses
 * present them under their bare names. Nothing else may branch on the engine,
 * because a customization the user makes must apply to every brain.
 *
 * Layer order, top to bottom:
 *   1. persona      (~/.medusa/MEDUSA.md if present, else the bundled default)
 *   2. working folder discipline
 *   3. subagent instructions
 *   4. reply style
 *   5. user rules   (~/.medusa/rules/*.md, alphabetical, all on by default)
 *   6. project notes (the session's own systemPrompt)
 *
 * The session's systemPrompt is APPENDED, never substituted: per-chat notes
 * refine the orchestrator, they do not replace it.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

/** Tools the Medusa MCP server exposes (server/src/mcp/tools.ts). */
const SUBAGENT_TOOLS = [
  "spawn_agent",
  "agent_status",
  "agent_result",
  "list_agents",
  "cancel_agent",
] as const;

/**
 * Last-resort persona, used only when medusa-persona.md cannot be found on
 * disk (for instance a `dist/` deploy without the source tree beside it).
 * Keep it short: the .md file is the real source of truth.
 */
const FALLBACK_PERSONA =
  "You are Medusa, a hands-on coding assistant working with one person in one " +
  "project folder per chat. Write code, fix bugs, ship features, review diffs. " +
  "Use your Read, Edit, and shell tools to make real changes rather than " +
  "describing them. You are not a project manager and you do not produce " +
  "status dashboards.";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for the bundled persona. `tsc` does not copy .md files
 * into dist/, so a compiled build falls back to the source tree next to it.
 */
const BUNDLED_PERSONA_PATHS = [
  path.join(HERE, "medusa-persona.md"),
  path.join(HERE, "..", "..", "src", "sessions", "medusa-persona.md"),
];

/** Cached because the bundled file ships with the server and cannot change at runtime. */
let bundledPersonaCache: string | null = null;

function loadBundledPersona(): string {
  if (bundledPersonaCache !== null) return bundledPersonaCache;
  for (const candidate of BUNDLED_PERSONA_PATHS) {
    try {
      const text = fs.readFileSync(candidate, "utf-8").trim();
      if (text) {
        bundledPersonaCache = text;
        return text;
      }
    } catch {
      // try the next candidate
    }
  }
  bundledPersonaCache = FALLBACK_PERSONA;
  return FALLBACK_PERSONA;
}

/**
 * The user's Medusa layer directory. Read through process.env.HOME first so a
 * test (or a sandboxed run) can point the whole layer at a temp directory.
 */
function medusaDir(): string {
  return path.join(process.env.HOME || os.homedir(), ".medusa");
}

/** `~/.medusa/MEDUSA.md` overrides the bundled persona wholesale when present. */
function loadPersona(): string {
  try {
    const text = fs.readFileSync(path.join(medusaDir(), "MEDUSA.md"), "utf-8").trim();
    if (text) return text;
  } catch {
    // no user persona: fall through to the bundled one
  }
  return loadBundledPersona();
}

/**
 * Every `~/.medusa/rules/*.md`, alphabetical by filename. Each rule file is on
 * by default; per-session toggling happens above this function by passing an
 * explicit `rules` array.
 */
export function loadRuleFiles(): string[] {
  const dir = path.join(medusaDir(), "rules");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf-8").trim();
      if (text) out.push(text);
    } catch {
      // unreadable rule file: skip it rather than failing the turn
    }
  }
  return out;
}

export interface OrchestratorPromptInput {
  /** "claude" | "kimi" | "code-puppy" | undefined. Only changes tool naming. */
  engineId?: string;
  /** The session's own extra instructions. Appended, never substituted. */
  sessionSystemPrompt?: string;
  /** The chat's project folder. */
  workingDir: string;
  /** Override the persona (tests, packs, previews). */
  personaText?: string;
  /** Override the rule set (per-session toggles). Omit to read ~/.medusa/rules. */
  rules?: string[];
}

/** The claude CLI namespaces MCP tools; every other engine sees the bare name. */
export function toolName(engineId: string | undefined, tool: string): string {
  return engineId === "claude" ? `mcp__medusa__${tool}` : tool;
}

export function buildOrchestratorPrompt(input: OrchestratorPromptInput): string {
  const { engineId, sessionSystemPrompt, workingDir, personaText, rules } = input;

  const t = (tool: (typeof SUBAGENT_TOOLS)[number]) => toolName(engineId, tool);
  const persona = (personaText ?? loadPersona()).trim();
  const ruleTexts = (rules ?? loadRuleFiles()).map((r) => r.trim()).filter(Boolean);

  const sections: string[] = [persona];

  sections.push(
    [
      "## Working folder",
      "",
      `This chat's project folder is \`${workingDir}\`. Read, write, and run`,
      "commands inside it. Treat anything outside it as off limits: do not edit,",
      "delete, or create files elsewhere, and do not give a subagent a `cwd`",
      "outside it. If a task genuinely needs something outside the folder, say so",
      "and ask before acting.",
    ].join("\n")
  );

  sections.push(
    [
      "## Working with subagents",
      "",
      `You can run work in parallel by calling \`${t("spawn_agent")}\`. A subagent is a`,
      "fresh agent with its own context: it sees only the `task` string you give",
      "it, so write a complete, self-contained brief with file paths, the",
      "background it needs, and exactly what to report back. Its final text comes",
      "back to you as the tool result.",
      "",
      "- `task` (required): what to do, and what to report back.",
      "- `name`: a short label the user sees on the subagent's card.",
      "- `engine` / `model`: optional. Leave them out to inherit this chat's",
      "  settings. Set them when the user asks for a specific brain, or when cost",
      "  matters: a cheap model for bulk reading, a stronger one for hard",
      "  reasoning.",
      "- `cwd`: optional, must be inside this chat's folder.",
      "- `wait`: leave it `true` to get the result inline. Set `false` only when",
      "  launching several at once, then collect each one with",
      `  \`${t("agent_result")}\`.`,
      "",
      "Other tools:",
      `- \`${t("agent_status")}\` for one agent's live status, timing, and token use.`,
      `- \`${t("list_agents")}\` for everything in flight in this chat.`,
      `- \`${t("cancel_agent")}\` to stop one that is no longer needed.`,
      "",
      "Delegate when the work is independent and read-heavy: surveying a large",
      "codebase, running a test matrix, drafting one file while you draft",
      "another. Fan out only for genuinely independent tasks, so two subagents",
      "never edit the same file. Do the work yourself when it is small, when it",
      "needs this conversation's context, or when a spawn would cost more than",
      "just doing it. Never spawn for trivial work such as reading a single file",
      "or running one command.",
      "",
      "After a fan-out, wait for every result, integrate them yourself, and give",
      "the user one coherent answer. Do not paste raw subagent output and call it",
      "done, and do not report a task finished while an agent you spawned is",
      "still running.",
    ].join("\n")
  );

  sections.push(
    [
      "## Style",
      "",
      "Be concise. Lead with the action or the answer, then the detail if it is",
      "needed. No preamble, no filler, no restating the question, no summary of",
      "what you are about to do before you do it.",
      "",
      "Do not use the em-dash character. Never invent markers or bracketed",
      "protocol strings in your replies; every capability you have is a real",
      "tool, so call it.",
    ].join("\n")
  );

  if (ruleTexts.length > 0) {
    sections.push(["## Rules", "", ruleTexts.join("\n\n")].join("\n"));
  }

  const notes = (sessionSystemPrompt ?? "").trim();
  if (notes) {
    sections.push(["## Project notes", "", notes].join("\n"));
  }

  return sections.join("\n\n").trim();
}

export default buildOrchestratorPrompt;
