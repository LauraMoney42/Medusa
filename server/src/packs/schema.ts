/**
 * Medusa pack schema (addendum workstream S13, "Pack format").
 *
 * A pack is everything that makes an install "yours": the persona, the user
 * rules, the theme tokens, the voice settings and the toolbox allowlist. It
 * travels as ONE JSON file with the extension `.medusa-pack` so a person can
 * hand it to someone else the way editor themes are traded, with the avatar
 * embedded as a data URL rather than as a sidecar image.
 *
 * Everything here is engine independent on purpose: a pack changes the Medusa
 * layer (`~/.medusa/`), which `sessions/orchestrator-prompt.ts` composes into
 * the one system prompt every engine receives.
 */

import { z } from "zod";

/** `#abc` or `#aabbcc`. Kept strict so a bad token cannot reach the CSS. */
export const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex color such as #1a7a3c");

/**
 * An inline image. Only raster web formats are accepted, and the payload must
 * be base64: a pack is imported from an untrusted file, so an `image/svg+xml`
 * data URL (which can carry script) is deliberately not allowed.
 */
export const DataUrlImageSchema = z
  .string()
  .regex(
    /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/,
    "must be a base64 data URL for a png, jpeg, gif or webp image"
  )
  .max(2_000_000, "avatar must be under 2MB as a data URL");

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

export const ManifestSchema = z.object({
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(32).default("1.0.0"),
  author: z.string().max(120).default(""),
  description: z.string().max(600).default(""),
  license: z.string().max(80).default("MIT"),
});
export type PackManifest = z.infer<typeof ManifestSchema>;

/**
 * The persona. `personality` is the prose that becomes the top of the system
 * prompt; `name` and `greeting` are presentation, stored as front matter in
 * `~/.medusa/MEDUSA.md` and stripped before the prompt is composed.
 */
export const PersonaSchema = z.object({
  name: z.string().min(1).max(60).default("Medusa"),
  greeting: z.string().max(600).default(""),
  personality: z.string().max(40_000).default(""),
  /** Optional avatar, persisted alongside the theme tokens. */
  avatar: DataUrlImageSchema.nullable().default(null),
});
export type Persona = z.infer<typeof PersonaSchema>;

/** One `~/.medusa/rules/*.md` file plus its on/off state from rules.json. */
export const RuleSchema = z.object({
  /** Bare file name, e.g. `adhd-mode.md`. No path separators. */
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9._-]+\.md$/, "rule file names must be plain and end in .md")
    .refine((n) => !n.startsWith("."), "rule file names may not start with a dot"),
  content: z.string().max(40_000),
  enabled: z.boolean().default(true),
});
export type Rule = z.infer<typeof RuleSchema>;

/**
 * Theme tokens. The six colors are the ones the addendum names; they are bound
 * to the CSS variables in client/src/styles/global.css by the client's theme
 * injector, so adding a token here means adding a binding there.
 */
export const ThemeSchema = z.object({
  mode: z.enum(["dark", "light"]).default("dark"),
  background: HexColorSchema.default("#1c1c1e"),
  surface: HexColorSchema.default("#2c2c2e"),
  accent: HexColorSchema.default("#1a7a3c"),
  text: HexColorSchema.default("#e5e5ea"),
  muted: HexColorSchema.default("#8e8e93"),
  danger: HexColorSchema.default("#c0392b"),
  font: z.string().max(200).default(""),
  density: z.enum(["compact", "comfortable"]).default("comfortable"),
  avatar: DataUrlImageSchema.nullable().default(null),
});
export type Theme = z.infer<typeof ThemeSchema>;

/**
 * Voice-out defaults. `engine` is free-form so a cloud provider can be named.
 *
 * The last four fields are the S14 speech-to-speech loop gains (spec
 * section 4): account-wide defaults for the voice loop itself, as opposed to
 * `voiceModel` on `SessionMeta`, which is per-chat and travels through
 * PATCH /api/sessions instead. They were previously typed on the client only
 * (client/src/api.ts `MedusaVoice`) with nowhere on the server to land: a zod
 * object schema drops unknown keys by default, so a PUT that set them was
 * silently discarding them before they ever reached voice.json, and a
 * reload always came back with the settings-page defaults. Declared here so
 * they persist, and read by `voice:start` (see VoiceBar.tsx) so a saved
 * value actually reaches the running `VoiceSession`'s VAD options.
 */
export const VoiceSchema = z.object({
  engine: z.string().min(1).max(40).default("kokoro"),
  voiceId: z.string().min(1).max(80).default("af_heart"),
  speed: z.number().min(0.5).max(2).default(1),
  pitch: z.number().min(0.5).max(2).default(1),
  enabled: z.boolean().default(false),
  voiceMode: z.enum(["off", "push-to-talk", "always-on"]).default("off"),
  vadSensitivity: z.number().min(0).max(1).default(0.5),
  silenceTimeoutMs: z.number().min(200).max(2000).default(600),
  interruptBehavior: z.enum(["abort", "queue"]).default("abort"),

  // S16 "live" gains. Warm engines, partials and the speculative start are on
  // by default because they only ever make a spoken turn start sooner and each
  // one falls back to the S14 behavior when its backend is unavailable. Live
  // mode is off by default: it hands the conversation to a third-party
  // realtime model and needs a key.
  warmEngine: z.boolean().default(true),
  partials: z.enum(["off", "local", "deepgram"]).default("local"),
  speculativeStart: z.boolean().default(true),
  firstClauseAudio: z.boolean().default(true),
  liveMode: z.boolean().default(false),
  liveProvider: z.string().max(60).default("gemini-live"),

  /**
   * S17: voice always works, and Medusa picks the best tier she can reach.
   * `auto` takes Live when a realtime key exists and the local pipeline
   * otherwise; `pipeline` pins the local loop; `live` says "prefer Live", and
   * still falls back to the pipeline rather than leaving voice broken, because
   * a missing key must never mean a dead mic. `liveMode` above is the old
   * on/off flag and is kept only so an existing voice.json still loads.
   */
  liveTier: z.enum(["auto", "pipeline", "live"]).default("auto"),
  /** Realtime model id. Empty means the provider's own default. */
  liveModel: z.string().max(120).default(""),
  /** Realtime speaker name (provider-specific, e.g. Gemini "Aoede"). Empty means the provider default. Kept separate from voiceId, which names a local Kokoro voice. */
  liveVoice: z.string().max(60).default(""),
});
export type Voice = z.infer<typeof VoiceSchema>;

/**
 * Permission scope for one toolbox entry, widest last. `read` may look but not
 * change anything, `write` may edit files, `shell` may also run commands.
 */
export const ToolScopeSchema = z.enum(["read", "write", "shell"]);
export type ToolScope = z.infer<typeof ToolScopeSchema>;

export const ToolboxEntrySchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().max(120).default(""),
  detail: z.string().max(400).default(""),
  enabled: z.boolean().default(true),
  scope: ToolScopeSchema.default("read"),
});
export type ToolboxEntry = z.infer<typeof ToolboxEntrySchema>;

/**
 * The curated allowlist that is on by default for every new chat. Nothing is
 * installed automatically: the registry search only proposes candidates, and
 * an entry reaches this list when the person clicks Add.
 */
export const ToolboxSchema = z.object({
  servers: z.array(ToolboxEntrySchema).max(200).default([]),
  skills: z.array(ToolboxEntrySchema).max(200).default([]),
});
export type Toolbox = z.infer<typeof ToolboxSchema>;

// ---------------------------------------------------------------------------
// The pack itself
// ---------------------------------------------------------------------------

export const PACK_FORMAT_VERSION = 1;

export const PackSchema = z.object({
  formatVersion: z.literal(PACK_FORMAT_VERSION),
  manifest: ManifestSchema,
  persona: PersonaSchema,
  rules: z.array(RuleSchema).max(100).default([]),
  theme: ThemeSchema,
  voice: VoiceSchema,
  toolbox: ToolboxSchema,
});
export type Pack = z.infer<typeof PackSchema>;

/** Parse an untrusted pack file. Returns a flat error list, never throws. */
export function parsePack(input: unknown): { ok: true; pack: Pack } | { ok: false; errors: string[] } {
  const result = PackSchema.safeParse(input);
  if (result.success) return { ok: true, pack: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (i) => `${i.path.length ? i.path.join(".") : "pack"}: ${i.message}`
    ),
  };
}

/** Safe file-name stem for a pack, derived from its manifest name. */
export function packSlug(manifest: PackManifest): string {
  const base = manifest.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "pack";
}
