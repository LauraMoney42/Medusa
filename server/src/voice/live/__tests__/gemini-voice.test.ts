import { describe, expect, it } from "vitest";
import { buildGeminiSetup, GEMINI_DEFAULT_VOICE, resolveGeminiVoice } from "../gemini-live.js";

describe("resolveGeminiVoice", () => {
  it("falls back to the default when handed a Kokoro voice id", () => {
    expect(resolveGeminiVoice("af_heart")).toBe(GEMINI_DEFAULT_VOICE);
  });
  it("accepts Gemini voices case-insensitively", () => {
    expect(resolveGeminiVoice("puck")).toBe("Puck");
  });
  it("defaults when empty", () => {
    expect(resolveGeminiVoice(undefined)).toBe(GEMINI_DEFAULT_VOICE);
  });
  it("never puts an unknown speaker in the setup frame", () => {
    const setup = buildGeminiSetup("m", { instructions: "", toolSpecs: [] } as any, { voice: "af_heart" }) as any;
    expect(setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(GEMINI_DEFAULT_VOICE);
  });
});
