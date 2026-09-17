/**
 * Env-selection tests for ClaudeCliEngine: the engine is what actually spawns
 * the `claude` CLI, so these assert on the env object handed to
 * child_process.spawn rather than on any ProcessManager internals.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";
import type { EngineSessionState } from "../types.js";

const spawnMock = vi.fn();

// Point providers.ts at an empty HOME so it can't pick up the developer's real
// ~/.claude-chat/settings.json overrides. Must happen before it is imported.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-engine-env-"));
const originalHome = process.env.HOME;
process.env.HOME = fakeHome;

let activeProvider: string | null = "claude";
const headroomEnv: Record<string, string> = {};

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execSync: () => {
    throw new Error("not found");
  },
}));

vi.mock("../../settings/store.js", () => ({
  getActiveConfigDir: () => undefined,
  getActiveProvider: () => activeProvider,
}));

vi.mock("../../headroom/proxy-manager.js", () => ({
  getHeadroomEnv: () => headroomEnv,
}));

const { ClaudeCliEngine } = await import("../claude-cli-engine.js");

function makeFakeChild() {
  const handlers: Record<string, (arg: unknown) => void> = {};
  return {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (ev: string, cb: (arg: unknown) => void) => {
      handlers[ev] = cb;
    },
    kill: () => {},
    killed: false,
    close: (code: number | null) => handlers["close"]?.(code),
  };
}

function makeState(): EngineSessionState {
  return {
    process: null,
    isFirstMessage: true,
    workingDir: "/tmp/work",
    kimiSessionKey: "sess-1",
  };
}

/** Spawns once and returns the env passed to child_process.spawn. */
async function capturedEnv(model?: string): Promise<Record<string, string | undefined>> {
  const child = makeFakeChild();
  spawnMock.mockReturnValue(child);
  const promise = new ClaudeCliEngine().spawn({
    sessionId: "abc",
    state: makeState(),
    text: "hello",
    model,
    onEvent: () => {},
  });
  child.close(0);
  await promise;
  const options = spawnMock.mock.calls[0][2] as { env: Record<string, string | undefined> };
  return options.env;
}

describe("ClaudeCliEngine provider env", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    spawnMock.mockReset();
    activeProvider = "claude";
    for (const k of Object.keys(headroomEnv)) delete headroomEnv[k];
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("uses the Headroom env for the native claude provider", async () => {
    headroomEnv.ANTHROPIC_BASE_URL = "http://127.0.0.1:4000";
    const env = await capturedEnv("sonnet");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4000");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it("injects the OpenRouter env instead of Headroom's when openrouter is active", async () => {
    headroomEnv.ANTHROPIC_BASE_URL = "http://127.0.0.1:4000";
    activeProvider = "openrouter";
    const env = await capturedEnv("openai/gpt-5.1");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-openrouter-key");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBe("openai/gpt-5.1");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeTruthy();
  });

  it("always clears CLAUDECODE so the child is not seen as a nested session", async () => {
    const env = await capturedEnv();
    expect(env.CLAUDECODE).toBeUndefined();
  });
});
