import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildOrchestratorPrompt, loadRuleFiles, toolName } from "../orchestrator-prompt.js";

const WORKING_DIR = "/Users/tester/Projects/demo";

/** Markers from the removed multi-bot protocol. None may survive anywhere. */
const BOT_MARKERS = ["[HUB-POST", "[TASK-DONE", "[BOT-TASK"];

function build(overrides: Partial<Parameters<typeof buildOrchestratorPrompt>[0]> = {}) {
  return buildOrchestratorPrompt({
    engineId: "claude",
    workingDir: WORKING_DIR,
    // Default to an explicit empty rule set so tests never read the real ~/.medusa.
    rules: [],
    ...overrides,
  });
}

describe("buildOrchestratorPrompt: tool naming", () => {
  it("namespaces every subagent tool for the claude engine", () => {
    const prompt = build({ engineId: "claude" });
    for (const tool of ["spawn_agent", "agent_status", "agent_result", "list_agents", "cancel_agent"]) {
      expect(prompt).toContain(`mcp__medusa__${tool}`);
    }
  });

  it.each(["kimi", "code-puppy", undefined])("uses bare tool names for %s", (engineId) => {
    const prompt = build({ engineId: engineId as string | undefined });
    expect(prompt).toContain("`spawn_agent`");
    expect(prompt).not.toContain("mcp__medusa__");
    for (const tool of ["agent_status", "agent_result", "list_agents", "cancel_agent"]) {
      expect(prompt).toContain(`\`${tool}\``);
    }
  });

  it("toolName maps per engine", () => {
    expect(toolName("claude", "spawn_agent")).toBe("mcp__medusa__spawn_agent");
    expect(toolName("kimi", "spawn_agent")).toBe("spawn_agent");
    expect(toolName(undefined, "cancel_agent")).toBe("cancel_agent");
  });

  it("differs between engines only in tool naming", () => {
    const claude = build({ engineId: "claude" }).replace(/mcp__medusa__/g, "");
    const kimi = build({ engineId: "kimi" });
    expect(claude).toBe(kimi);
  });
});

describe("buildOrchestratorPrompt: session prompt", () => {
  it("appends the session prompt rather than substituting it", () => {
    const notes = "Prefer TypeScript and small commits.";
    const prompt = build({ sessionSystemPrompt: notes });
    expect(prompt).toContain("## Project notes");
    expect(prompt).toContain(notes);
    // The orchestrator body is still there, and comes first.
    expect(prompt).toContain("You are Medusa");
    expect(prompt).toContain("## Working with subagents");
    expect(prompt.indexOf("## Working with subagents")).toBeLessThan(prompt.indexOf(notes));
  });

  it("omits the Project notes heading when there is no session prompt", () => {
    expect(build()).not.toContain("## Project notes");
    expect(build({ sessionSystemPrompt: "   " })).not.toContain("## Project notes");
  });
});

describe("buildOrchestratorPrompt: content constraints", () => {
  const prompt = build({ sessionSystemPrompt: "note", personaText: "You are Medusa." });

  it("carries no bot-era markers", () => {
    for (const marker of BOT_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
    expect(prompt.toLowerCase()).not.toContain("hub");
  });

  it("uses no em-dash or en-dash", () => {
    // Built from char codes so neither character appears literally in the repo.
    expect(prompt).not.toContain(String.fromCharCode(0x2014));
    expect(prompt).not.toContain(String.fromCharCode(0x2013));
  });

  it("names the working folder and keeps work inside it", () => {
    expect(prompt).toContain(WORKING_DIR);
    expect(prompt).toContain("## Working folder");
  });

  it("states the reply style", () => {
    expect(prompt).toContain("## Style");
    expect(prompt).toMatch(/concise/i);
  });

  it("says when not to spawn", () => {
    expect(prompt).toMatch(/never spawn for trivial work/i);
  });
});

describe("buildOrchestratorPrompt: the ~/.medusa layer", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("uses the bundled persona when ~/.medusa/MEDUSA.md is absent", () => {
    const prompt = buildOrchestratorPrompt({ engineId: "claude", workingDir: WORKING_DIR });
    expect(prompt).toContain("You are Medusa");
  });

  it("overrides the persona from ~/.medusa/MEDUSA.md", () => {
    fs.mkdirSync(path.join(home, ".medusa"), { recursive: true });
    fs.writeFileSync(path.join(home, ".medusa", "MEDUSA.md"), "You are Hydra, a terse pair programmer.");
    const prompt = buildOrchestratorPrompt({ engineId: "claude", workingDir: WORKING_DIR });
    expect(prompt.startsWith("You are Hydra, a terse pair programmer.")).toBe(true);
    expect(prompt).not.toContain("You are Medusa, a hands-on coding assistant");
    // The rest of the layer survives a persona override.
    expect(prompt).toContain("## Working with subagents");
  });

  it("appends every ~/.medusa/rules/*.md in alphabetical order", () => {
    const rulesDir = path.join(home, ".medusa", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "zebra.md"), "RULE-Z");
    fs.writeFileSync(path.join(rulesDir, "adhd-mode.md"), "RULE-A");
    fs.writeFileSync(path.join(rulesDir, "notes.txt"), "RULE-IGNORED");

    expect(loadRuleFiles()).toEqual(["RULE-A", "RULE-Z"]);

    const prompt = buildOrchestratorPrompt({ engineId: "kimi", workingDir: WORKING_DIR });
    expect(prompt).toContain("## Rules");
    expect(prompt.indexOf("RULE-A")).toBeGreaterThan(-1);
    expect(prompt.indexOf("RULE-A")).toBeLessThan(prompt.indexOf("RULE-Z"));
    expect(prompt).not.toContain("RULE-IGNORED");
  });

  it("puts rules above the session's own project notes", () => {
    const rulesDir = path.join(home, ".medusa", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "a.md"), "RULE-A");
    const prompt = buildOrchestratorPrompt({
      engineId: "kimi",
      workingDir: WORKING_DIR,
      sessionSystemPrompt: "SESSION-NOTE",
    });
    expect(prompt.indexOf("RULE-A")).toBeLessThan(prompt.indexOf("SESSION-NOTE"));
  });

  it("omits the Rules heading when there are none", () => {
    expect(buildOrchestratorPrompt({ workingDir: WORKING_DIR })).not.toContain("## Rules");
  });

  it("appends only the rules enabled in ~/.medusa/rules.json", () => {
    const rulesDir = path.join(home, ".medusa", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "on.md"), "RULE-ON");
    fs.writeFileSync(path.join(rulesDir, "off.md"), "RULE-OFF");
    fs.writeFileSync(
      path.join(home, ".medusa", "rules.json"),
      JSON.stringify({ "on.md": true, "off.md": false })
    );

    expect(loadRuleFiles()).toEqual(["RULE-ON"]);
    const prompt = buildOrchestratorPrompt({ engineId: "kimi", workingDir: WORKING_DIR });
    expect(prompt).toContain("RULE-ON");
    expect(prompt).not.toContain("RULE-OFF");
  });

  it("treats a rule missing from rules.json as enabled", () => {
    const rulesDir = path.join(home, ".medusa", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "listed.md"), "RULE-LISTED");
    fs.writeFileSync(path.join(rulesDir, "unlisted.md"), "RULE-UNLISTED");
    fs.writeFileSync(path.join(home, ".medusa", "rules.json"), JSON.stringify({ "listed.md": true }));

    expect(loadRuleFiles()).toEqual(["RULE-LISTED", "RULE-UNLISTED"]);
  });

  it("omits the Rules heading when every rule is disabled", () => {
    const rulesDir = path.join(home, ".medusa", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "off.md"), "RULE-OFF");
    fs.writeFileSync(path.join(home, ".medusa", "rules.json"), JSON.stringify({ "off.md": false }));
    expect(buildOrchestratorPrompt({ workingDir: WORKING_DIR })).not.toContain("## Rules");
  });

  it("applies the same enabled rule set to every engine", () => {
    const rulesDir = path.join(home, ".medusa", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "on.md"), "RULE-ON");
    fs.writeFileSync(path.join(rulesDir, "off.md"), "RULE-OFF");
    fs.writeFileSync(
      path.join(home, ".medusa", "rules.json"),
      JSON.stringify({ "on.md": true, "off.md": false })
    );
    const claude = buildOrchestratorPrompt({ engineId: "claude", workingDir: WORKING_DIR }).replace(
      /mcp__medusa__/g,
      ""
    );
    const kimi = buildOrchestratorPrompt({ engineId: "kimi", workingDir: WORKING_DIR });
    expect(claude).toBe(kimi);
    expect(kimi).toContain("RULE-ON");
  });

  it("strips persona front matter so the name and greeting never reach the prompt", () => {
    fs.mkdirSync(path.join(home, ".medusa"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".medusa", "MEDUSA.md"),
      ['---', 'name: "Hydra"', 'greeting: "SECRET-GREETING"', '---', '', 'You are Hydra.'].join("\n")
    );
    const prompt = buildOrchestratorPrompt({ engineId: "kimi", workingDir: WORKING_DIR });
    expect(prompt.startsWith("You are Hydra.")).toBe(true);
    expect(prompt).not.toContain("SECRET-GREETING");
    expect(prompt).not.toContain("---");
  });

  it("lets an explicit rules array override the directory", () => {
    const rulesDir = path.join(home, ".medusa", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "a.md"), "RULE-A");
    const prompt = buildOrchestratorPrompt({ workingDir: WORKING_DIR, rules: ["ONLY-THIS"] });
    expect(prompt).toContain("ONLY-THIS");
    expect(prompt).not.toContain("RULE-A");
  });
});
