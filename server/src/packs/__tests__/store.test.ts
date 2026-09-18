import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyPack,
  deleteRule,
  exportPack,
  importPack,
  listInstalledPacks,
  listRules,
  loadEnabledRuleTexts,
  medusaDir,
  readPersona,
  readTheme,
  readVoice,
  removeInstalledPack,
  resetPersona,
  setRuleEnabled,
  splitFrontMatter,
  writePersona,
  writeRule,
  writeTheme,
  writeToolbox,
  writeVoice,
} from "../store.js";
import { PACK_FORMAT_VERSION } from "../schema.js";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-packs-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("persona front matter", () => {
  it("splits name and greeting off the prose", () => {
    const { meta, body } = splitFrontMatter(
      ['---', 'name: "Hydra"', 'greeting: "Hi there"', '---', '', 'You are Hydra.'].join("\n")
    );
    expect(meta.name).toBe("Hydra");
    expect(meta.greeting).toBe("Hi there");
    expect(body).toBe("You are Hydra.");
  });

  it("treats a file with no front matter as all prose", () => {
    const { meta, body } = splitFrontMatter("You are Medusa.");
    expect(meta).toEqual({});
    expect(body).toBe("You are Medusa.");
  });

  it("round-trips a greeting containing a colon and a newline", () => {
    writePersona({
      name: "Hydra",
      greeting: "Line one: still here\nLine two",
      personality: "You are Hydra.",
      avatar: null,
    });
    const back = readPersona();
    expect(back.greeting).toBe("Line one: still here\nLine two");
    expect(back.personality).toBe("You are Hydra.");
  });

  it("falls back to the bundled persona before anything is written", () => {
    expect(readPersona().personality).toContain("You are Medusa");
    expect(readPersona().name).toBe("Medusa");
  });

  it("resets back to the bundled persona", () => {
    writePersona({ name: "Hydra", greeting: "", personality: "You are Hydra.", avatar: null });
    expect(readPersona().personality).toBe("You are Hydra.");
    const reset = resetPersona();
    expect(reset.personality).toContain("You are Medusa");
    expect(fs.existsSync(path.join(medusaDir(), "MEDUSA.md"))).toBe(false);
  });

  it("keeps the avatar with the theme tokens", () => {
    const avatar = "data:image/png;base64,iVBORw0KGgo=";
    writePersona({ name: "M", greeting: "", personality: "p", avatar });
    expect(readTheme().avatar).toBe(avatar);
    expect(readPersona().avatar).toBe(avatar);
  });
});

describe("rules", () => {
  it("creates, lists and toggles a rule", () => {
    expect(writeRule("adhd-mode.md", "Short replies.")).not.toBeNull();
    expect(writeRule("terse.md", "No preamble.")).not.toBeNull();

    expect(listRules().map((r) => r.name)).toEqual(["adhd-mode.md", "terse.md"]);
    expect(loadEnabledRuleTexts()).toEqual(["Short replies.", "No preamble."]);

    setRuleEnabled("terse.md", false);
    expect(loadEnabledRuleTexts()).toEqual(["Short replies."]);
    expect(listRules().find((r) => r.name === "terse.md")?.enabled).toBe(false);

    setRuleEnabled("terse.md", true);
    expect(loadEnabledRuleTexts()).toHaveLength(2);
  });

  it("treats a rule with no rules.json entry as enabled", () => {
    fs.mkdirSync(path.join(medusaDir(), "rules"), { recursive: true });
    fs.writeFileSync(path.join(medusaDir(), "rules", "legacy.md"), "LEGACY");
    expect(loadEnabledRuleTexts()).toEqual(["LEGACY"]);
  });

  it("refuses a rule name that could escape the rules directory", () => {
    expect(writeRule("../escape.md", "x")).toBeNull();
    expect(writeRule("nested/rule.md", "x")).toBeNull();
    expect(writeRule(".hidden.md", "x")).toBeNull();
    expect(setRuleEnabled("../escape.md", false)).toBeNull();
    expect(deleteRule("../escape.md")).toBe(false);
  });

  it("deletes a rule and its enabled entry", () => {
    writeRule("gone.md", "x");
    expect(deleteRule("gone.md")).toBe(true);
    expect(listRules()).toEqual([]);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(listRules()).toEqual([]);
    expect(loadEnabledRuleTexts()).toEqual([]);
  });
});

describe("export and import round trip", () => {
  function setUpASetup() {
    writePersona({
      name: "Hydra",
      greeting: "What are we shipping?",
      personality: "You are Hydra, a terse pair programmer.",
      avatar: "data:image/png;base64,iVBORw0KGgo=",
    });
    writeRule("adhd-mode.md", "Short, action-first replies.", true);
    writeRule("tests-first.md", "Write the failing test first.", false);
    writeTheme({
      mode: "light",
      background: "#ffffff",
      surface: "#f2f2f7",
      accent: "#1a7a3c",
      text: "#1c1c1e",
      muted: "#8e8e93",
      danger: "#c0392b",
      font: "",
      density: "compact",
      avatar: "data:image/png;base64,iVBORw0KGgo=",
    });
    writeVoice({ engine: "kokoro", voiceId: "bm_george", speed: 1.25, pitch: 0.9, enabled: true });
    writeToolbox({
      servers: [{ id: "git", label: "Git", detail: "", enabled: true, scope: "read" }],
      skills: [{ id: "code-review", label: "Code review", detail: "", enabled: false, scope: "read" }],
    });
  }

  it("exports everything currently on disk", () => {
    setUpASetup();
    const pack = exportPack({ name: "Hydra setup", author: "kind" });

    expect(pack.formatVersion).toBe(PACK_FORMAT_VERSION);
    expect(pack.manifest.name).toBe("Hydra setup");
    expect(pack.manifest.author).toBe("kind");
    expect(pack.persona.name).toBe("Hydra");
    expect(pack.persona.greeting).toBe("What are we shipping?");
    expect(pack.rules.map((r) => [r.name, r.enabled])).toEqual([
      ["adhd-mode.md", true],
      ["tests-first.md", false],
    ]);
    expect(pack.theme.mode).toBe("light");
    expect(pack.voice.voiceId).toBe("bm_george");
    expect(pack.toolbox.servers[0].id).toBe("git");
  });

  it("round-trips through import into a clean home", () => {
    setUpASetup();
    const exported = exportPack({ name: "Hydra setup" });

    // Wipe the layer, then import the file we produced.
    fs.rmSync(medusaDir(), { recursive: true, force: true });
    expect(listRules()).toEqual([]);

    const result = importPack(JSON.parse(JSON.stringify(exported)) as unknown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reExported = exportPack({ name: "Hydra setup" });
    expect(reExported.persona).toEqual(exported.persona);
    expect(reExported.rules).toEqual(exported.rules);
    expect(reExported.theme).toEqual(exported.theme);
    expect(reExported.voice).toEqual(exported.voice);
    expect(reExported.toolbox).toEqual(exported.toolbox);
    expect(loadEnabledRuleTexts()).toEqual(["Short, action-first replies."]);
  });

  it("backs up the previous set before overwriting it", () => {
    setUpASetup();
    const before = exportPack({ name: "before" });

    const result = importPack({
      formatVersion: PACK_FORMAT_VERSION,
      manifest: { name: "Plain" },
      persona: { name: "Plain", greeting: "", personality: "You are Plain.", avatar: null },
      rules: [],
      theme: {},
      voice: {},
      toolbox: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(readPersona().personality).toBe("You are Plain.");
    expect(listRules()).toEqual([]);

    const backup = JSON.parse(fs.readFileSync(path.join(result.backup, "pack.json"), "utf-8")) as typeof before;
    expect(backup.persona.personality).toBe("You are Hydra, a terse pair programmer.");
    expect(backup.rules).toHaveLength(2);
  });

  it("replaces the rule set rather than merging it", () => {
    setUpASetup();
    applyPack({
      formatVersion: PACK_FORMAT_VERSION,
      manifest: { name: "One rule", version: "1.0.0", author: "", description: "", license: "MIT" },
      persona: { name: "M", greeting: "", personality: "p", avatar: null },
      rules: [{ name: "only.md", content: "ONLY", enabled: true }],
      theme: readTheme(),
      voice: readVoice(),
      toolbox: { servers: [], skills: [] },
    });
    expect(listRules().map((r) => r.name)).toEqual(["only.md"]);
  });

  it("rejects a bad pack without touching the current set", () => {
    setUpASetup();
    const result = importPack({ formatVersion: 1, manifest: {}, persona: {}, theme: { accent: "red" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(readPersona().name).toBe("Hydra");
    expect(listRules()).toHaveLength(2);
  });

  it("lists and removes installed packs", () => {
    setUpASetup();
    const exported = exportPack({ name: "Hydra setup" });
    importPack(JSON.parse(JSON.stringify(exported)) as unknown);

    const installed = listInstalledPacks();
    expect(installed.map((p) => p.id)).toEqual(["hydra-setup"]);
    expect(installed[0].manifest.name).toBe("Hydra setup");
    expect(installed[0].ruleCount).toBe(2);

    expect(removeInstalledPack("hydra-setup")).toBe(true);
    expect(listInstalledPacks()).toEqual([]);
    expect(removeInstalledPack("../escape")).toBe(false);
  });
});
