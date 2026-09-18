/**
 * The `~/.medusa/` layer on disk, and pack export/import.
 *
 * Layout:
 *   ~/.medusa/MEDUSA.md      persona: front matter (name, greeting) + prose
 *   ~/.medusa/rules/*.md     user rules, one file each
 *   ~/.medusa/rules.json     which rule files are enabled
 *   ~/.medusa/theme.json     color tokens, density, avatar
 *   ~/.medusa/voice.json     TTS engine, voice, speed, pitch, default on/off
 *   ~/.medusa/toolbox.json   MCP servers and skills with permission scopes
 *   ~/.medusa/packs/         imported *.medusa-pack files
 *   ~/.medusa/backups/       one snapshot per import, newest last
 *
 * Every read is fail-safe: a missing or corrupt file yields the default rather
 * than an error, because none of this may ever block a chat from starting.
 * HOME is read on each call (never cached) so a test can point the whole layer
 * at a temp directory.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  PACK_FORMAT_VERSION,
  ManifestSchema,
  PersonaSchema,
  ThemeSchema,
  ToolboxSchema,
  VoiceSchema,
  packSlug,
  parsePack,
  type Pack,
  type PackManifest,
  type Persona,
  type Rule,
  type Theme,
  type Toolbox,
  type Voice,
} from "./schema.js";

export const PACK_EXTENSION = ".medusa-pack";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Last-resort persona, used only when medusa-persona.md cannot be found on
 * disk (for instance a `dist/` deploy without the source tree beside it).
 */
export const FALLBACK_PERSONA =
  "You are Medusa, a hands-on coding assistant working with one person in one " +
  "project folder per chat. Write code, fix bugs, ship features, review diffs. " +
  "Use your Read, Edit, and shell tools to make real changes rather than " +
  "describing them. You are not a project manager and you do not produce " +
  "status dashboards.";

/**
 * Candidate locations for the bundled persona. `tsc` does not copy .md files
 * into dist/, so a compiled build falls back to the source tree next to it.
 */
const BUNDLED_PERSONA_PATHS = [
  path.join(HERE, "..", "sessions", "medusa-persona.md"),
  path.join(HERE, "..", "..", "src", "sessions", "medusa-persona.md"),
];

let bundledPersonaCache: string | null = null;

/** The shipped persona prose. Cached: it cannot change at runtime. */
export function loadBundledPersona(): string {
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

export function medusaDir(): string {
  return path.join(process.env.HOME || os.homedir(), ".medusa");
}

function rulesDir(): string {
  return path.join(medusaDir(), "rules");
}

function packsDir(): string {
  return path.join(medusaDir(), "packs");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

/**
 * Split `---` front matter off a persona file. The prompt only ever sees the
 * body, so name and greeting never leak into the composed system prompt.
 * Values are JSON-encoded on write, so a greeting may contain any character.
 */
export function splitFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const rawValue = line.slice(sep + 1).trim();
    let value = rawValue;
    if (rawValue.startsWith('"')) {
      try {
        value = JSON.parse(rawValue) as string;
      } catch {
        value = rawValue;
      }
    }
    meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

/** Persona prose only, with front matter removed. Used by the prompt builder. */
export function loadPersonaBody(): string {
  try {
    const raw = fs.readFileSync(path.join(medusaDir(), "MEDUSA.md"), "utf-8");
    const { body } = splitFrontMatter(raw);
    if (body.trim()) return body.trim();
  } catch {
    // no user persona: fall through to the bundled one
  }
  return loadBundledPersona();
}

/** The full persona record the Persona editor works with. */
export function readPersona(): Persona {
  let meta: Record<string, string> = {};
  let body = "";
  try {
    const raw = fs.readFileSync(path.join(medusaDir(), "MEDUSA.md"), "utf-8");
    const split = splitFrontMatter(raw);
    meta = split.meta;
    body = split.body;
  } catch {
    // not customized yet
  }
  return PersonaSchema.parse({
    name: meta.name || "Medusa",
    greeting: meta.greeting ?? "",
    personality: body.trim() || loadBundledPersona(),
    // The avatar lives with the theme tokens (the addendum puts the optional
    // avatar image in theme.json), but the Persona editor owns it in the UI.
    avatar: readTheme().avatar,
  });
}

export function writePersona(persona: Persona): Persona {
  const parsed = PersonaSchema.parse(persona);
  const front = [
    "---",
    `name: ${JSON.stringify(parsed.name)}`,
    `greeting: ${JSON.stringify(parsed.greeting)}`,
    "---",
    "",
  ].join("\n");
  ensureDir(medusaDir());
  fs.writeFileSync(
    path.join(medusaDir(), "MEDUSA.md"),
    `${front}${parsed.personality.trim()}\n`,
    "utf-8"
  );
  // Keep the avatar with the theme so one file holds every visual token.
  const theme = readTheme();
  if (theme.avatar !== parsed.avatar) writeTheme({ ...theme, avatar: parsed.avatar });
  return parsed;
}

/** Drop the user's persona so the bundled Medusa default takes over again. */
export function resetPersona(): Persona {
  try {
    fs.rmSync(path.join(medusaDir(), "MEDUSA.md"), { force: true });
  } catch {
    // nothing to remove
  }
  const theme = readTheme();
  if (theme.avatar) writeTheme({ ...theme, avatar: null });
  return readPersona();
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** `~/.medusa/rules.json`: `{ "adhd-mode.md": false }`. Absent means enabled. */
export function readRulesEnabled(): Record<string, boolean> {
  const raw = readJson(path.join(medusaDir(), "rules.json"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

function writeRulesEnabled(state: Record<string, boolean>): void {
  writeJson(path.join(medusaDir(), "rules.json"), state);
}

/** Reject anything that could escape ~/.medusa/rules. */
function safeRuleName(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) return null;
  if (name.startsWith(".")) return null;
  return name;
}

export interface RuleRecord extends Rule {}

/** Every rule file with its content and on/off state, alphabetical. */
export function listRules(): RuleRecord[] {
  const dir = rulesDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const enabledState = readRulesEnabled();
  const out: RuleRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    try {
      out.push({
        name,
        content: fs.readFileSync(path.join(dir, name), "utf-8"),
        enabled: enabledState[name] ?? true,
      });
    } catch {
      // unreadable rule file: skip it rather than failing the request
    }
  }
  return out;
}

/**
 * The enabled rule bodies, alphabetical, for the prompt builder. A rule with
 * no entry in rules.json is on: that is how rules behaved before the toggle
 * existed, and an import should not silently mute anything.
 */
export function loadEnabledRuleTexts(): string[] {
  return listRules()
    .filter((r) => r.enabled)
    .map((r) => r.content.trim())
    .filter(Boolean);
}

export function writeRule(name: string, content: string, enabled = true): RuleRecord | null {
  const safe = safeRuleName(name);
  if (!safe) return null;
  ensureDir(rulesDir());
  fs.writeFileSync(path.join(rulesDir(), safe), content, "utf-8");
  const state = readRulesEnabled();
  state[safe] = enabled;
  writeRulesEnabled(state);
  return { name: safe, content, enabled };
}

export function setRuleEnabled(name: string, enabled: boolean): RuleRecord | null {
  const safe = safeRuleName(name);
  if (!safe) return null;
  let content: string;
  try {
    content = fs.readFileSync(path.join(rulesDir(), safe), "utf-8");
  } catch {
    return null;
  }
  const state = readRulesEnabled();
  state[safe] = enabled;
  writeRulesEnabled(state);
  return { name: safe, content, enabled };
}

export function deleteRule(name: string): boolean {
  const safe = safeRuleName(name);
  if (!safe) return false;
  try {
    fs.rmSync(path.join(rulesDir(), safe), { force: true });
  } catch {
    return false;
  }
  const state = readRulesEnabled();
  delete state[safe];
  writeRulesEnabled(state);
  return true;
}

// ---------------------------------------------------------------------------
// Theme, voice, toolbox
// ---------------------------------------------------------------------------

export function readTheme(): Theme {
  const parsed = ThemeSchema.safeParse(readJson(path.join(medusaDir(), "theme.json")) ?? {});
  return parsed.success ? parsed.data : ThemeSchema.parse({});
}

export function writeTheme(theme: Theme): Theme {
  const parsed = ThemeSchema.parse(theme);
  writeJson(path.join(medusaDir(), "theme.json"), parsed);
  return parsed;
}

export function readVoice(): Voice {
  const parsed = VoiceSchema.safeParse(readJson(path.join(medusaDir(), "voice.json")) ?? {});
  return parsed.success ? parsed.data : VoiceSchema.parse({});
}

export function writeVoice(voice: Voice): Voice {
  const parsed = VoiceSchema.parse(voice);
  writeJson(path.join(medusaDir(), "voice.json"), parsed);
  return parsed;
}

export function readToolbox(): Toolbox {
  const parsed = ToolboxSchema.safeParse(readJson(path.join(medusaDir(), "toolbox.json")) ?? {});
  return parsed.success ? parsed.data : ToolboxSchema.parse({});
}

export function writeToolbox(toolbox: Toolbox): Toolbox {
  const parsed = ToolboxSchema.parse(toolbox);
  writeJson(path.join(medusaDir(), "toolbox.json"), parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/** Snapshot the current `~/.medusa/` as a pack. */
export function exportPack(manifest: Partial<PackManifest> = {}): Pack {
  const persona = readPersona();
  const full = ManifestSchema.parse({
    name: manifest.name || `${persona.name} setup`,
    version: manifest.version || "1.0.0",
    author: manifest.author ?? "",
    description: manifest.description ?? "",
    license: manifest.license ?? "MIT",
  });
  return {
    formatVersion: PACK_FORMAT_VERSION,
    manifest: full,
    persona,
    rules: listRules(),
    theme: readTheme(),
    voice: readVoice(),
    toolbox: readToolbox(),
  };
}

/** Copy the current persona, rules and json files aside before overwriting. */
export function backupCurrentSet(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(medusaDir(), "backups", stamp);
  ensureDir(dest);
  writeJson(path.join(dest, "pack.json"), exportPack({ name: `backup ${stamp}` }));
  return dest;
}

/**
 * Write a validated pack over `~/.medusa/`, after backing up what was there.
 * Rules are replaced wholesale rather than merged, so importing a pack gives
 * exactly the set its author shipped.
 */
export function applyPack(pack: Pack): { backup: string } {
  const backup = backupCurrentSet();

  writePersona(pack.persona);
  writeTheme({ ...pack.theme, avatar: pack.persona.avatar ?? pack.theme.avatar });
  writeVoice(pack.voice);
  writeToolbox(pack.toolbox);

  // Replace the rules directory with the pack's set.
  try {
    fs.rmSync(rulesDir(), { recursive: true, force: true });
  } catch {
    // nothing to clear
  }
  ensureDir(rulesDir());
  const state: Record<string, boolean> = {};
  for (const rule of pack.rules) {
    const safe = safeRuleName(rule.name);
    if (!safe) continue;
    fs.writeFileSync(path.join(rulesDir(), safe), rule.content, "utf-8");
    state[safe] = rule.enabled;
  }
  writeRulesEnabled(state);

  return { backup };
}

/** Validate, store under packs/, then apply. */
export function importPack(
  input: unknown
): { ok: true; pack: Pack; file: string; backup: string } | { ok: false; errors: string[] } {
  const parsed = parsePack(input);
  if (!parsed.ok) return parsed;

  ensureDir(packsDir());
  const file = path.join(packsDir(), `${packSlug(parsed.pack.manifest)}${PACK_EXTENSION}`);
  writeJson(file, parsed.pack);

  const { backup } = applyPack(parsed.pack);
  return { ok: true, pack: parsed.pack, file, backup };
}

export interface InstalledPack {
  id: string;
  manifest: PackManifest;
  ruleCount: number;
}

/** Packs sitting in ~/.medusa/packs. Invalid files are skipped, not surfaced. */
export function listInstalledPacks(): InstalledPack[] {
  let names: string[];
  try {
    names = fs.readdirSync(packsDir());
  } catch {
    return [];
  }
  const out: InstalledPack[] = [];
  for (const name of names.filter((n) => n.endsWith(PACK_EXTENSION)).sort()) {
    const parsed = parsePack(readJson(path.join(packsDir(), name)));
    if (!parsed.ok) continue;
    out.push({
      id: name.slice(0, -PACK_EXTENSION.length),
      manifest: parsed.pack.manifest,
      ruleCount: parsed.pack.rules.length,
    });
  }
  return out;
}

export function readInstalledPack(id: string): Pack | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith(".")) return null;
  const parsed = parsePack(readJson(path.join(packsDir(), `${id}${PACK_EXTENSION}`)));
  return parsed.ok ? parsed.pack : null;
}

export function removeInstalledPack(id: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith(".")) return false;
  const file = path.join(packsDir(), `${id}${PACK_EXTENSION}`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}
