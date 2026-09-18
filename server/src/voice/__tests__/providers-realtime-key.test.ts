import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * W8: a Gemini key saved through the new Providers API must be picked up by
 * the very next voice:start, with no server restart. `getRealtimeProvider`
 * (server/src/voice/providers.ts) is exactly the function voice-handlers.ts
 * calls on every session start, and it resolves the key through
 * `getExternalApiKey`, which reads settings.json fresh on every call — no
 * caching at import time to work around. This test proves that end to end:
 * no key -> null (not ready), save a key at runtime -> a ready
 * GeminiLiveProvider, same process, no re-import of either module.
 */

let home: string;
let prevHome: string | undefined;
let prevGeminiEnv: string | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let settingsMod: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let voiceProvidersMod: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let geminiLiveMod: any;

beforeEach(async () => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-realtime-key-"));
  process.env.HOME = home;
  prevGeminiEnv = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  vi.resetModules();
  settingsMod = await import("../../settings/providers.js");
  voiceProvidersMod = await import("../providers.js");
  geminiLiveMod = await import("../live/gemini-live.js");
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevGeminiEnv === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = prevGeminiEnv;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("getRealtimeProvider picks up a key saved at runtime", () => {
  it("returns null with no key, then a ready GeminiLiveProvider right after the key is saved", () => {
    expect(voiceProvidersMod.getRealtimeProvider("gemini-live")).toBeNull();

    settingsMod.setProviderApiKey("gemini", "AIza-runtime-saved-key");

    const provider = voiceProvidersMod.getRealtimeProvider("gemini-live");
    expect(provider).not.toBeNull();
    expect(provider).toBeInstanceOf(geminiLiveMod.GeminiLiveProvider);
    expect(provider!.id).toBe("gemini-live");
  });

  it("listRealtimeProviders() flips gemini-live to ready once a key exists", () => {
    const before = voiceProvidersMod.listRealtimeProviders();
    expect(before.find((p: { id: string }) => p.id === "gemini-live").ready).toBe(false);

    settingsMod.setProviderApiKey("gemini", "AIza-runtime-saved-key");

    const after = voiceProvidersMod.listRealtimeProviders();
    expect(after.find((p: { id: string }) => p.id === "gemini-live").ready).toBe(true);
  });

  it("removing the key drops it back to not-ready without a restart", () => {
    settingsMod.setProviderApiKey("gemini", "AIza-runtime-saved-key");
    expect(voiceProvidersMod.getRealtimeProvider("gemini-live")).not.toBeNull();

    settingsMod.removeProviderApiKey("gemini");
    expect(voiceProvidersMod.getRealtimeProvider("gemini-live")).toBeNull();
  });
});
