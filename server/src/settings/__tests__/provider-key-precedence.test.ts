import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * getProviderApiKey / getExternalApiKey precedence (W8): settings file wins
 * over env var, and both are read fresh on every call rather than cached at
 * import — the property that lets a key saved through the new Providers API
 * take effect on the very next use (e.g. the next voice:start) with no
 * server restart.
 *
 * Isolated to a temp HOME, same pattern as packs/__tests__/store.test.ts,
 * since settings/providers.ts computes its settings-file path from
 * process.env.HOME at module load.
 */

let home: string;
let prevHome: string | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;

beforeEach(async () => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-key-precedence-"));
  process.env.HOME = home;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  vi.resetModules();
  mod = await import("../providers.js");
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("getProviderApiKey precedence (chat providers, e.g. openrouter)", () => {
  it("is undefined when neither settings nor env has a key", () => {
    expect(mod.getProviderApiKey("openrouter")).toBeUndefined();
  });

  it("falls back to the env var when no settings key exists", () => {
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    expect(mod.getProviderApiKey("openrouter")).toBe("env-openrouter-key");
  });

  it("prefers a settings-file key over the env var", () => {
    process.env.OPENROUTER_API_KEY = "env-openrouter-key";
    mod.setProviderApiKey("openrouter", "settings-openrouter-key");
    expect(mod.getProviderApiKey("openrouter")).toBe("settings-openrouter-key");
  });

  it("picks up a key saved after the module was already in use, with no re-import", () => {
    expect(mod.getProviderApiKey("openrouter")).toBeUndefined();
    mod.setProviderApiKey("openrouter", "saved-later");
    // Same function, same process, no restart: reads the file fresh.
    expect(mod.getProviderApiKey("openrouter")).toBe("saved-later");
  });
});

describe("getExternalApiKey / getExternalProviderKey precedence (gemini, openai, deepgram)", () => {
  it("prefers a settings-file key over the env var for gemini", () => {
    process.env.GEMINI_API_KEY = "env-gemini-key";
    expect(mod.getExternalApiKey("gemini", "GEMINI_API_KEY")).toBe("env-gemini-key");
    mod.setProviderApiKey("gemini", "settings-gemini-key");
    expect(mod.getExternalApiKey("gemini", "GEMINI_API_KEY")).toBe("settings-gemini-key");
    expect(mod.getExternalProviderKey("gemini")).toBe("settings-gemini-key");
  });

  it("removing a stored key falls back to env, then to undefined", () => {
    process.env.OPENAI_API_KEY = "env-openai-key";
    mod.setProviderApiKey("openai", "settings-openai-key");
    expect(mod.getExternalProviderKey("openai")).toBe("settings-openai-key");
    mod.removeProviderApiKey("openai");
    expect(mod.getExternalProviderKey("openai")).toBe("env-openai-key");
    delete process.env.OPENAI_API_KEY;
    expect(mod.getExternalProviderKey("openai")).toBeUndefined();
  });
});
