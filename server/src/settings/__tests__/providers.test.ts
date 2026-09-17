import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getAnthropicCompatibleEnv,
  isAnthropicCompatibleProvider,
  listModels,
  _clearModelCache,
  getProvider,
} from "../providers.js";

describe("isAnthropicCompatibleProvider", () => {
  it("is false for native providers", () => {
    expect(isAnthropicCompatibleProvider("claude")).toBe(false);
    expect(isAnthropicCompatibleProvider("kimi")).toBe(false);
    expect(isAnthropicCompatibleProvider(null)).toBe(false);
    expect(isAnthropicCompatibleProvider(undefined)).toBe(false);
  });

  it("is true for openrouter", () => {
    expect(isAnthropicCompatibleProvider("openrouter")).toBe(true);
  });
});

describe("getAnthropicCompatibleEnv: env construction", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });

  it("returns {} for the native claude provider (mutually exclusive with Headroom's own env)", () => {
    expect(getAnthropicCompatibleEnv("claude", { model: "sonnet" })).toEqual({});
  });

  it("returns {} for kimi", () => {
    expect(getAnthropicCompatibleEnv("kimi", { model: "kimi-k2" })).toEqual({});
  });

  it("builds ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL for openrouter and unsets ANTHROPIC_API_KEY", () => {
    const env = getAnthropicCompatibleEnv("openrouter", { model: "openai/gpt-5.1" });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-openrouter-key");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBe("openai/gpt-5.1");
    // Small/fast model defaults to a model flagged `cheap` in the static list.
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeTruthy();
  });

  it("respects an explicit smallFastModel override", () => {
    const env = getAnthropicCompatibleEnv("openrouter", {
      model: "openai/gpt-5.1",
      smallFastModel: "openai/gpt-5.1-mini",
    });
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("openai/gpt-5.1-mini");
  });
});

describe("listModels", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    _clearModelCache();
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    global.fetch = originalFetch;
    _clearModelCache();
  });

  it("returns the static list for native claude/kimi without hitting the network", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const models = await listModels("claude");
    expect(models.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches live models for openrouter and caches the result", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "openai/gpt-5.1", name: "GPT-5.1" }] }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const models = await listModels("openrouter");
    expect(models).toEqual([{ id: "openai/gpt-5.1", displayName: "GPT-5.1" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call within the cache TTL should not refetch.
    await listModels("openrouter");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to the static list when the live fetch fails", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const models = await listModels("openrouter");
    const fallback = getProvider("openrouter")?.models ?? [];
    expect(models).toEqual(fallback);
  });

  it("falls back to the static list when no API key is configured", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const models = await listModels("openrouter");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(models).toEqual(getProvider("openrouter")?.models ?? []);
  });
});
