/**
 * Provider configuration and model listing.
 *
 * Adds support for running the `claude` CLI as a harness against any
 * Anthropic-compatible endpoint (OpenRouter, or any other custom base URL),
 * so a bot can use GPT-5.x, Gemini, DeepSeek, etc. while still going through
 * the `claude` CLI's tool loop, streaming, and session handling.
 *
 * Keys are NEVER hardcoded here. A provider's API key comes only from:
 *   1. the `apiKeys` map in the settings file (~/.claude-chat/settings.json), or
 *   2. the environment variable named by that provider's `apiKeyEnv`.
 * Nothing in this module (or anything agent-facing) writes a key back out.
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Marks a good candidate for ANTHROPIC_SMALL_FAST_MODEL (cheap/fast). */
  cheap?: boolean;
}

export interface ProviderConfig {
  id: string;
  displayName: string;
  /** Anthropic-compatible base URL. Absent for the native "claude" provider. */
  baseUrl?: string;
  /** Env var name holding the API key, e.g. "OPENROUTER_API_KEY". */
  apiKeyEnv?: string;
  /** Static fallback model list, used when live listing is unavailable. */
  models?: ModelInfo[];
  /**
   * True when this provider is spoken to via the Anthropic Messages API
   * shape (i.e. `claude` CLI can be pointed at it with ANTHROPIC_BASE_URL /
   * ANTHROPIC_AUTH_TOKEN). Native "claude" and "kimi" are not: they use
   * their own auth paths and are excluded from that env-construction logic.
   */
  anthropicCompatible?: boolean;
  /** Where a user gets a key, shown in Settings > Providers. */
  keyUrl?: string;
}

const SETTINGS_FILE = path.join(
  process.env.HOME || os.homedir(),
  ".claude-chat",
  "settings.json"
);

/** Static built-in provider registry. */
export const PROVIDERS: Record<string, ProviderConfig> = {
  claude: {
    id: "claude",
    displayName: "Anthropic (native)",
    models: [
      { id: "haiku", displayName: "Haiku", cheap: true },
      { id: "sonnet", displayName: "Sonnet" },
      { id: "opus", displayName: "Opus" },
      { id: "fable", displayName: "Fable" },
    ],
  },
  kimi: {
    id: "kimi",
    displayName: "Kimi",
    models: [{ id: "kimi-k2", displayName: "Kimi K2" }],
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    apiKeyEnv: "OPENROUTER_API_KEY",
    anthropicCompatible: true,
    keyUrl: "https://openrouter.ai/keys",
    // Fallback list used offline / when /v1/models can't be reached.
    models: [
      { id: "openai/gpt-5.1", displayName: "GPT-5.1" },
      { id: "openai/gpt-5.1-mini", displayName: "GPT-5.1 Mini", cheap: true },
      { id: "google/gemini-3-pro", displayName: "Gemini 3 Pro" },
      { id: "google/gemini-3-flash", displayName: "Gemini 3 Flash", cheap: true },
      { id: "deepseek/deepseek-v3.2", displayName: "DeepSeek V3.2" },
      { id: "anthropic/claude-sonnet-4.5", displayName: "Claude Sonnet 4.5 (via OpenRouter)" },
    ],
  },
};

interface RawProviderOverride {
  apiKey?: string;
  baseUrl?: string;
  displayName?: string;
  models?: ModelInfo[];
}

/** Read the raw settings JSON without going through settings/store.ts's zod schema
 * (which doesn't know about provider config), avoiding a circular import and letting
 * providers.ts own its own slice of the file. */
function loadRawSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getOverride(id: string): RawProviderOverride | undefined {
  const raw = loadRawSettings();
  const map = raw.providers as Record<string, RawProviderOverride> | undefined;
  return map?.[id];
}

/** Atomic write + 600 permissions, matching settings/store.ts's own save(). */
function saveRawSettings(raw: Record<string, unknown>): void {
  const dir = path.dirname(SETTINGS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf-8");
  fs.renameSync(tmp, SETTINGS_FILE);
  fs.chmodSync(SETTINGS_FILE, 0o600);
}

/**
 * Store an API key for any provider id (chat provider or external service)
 * under `providers.<id>.apiKey` in the settings file, preserving any other
 * override fields (baseUrl, displayName, models) already there for that id.
 * Read back on the very next call: nothing here caches the file in memory.
 */
export function setProviderApiKey(id: string, apiKey: string): void {
  const raw = loadRawSettings();
  const providers = { ...(raw.providers as Record<string, RawProviderOverride> | undefined) };
  providers[id] = { ...providers[id], apiKey };
  raw.providers = providers;
  saveRawSettings(raw);
}

/** Remove a stored key, keeping the rest of that provider's override intact. */
export function removeProviderApiKey(id: string): void {
  const raw = loadRawSettings();
  const providers = raw.providers as Record<string, RawProviderOverride> | undefined;
  if (!providers?.[id]?.apiKey) return;
  const { apiKey: _drop, ...rest } = providers[id];
  providers[id] = rest;
  raw.providers = providers;
  saveRawSettings(raw);
}

/** Merge the static registry entry with any user-supplied override from the settings file. */
export function getProvider(id: string): ProviderConfig | undefined {
  const base = PROVIDERS[id];
  if (!base) return undefined;
  const override = getOverride(id);
  if (!override) return base;
  return {
    ...base,
    displayName: override.displayName ?? base.displayName,
    baseUrl: override.baseUrl ?? base.baseUrl,
    models: override.models ?? base.models,
  };
}

export function listProviders(): ProviderConfig[] {
  return Object.keys(PROVIDERS).map((id) => getProvider(id)!);
}

/**
 * Resolve a provider's API key. Checks the settings file first, then the
 * env var named by `apiKeyEnv`. Never hardcoded, never written from here.
 */
export function getProviderApiKey(id: string): string | undefined {
  const override = getOverride(id);
  if (override?.apiKey) return override.apiKey;
  const provider = PROVIDERS[id];
  if (provider?.apiKeyEnv && process.env[provider.apiKeyEnv]) {
    return process.env[provider.apiKeyEnv];
  }
  return undefined;
}

/**
 * Key lookup for a service that is not a chat provider: cloud STT and the
 * realtime speech models (S16). They live in the same `providers` map in the
 * settings file so there is one place to put a key, but they are deliberately
 * NOT registered in PROVIDERS, because they cannot drive a chat and must not
 * appear in the model picker.
 */
export function getExternalApiKey(id: string, envVar: string): string | undefined {
  const override = getOverride(id);
  if (override?.apiKey) return override.apiKey;
  return process.env[envVar] || undefined;
}

/**
 * The non-chat providers, as data. Same `providers.<id>.apiKey` slot in
 * ~/.claude-chat/settings.json and the same env fallback as everything above,
 * but kept out of `PROVIDERS` on purpose: none of them can drive a chat, so
 * none of them may appear in the model picker.
 *
 * `gemini` is here for Live voice (server/src/voice/live/gemini-live.ts). A
 * free Google AI Studio key is enough for it, which is why Settings offers the
 * link: it is the one way to move up a tier at no cost.
 */
export interface ExternalProviderConfig {
  id: string;
  displayName: string;
  apiKeyEnv: string;
  /** Where a user gets a key, shown in Settings. */
  keyUrl?: string;
}

export const EXTERNAL_PROVIDERS: Record<string, ExternalProviderConfig> = {
  gemini: {
    id: "gemini",
    displayName: "Google Gemini",
    apiKeyEnv: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  deepgram: {
    id: "deepgram",
    displayName: "Deepgram",
    apiKeyEnv: "DEEPGRAM_API_KEY",
    keyUrl: "https://console.deepgram.com",
  },
};

/** Resolve an external provider's key from settings or its env var. */
export function getExternalProviderKey(id: string): string | undefined {
  const entry = EXTERNAL_PROVIDERS[id];
  if (!entry) return undefined;
  return getExternalApiKey(entry.id, entry.apiKeyEnv);
}

/**
 * Every provider whose key can be managed from Settings > Providers: chat
 * providers with an `apiKeyEnv` (currently just OpenRouter — "claude" and
 * "kimi" authenticate via CLI login, not a stored key) plus the external
 * services (gemini, openai, deepgram). One list backs `GET
 * /api/providers/keys`.
 */
export interface ManagedKeyProvider {
  id: string;
  displayName: string;
  apiKeyEnv: string;
  keyUrl?: string;
}

export function listManagedKeyProviders(): ManagedKeyProvider[] {
  const chatProviders = Object.values(PROVIDERS)
    .filter((p): p is ProviderConfig & { apiKeyEnv: string } => Boolean(p.apiKeyEnv))
    .map((p) => ({ id: p.id, displayName: p.displayName, apiKeyEnv: p.apiKeyEnv, keyUrl: p.keyUrl }));
  const externals = Object.values(EXTERNAL_PROVIDERS).map((e) => ({
    id: e.id,
    displayName: e.displayName,
    apiKeyEnv: e.apiKeyEnv,
    keyUrl: e.keyUrl,
  }));
  return [...chatProviders, ...externals];
}

export interface KeyStatus {
  hasKey: boolean;
  source: "settings" | "env" | "none";
  /** Last 4 characters only. The full key is never returned to a client. */
  last4?: string;
}

/** Resolve where a managed provider's key (if any) currently comes from. */
export function getKeyStatus(id: string, apiKeyEnv: string): KeyStatus {
  const override = getOverride(id);
  if (override?.apiKey) {
    return { hasKey: true, source: "settings", last4: override.apiKey.slice(-4) };
  }
  const envKey = process.env[apiKeyEnv];
  if (envKey) {
    return { hasKey: true, source: "env", last4: envKey.slice(-4) };
  }
  return { hasKey: false, source: "none" };
}

/**
 * The actual key value for any managed provider (settings first, env
 * second), for the one place (POST /:id/verify) that needs to use a real key
 * server-side. Never returned to a client as-is.
 */
export function resolveManagedProviderKey(id: string, apiKeyEnv: string): string | undefined {
  const override = getOverride(id);
  if (override?.apiKey) return override.apiKey;
  return process.env[apiKeyEnv] || undefined;
}

// ---- Live model listing (with cache + static fallback) --------------------

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const modelCache = new Map<string, { fetchedAt: number; models: ModelInfo[] }>();

interface OpenRouterModelsResponse {
  data?: Array<{ id: string; name?: string }>;
}

/**
 * List models for a provider. Native "claude"/"kimi" always return their
 * static list. Anthropic-compatible providers with a baseUrl (OpenRouter,
 * or a custom one from the settings file) attempt a live GET of
 * `${baseUrl}/v1/models`, cached for 10 minutes, falling back to the
 * static list on any failure (missing key, network error, bad response).
 */
export async function listModels(id: string): Promise<ModelInfo[]> {
  const provider = getProvider(id);
  if (!provider) return [];

  if (!provider.baseUrl || !provider.anthropicCompatible) {
    return provider.models ?? [];
  }

  const cached = modelCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cached.models;
  }

  const apiKey = getProviderApiKey(id);
  if (!apiKey) {
    return provider.models ?? [];
  }

  try {
    const res = await fetch(`${provider.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as OpenRouterModelsResponse;
    const models: ModelInfo[] = (body.data ?? []).map((m) => ({
      id: m.id,
      displayName: m.name ?? m.id,
    }));
    if (models.length === 0) throw new Error("Empty model list");
    modelCache.set(id, { fetchedAt: Date.now(), models });
    return models;
  } catch (err) {
    console.warn(`[providers] Failed to list live models for ${id}, using static fallback:`, err);
    return provider.models ?? [];
  }
}

/** Clears the model cache. Test-only escape hatch. */
export function _clearModelCache(): void {
  modelCache.clear();
}

// ---- Key verification (one cheap authenticated call per provider) ---------

export interface VerifyResult {
  ok: boolean;
  message: string;
  /** Gemini only: whether a native-audio live model is in the list. */
  liveAudioModel?: boolean;
}

/**
 * Make one cheap authenticated call to confirm a key actually works, without
 * spending anything beyond a models/projects list. Never logs or returns the
 * key itself.
 */
export async function verifyProviderKey(id: string, apiKey: string): Promise<VerifyResult> {
  try {
    if (id === "openrouter") {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ok: false, message: `OpenRouter rejected the key (HTTP ${res.status}).` };
      return { ok: true, message: "Key works." };
    }
    if (id === "gemini") {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      );
      if (!res.ok) return { ok: false, message: `Gemini rejected the key (HTTP ${res.status}).` };
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const liveAudioModel = (body.models ?? []).some((m) => (m.name ?? "").includes("native-audio"));
      return {
        ok: true,
        message: liveAudioModel
          ? "Key works. Live audio model available."
          : "Key works, but no native-audio live model was found on this account.",
        liveAudioModel,
      };
    }
    if (id === "openai") {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { ok: false, message: `OpenAI rejected the key (HTTP ${res.status}).` };
      return { ok: true, message: "Key works." };
    }
    if (id === "deepgram") {
      const res = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${apiKey}` },
      });
      if (!res.ok) return { ok: false, message: `Deepgram rejected the key (HTTP ${res.status}).` };
      return { ok: true, message: "Key works." };
    }
    return { ok: false, message: `Unknown provider '${id}'.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Verification failed." };
  }
}

// ---- Env construction for spawning `claude` against an Anthropic-compatible provider ----

export interface ProviderEnvOptions {
  model: string;
  smallFastModel?: string;
}

/**
 * Build the env overrides needed to run the `claude` CLI against an
 * Anthropic-compatible provider (OpenRouter, or a custom one).
 *
 * Mutually exclusive with the Headroom compression proxy: Headroom relies on
 * our Max-plan OAuth token being forwarded through to api.anthropic.com, which
 * only makes sense for the native "claude" provider. When routing through
 * OpenRouter we already authenticate with ANTHROPIC_AUTH_TOKEN=<OpenRouter key>
 * pointed at OpenRouter's own base URL, so Headroom is skipped entirely for
 * this provider (see engine/claude-cli-engine.ts, which picks one or the other).
 */
export function getAnthropicCompatibleEnv(
  id: string,
  opts: ProviderEnvOptions
): Record<string, string | undefined> {
  const provider = getProvider(id);
  if (!provider || !provider.baseUrl || !provider.anthropicCompatible) return {};

  const apiKey = getProviderApiKey(id);
  const smallFast = opts.smallFastModel ?? pickCheapModel(provider) ?? opts.model;

  return {
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    // Unset so the CLI doesn't try to use a native Anthropic API key against
    // a non-Anthropic base URL.
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_MODEL: opts.model,
    ANTHROPIC_SMALL_FAST_MODEL: smallFast,
  };
}

function pickCheapModel(provider: ProviderConfig): string | undefined {
  return provider.models?.find((m) => m.cheap)?.id ?? provider.models?.[0]?.id;
}

/** Default model to use for a provider when a session hasn't picked one. */
export function getDefaultModel(id: string): string | undefined {
  const provider = getProvider(id);
  return provider?.models?.[0]?.id;
}

export function isAnthropicCompatibleProvider(id: string | null | undefined): boolean {
  if (!id) return false;
  return getProvider(id)?.anthropicCompatible === true;
}
