import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { EngineSessionState } from "../types.js";
import type { ParsedEvent } from "../../claude/types.js";

const spawnMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execSync: () => {
    throw new Error("not found");
  },
}));

const { KimiCliEngine } = await import("../kimi-cli-engine.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures", "kimi-1.47-stream.jsonl"), "utf-8");

interface FakeChild {
  stdout: { on: (ev: string, cb: (chunk: Buffer) => void) => void };
  stderr: { on: (ev: string, cb: (chunk: Buffer) => void) => void };
  on: (ev: string, cb: (arg: unknown) => void) => void;
  kill: (sig: string) => void;
  killed: boolean;
  emitStdout: (text: string) => void;
  close: (code: number | null) => void;
}

function makeFakeChild(): FakeChild {
  const handlers: Record<string, (arg: unknown) => void> = {};
  let onData: ((chunk: Buffer) => void) | null = null;
  return {
    stdout: {
      on: (ev, cb) => {
        if (ev === "data") onData = cb;
      },
    },
    stderr: { on: () => {} },
    on: (ev, cb) => {
      handlers[ev] = cb;
    },
    kill: () => {},
    killed: false,
    emitStdout: (text) => onData?.(Buffer.from(text)),
    close: (code) => handlers["close"]?.(code),
  };
}

function makeState(): EngineSessionState {
  return { process: null, isFirstMessage: true, workingDir: "/tmp/work", kimiSessionKey: "sess-1" };
}

async function runWithStdout(stdout: string): Promise<ParsedEvent[]> {
  const child = makeFakeChild();
  spawnMock.mockReturnValue(child);
  const events: ParsedEvent[] = [];
  const engine = new KimiCliEngine();
  const done = engine.spawn({
    sessionId: "s1",
    state: makeState(),
    text: "hi",
    onEvent: (e: ParsedEvent) => events.push(e),
  });
  child.emitStdout(stdout);
  child.close(0);
  await done;
  return events;
}

describe("KimiCliEngine stdout parsing", () => {
  beforeEach(() => spawnMock.mockReset());

  it("emits the final answer when content is a plain string (kimi 1.47+)", async () => {
    const events = await runWithStdout(fixture);
    const deltas = events.filter((e) => e.kind === "delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ kind: "delta", text: 'The name is **"claude-chat"**.' });
  });

  it("maps tool_calls and tool messages to tool_use_start and tool_result", async () => {
    const events = await runWithStdout(fixture);
    const start = events.find((e) => e.kind === "tool_use_start");
    const result = events.find((e) => e.kind === "tool_result");
    expect(start).toMatchObject({
      toolId: "tool_CREhtCQIzvBihHyWrBUgWAzD",
      toolName: "ReadFile",
      input: { path: "/tmp/work/package.json" },
    });
    expect(result).toMatchObject({ toolUseId: "tool_CREhtCQIzvBihHyWrBUgWAzD" });
    expect((result as { content: string }).content).toContain('"name": "claude-chat"');
  });

  it("still reads legacy block-array content", async () => {
    const legacy = JSON.stringify({ role: "assistant", content: [{ type: "text", text: "legacy" }] });
    const events = await runWithStdout(legacy + "\n");
    expect(events.filter((e) => e.kind === "delta")).toEqual([{ kind: "delta", text: "legacy" }]);
  });

  it("finalizes with a result event", async () => {
    const events = await runWithStdout(fixture);
    expect(events[events.length - 1]).toMatchObject({ kind: "result", success: true, sessionId: "s1" });
  });
});
