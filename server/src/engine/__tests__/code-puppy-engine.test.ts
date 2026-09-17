import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("child_process", () => ({
  spawn: () => {
    throw new Error("spawn should not be called in these tests");
  },
  execSync: () => {
    throw new Error("not found");
  },
}));

const { createCodePuppyEngine, ensurePuppyConfig, puppyConfigPath, CODE_PUPPY_MODELS } =
  await import("../code-puppy-engine.js");

const tempDirs: string[] = [];
function tempCfg(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "puppy-cfg-"));
  tempDirs.push(dir);
  return path.join(dir, "code_puppy", "puppy.cfg");
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  delete process.env.CODE_PUPPY_MODEL;
  delete process.env.CODE_PUPPY_PROVIDER;
});

describe("code-puppy engine", () => {
  it("is an ACP engine wired to `code-puppy --acp`", async () => {
    const engine = createCodePuppyEngine();
    expect(engine.id).toBe("code-puppy");
    expect(engine.displayName).toBe("Code Puppy");
    expect(await engine.listModels()).toEqual(CODE_PUPPY_MODELS);
    expect(CODE_PUPPY_MODELS.length).toBeGreaterThan(0);
  });

  it("resolves the XDG config path", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/xdg";
    expect(puppyConfigPath()).toBe("/xdg/code_puppy/puppy.cfg");
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  });

  it("seeds puppy.cfg with the keys that would otherwise trigger the wizard", () => {
    const cfg = tempCfg();
    process.env.CODE_PUPPY_MODEL = "claude-sonnet-4-5";

    expect(ensurePuppyConfig(cfg)).toBe(true);
    const text = fs.readFileSync(cfg, "utf-8");
    // Both REQUIRED_KEYS must be present or code-puppy calls input() on spawn
    expect(text).toContain("puppy_name = ");
    expect(text).toContain("owner_name = ");
    expect(text).toContain("model = claude-sonnet-4-5");
    expect(text).not.toContain("provider = ");
  });

  it("writes the provider only when one is configured", () => {
    const cfg = tempCfg();
    process.env.CODE_PUPPY_PROVIDER = "openrouter";
    ensurePuppyConfig(cfg);
    expect(fs.readFileSync(cfg, "utf-8")).toContain("provider = openrouter");
  });

  it("never overwrites an existing user config", () => {
    const cfg = tempCfg();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, "[puppy]\npuppy_name = Rex\n", "utf-8");

    expect(ensurePuppyConfig(cfg)).toBe(false);
    expect(fs.readFileSync(cfg, "utf-8")).toBe("[puppy]\npuppy_name = Rex\n");
  });
});
