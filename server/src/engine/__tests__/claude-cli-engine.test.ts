import { describe, it, expect, beforeEach, vi } from "vitest";
import type { EngineSessionState } from "../types.js";

const spawnMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  // Force findClaudeBinary() down its fallback path so tests never touch a real CLI
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

const { ClaudeCliEngine } = await import("../claude-cli-engine.js");

interface FakeChild {
  stdout: { on: (ev: string, cb: (chunk: Buffer) => void) => void };
  stderr: { on: (ev: string, cb: (chunk: Buffer) => void) => void };
  on: (ev: string, cb: (arg: unknown) => void) => void;
  kill: (sig: string) => void;
  killed: boolean;
  close: (code: number | null) => void;
}

function makeFakeChild(): FakeChild {
  const handlers: Record<string, (arg: unknown) => void> = {};
  return {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (ev, cb) => {
      handlers[ev] = cb;
    },
    kill: () => {},
    killed: false,
    close: (code) => handlers["close"]?.(code),
  };
}

function makeState(overrides: Partial<EngineSessionState> = {}): EngineSessionState {
  return {
    process: null,
    isFirstMessage: true,
    workingDir: "/tmp/work",
    kimiSessionKey: "sess-1",
    ...overrides,
  };
}

/** Runs one spawn and returns the argv the engine passed to child_process.spawn. */
async function capturedArgs(opts: Record<string, unknown>): Promise<string[]> {
  const child = makeFakeChild();
  spawnMock.mockReturnValue(child);
  const engine = new ClaudeCliEngine();
  const promise = engine.spawn({ onEvent: () => {}, ...(opts as any) });
  child.close(0);
  await promise;
  return spawnMock.mock.calls[0][1] as string[];
}

describe("ClaudeCliEngine", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("exposes its identity and model list", async () => {
    const engine = new ClaudeCliEngine();
    expect(engine.id).toBe("claude");
    expect(engine.displayName).toBe("Claude Code");
    expect((await engine.listModels()).map((m) => m.id)).toEqual([
      "haiku",
      "sonnet",
      "opus",
      "fable",
    ]);
  });

  it("uses --session-id for a new session", async () => {
    const args = await capturedArgs({
      sessionId: "abc",
      state: makeState(),
      text: "hello",
    });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "abc",
    ]);
  });

  it("uses --resume for a continuing session", async () => {
    const args = await capturedArgs({
      sessionId: "abc",
      state: makeState({ isFirstMessage: false }),
      text: "hello",
    });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "abc",
    ]);
  });

  it("appends --dangerously-skip-permissions in yolo mode", async () => {
    const args = await capturedArgs({
      sessionId: "abc",
      state: makeState(),
      text: "hello",
      yoloMode: true,
    });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "abc",
      "--dangerously-skip-permissions",
    ]);
  });

  it("appends --model for a custom model", async () => {
    const args = await capturedArgs({
      sessionId: "abc",
      state: makeState(),
      text: "hello",
      model: "opus",
    });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "abc",
      "--model",
      "opus",
    ]);
  });

  it("appends --system-prompt before --model", async () => {
    const args = await capturedArgs({
      sessionId: "abc",
      state: makeState({ isFirstMessage: false }),
      text: "hello",
      systemPrompt: "be terse",
      model: "haiku",
      yoloMode: true,
    });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "abc",
      "--dangerously-skip-permissions",
      "--system-prompt",
      "be terse",
      "--model",
      "haiku",
    ]);
  });

  it("prepends image and file read instructions to the prompt", async () => {
    const args = await capturedArgs({
      sessionId: "abc",
      state: makeState(),
      text: "hello",
      images: ["/tmp/a.png"],
      files: ["/tmp/b.txt"],
    });
    expect(args[1]).toBe(
      "Please read this file: /tmp/b.txt\n\nPlease read this image: /tmp/a.png\n\nhello"
    );
  });

  it("spawns in the session working dir", async () => {
    await capturedArgs({
      sessionId: "abc",
      state: makeState({ workingDir: "/srv/project" }),
      text: "hello",
    });
    const options = spawnMock.mock.calls[0][2] as { cwd: string };
    expect(options.cwd).toBe("/srv/project");
  });

  it("marks the session as continuing after a clean exit", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const state = makeState();
    const promise = new ClaudeCliEngine().spawn({
      sessionId: "abc",
      state,
      text: "hello",
      onEvent: () => {},
    });
    child.close(0);
    await promise;
    expect(state.isFirstMessage).toBe(false);
    expect(state.process).toBeNull();
  });
});
