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
 *   5. user rules   (~/.medusa/rules/*.md, alphabetical, enabled ones only)
 *   6. project notes (the session's own systemPrompt)
 *
 * The ~/.medusa layer itself is owned by server/src/packs/store.ts: this module
 * only reads it, so persona front matter and the rules.json on/off state are
 * interpreted in exactly one place.
 *
 * The session's systemPrompt is APPENDED, never substituted: per-chat notes
 * refine the orchestrator, they do not replace it.
 */

import { loadEnabledRuleTexts, loadPersonaBody } from "../packs/store.js";

/** Tools the Medusa MCP server exposes (server/src/mcp/tools.ts). */
const SUBAGENT_TOOLS = [
  "spawn_agent",
  "agent_status",
  "agent_result",
  "list_agents",
  "cancel_agent",
] as const;

/**
 * `~/.medusa/MEDUSA.md` (front matter stripped) overrides the bundled persona
 * wholesale when present.
 */
function loadPersona(): string {
  return loadPersonaBody();
}

/**
 * The rule bodies for this turn: every `~/.medusa/rules/*.md` that is enabled
 * in `~/.medusa/rules.json`, alphabetical by filename. A rule with no entry in
 * rules.json counts as enabled. Per-session toggling happens above this
 * function by passing an explicit `rules` array.
 */
export function loadRuleFiles(): string[] {
  return loadEnabledRuleTexts();
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
  /**
   * True while the chat is in voice mode (S14). Adds spoken-style guidance:
   * the reply is going through TTS, so tables, bullet lists and code blocks
   * read badly out loud.
   */
  voiceMode?: boolean;
  /**
   * True when the prompt is the system instruction of a realtime speech model
   * (Live mode). That model has ONLY the declared subagent functions: no file,
   * shell, or code tools of its own. Saying otherwise makes it try a tool that
   * does not exist, and Gemini Live closes the socket (1008) when that happens.
   */
  liveTools?: boolean;
}

/** The claude CLI namespaces MCP tools; every other engine sees the bare name. */
export function toolName(engineId: string | undefined, tool: string): string {
  return engineId === "claude" ? `mcp__medusa__${tool}` : tool;
}

export function buildOrchestratorPrompt(input: OrchestratorPromptInput): string {
  const {
    engineId,
    sessionSystemPrompt,
    workingDir,
    personaText,
    rules,
    voiceMode,
    liveTools,
  } = input;

  const t = (tool: (typeof SUBAGENT_TOOLS)[number]) => toolName(engineId, tool);
  let persona = (personaText ?? loadPersona()).trim();
  if (liveTools) {
    persona = persona.replace(
      /Use your Read, Edit, and shell tools to make real changes rather than\s*describing them\./,
      "Get real work done by delegating it to subagents rather than describing it."
    );
  }
  const ruleTexts = (rules ?? loadRuleFiles()).map((r) => r.trim()).filter(Boolean);

  const sections: string[] = [persona];

  if (liveTools) {
    sections.push(
      [
        "## Your tools",
        "",
        `The only tools you have are the declared functions: \`${t("spawn_agent")}\`,`,
        `\`${t("agent_status")}\`, \`${t("agent_result")}\`, \`${t("list_agents")}\`, and`,
        `\`${t("cancel_agent")}\`. You have no file, shell, search, or code tools of`,
        "your own, and you cannot run commands. To look at files, list a folder,",
        "run anything, or change code, call the spawn agent function with a clear,",
        "complete task and report what it returns. Never attempt any tool that is",
        "not declared; there is no `ls`, no `read`, no `bash`. If a request needs",
        "no tool, just answer.",
      ].join("\n")
    );
  }

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
      ...(liveTools
        ? ["just doing it. Reading a file or running one command still needs a", "subagent here, because you have no such tools yourself; keep those tasks tiny."]
        : ["just doing it. Never spawn for trivial work such as reading a single file", "or running one command."]),
      "",
      "After a fan-out, wait for every result, integrate them yourself, and give",
      "the user one coherent answer. Do not paste raw subagent output and call it",
      "done, and do not report a task finished while an agent you spawned is",
      "still running.",
      "",
      "### Two lanes",
      "",
      "This conversation is one lane and it has to stay fast. Subagents are the",
      "other lane and that is where slow work belongs. Any task you expect to",
      `take more than a few seconds, or more than two tool calls, goes to \`${t(
        "spawn_agent"
      )}\``,
      "with `wait: false` instead of being done inline. Say in one sentence what",
      "you started, then keep talking to the user. Never hold the conversation",
      "open waiting on long work.",
      "",
      "When an agent finishes, the server hands you its result as a new turn",
      "beginning with `[Agent <name> <status>]`. The user did not type that, so",
      "do not answer it as if they had. Report it in one or two sentences: what",
      "came back and what you are doing next. Go longer only when the user asked",
      `for detail, and call \`${t("agent_result")}\` first if you need the full`,
      "output.",
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

  // Voice mode only: the reply is synthesized and played back, so anything
  // that depends on being seen (tables, bullets, code) has to be said instead.
  if (voiceMode) {
    sections.push(
      [
        "## Speaking",
        "",
        "This reply is being read out loud. Write it the way you would say it.",
        "Short sentences. Plain words. One idea per sentence.",
        "",
        "- No markdown tables, no bullet lists, no headings, no code blocks: none",
        "  of them survive being spoken.",
        "- Do not read code, diffs, or long file paths aloud. Say where the code",
        '  went instead, like "I put the new function in the chat".',
        "- Keep numbers and identifiers short enough to follow by ear, and round",
        "  where precision does not matter.",
        "- Two or three sentences is a full answer. Offer the detail rather than",
        "  reciting it, and stop talking when the answer is done.",
      ].join("\n")
    );
  }

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
