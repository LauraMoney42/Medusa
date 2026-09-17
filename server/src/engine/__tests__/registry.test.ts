import { describe, it, expect, vi } from "vitest";
import type { Engine } from "../types.js";

vi.mock("child_process", () => ({
  spawn: () => {
    throw new Error("spawn should not be called in registry tests");
  },
  execSync: () => {
    throw new Error("not found");
  },
}));

vi.mock("../../settings/store.js", () => ({
  getActiveConfigDir: () => undefined,
  getActiveProvider: () => "claude",
}));

vi.mock("../../headroom/proxy-manager.js", () => ({
  getHeadroomEnv: () => ({}),
}));

const { getEngine, getEngineOrDefault, listEngines, registerEngine } =
  await import("../registry.js");

describe("engine registry", () => {
  it("ships the claude and kimi engines", () => {
    const ids = listEngines().map((e) => e.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("kimi");
  });

  it("looks engines up by id", () => {
    expect(getEngine("claude")?.displayName).toBe("Claude Code");
    expect(getEngine("kimi")?.displayName).toBe("Kimi CLI");
    expect(getEngine("nope")).toBeUndefined();
  });

  it("falls back to claude for unknown or missing ids", () => {
    expect(getEngineOrDefault("nope").id).toBe("claude");
    expect(getEngineOrDefault(null).id).toBe("claude");
    expect(getEngineOrDefault(undefined).id).toBe("claude");
    expect(getEngineOrDefault("kimi").id).toBe("kimi");
  });

  it("accepts engines registered at runtime", () => {
    const fake: Engine = {
      id: "test-engine",
      displayName: "Test Engine",
      spawn: async () => 0,
      abort: () => {},
      listModels: async () => [{ id: "m", label: "M" }],
    };
    registerEngine(fake);
    expect(getEngine("test-engine")).toBe(fake);
    expect(getEngineOrDefault("test-engine").displayName).toBe("Test Engine");
  });

  it("reports a model list for every built-in engine", async () => {
    const claudeModels = await getEngineOrDefault("claude").listModels();
    expect(claudeModels.length).toBeGreaterThan(0);
    expect(await getEngineOrDefault("kimi").listModels()).toEqual([]);
  });
});
