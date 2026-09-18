/**
 * S16 item 1: warm engines. These tests drive `WarmClaudeEngine` through a
 * fake child process, so they assert the two things that actually matter --
 * the argv that puts the CLI into its long-lived bidirectional mode, and the
 * message framing that feeds successive turns into one process.
 */

import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import {
  buildWarmArgs,
  isResultLine,
  userMessageFrame,
  warmSignature,
  WarmClaudeEngine,
  type SpawnFn,
} from "../warm-claude-engine.js";
import { warmEngineIdFor, isWarmEngineId, getEngine } from "../registry.js";
import type { EngineSessionState } from "../types.js";
import type { ParsedEvent } from "../../claude/types.js";

function fakeState(): EngineSessionState {
  return {
    process: null,
    isFirstMessage: true,
    workingDir: "/tmp",
    kimiSessionKey: "s1",
  };
}

/** A child process that records stdin and lets a test push stdout lines. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  const written: string[] = [];
  child.stdin = { write: (line: string) => written.push(line), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return { child, written, say: (line: string) => child.stdout.emit("data", Buffer.from(line)) };
}

const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  result: "ok",
  session_id: "s1",
});

function deltaLine(text: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });
}

describe("buildWarmArgs", () => {
  it("puts the CLI in bidirectional stream-json mode with no prompt argument", () => {
    const args = buildWarmArgs({ sessionId: "abc", resume: false });
    expect(args).toContain("-p");
    expect(args.join(" ")).toContain("--input-format stream-json");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args).toContain("--include-partial-messages");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("abc");
    // The prompt travels on stdin, so it is never an argument.
    expect(args.some((a) => a.includes("Say hello"))).toBe(false);
  });

  it("resumes an existing conversation and carries the optional flags", () => {
    const args = buildWarmArgs({
      sessionId: "abc",
      resume: true,
      model: "haiku",
      yoloMode: true,
      systemPrompt: "be brief",
      mcpConfigJson: '{"mcpServers":{}}',
    });
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("be brief");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  });
});

describe("userMessageFrame", () => {
  it("is one newline-terminated user message per turn", () => {
    const frame = userMessageFrame("hello");
    expect(frame.endsWith("\n")).toBe(true);
    expect(JSON.parse(frame.trim())).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
  });
});

describe("isResultLine", () => {
  it("recognizes the per-turn terminator and nothing else", () => {
    expect(isResultLine(RESULT_LINE)).toBe(true);
    expect(isResultLine(deltaLine("hi"))).toBe(false);
    expect(isResultLine("not json at all")).toBe(false);
  });
});

describe("warmSignature", () => {
  it("changes when a process-level flag changes", () => {
    const base = { cwd: "/tmp", model: "haiku", systemPrompt: "a" };
    expect(warmSignature(base)).toBe(warmSignature({ ...base }));
    expect(warmSignature({ ...base, model: "opus" })).not.toBe(warmSignature(base));
    expect(warmSignature({ ...base, systemPrompt: "b" })).not.toBe(warmSignature(base));
    expect(warmSignature({ ...base, cwd: "/other" })).not.toBe(warmSignature(base));
  });
});

describe("WarmClaudeEngine", () => {
  it("feeds two turns into one process and settles each on its result line", async () => {
    const { child, written, say } = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const engine = new WarmClaudeEngine(spawnFn);
    const state = fakeState();
    const events: ParsedEvent[] = [];

    const turn1 = engine.spawn({
      sessionId: "s1",
      state,
      text: "first question",
      onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(written[0]!.trim()).message.content[0].text).toBe("first question");
    // The turn holds the process while it runs, so the session looks busy.
    expect(state.process).toBe(child);

    say(`${deltaLine("Hello.")}\n${RESULT_LINE}\n`);
    expect(await turn1).toBe(0);
    expect(events.some((e) => e.kind === "delta" && e.text === "Hello.")).toBe(true);
    expect(events.some((e) => e.kind === "result")).toBe(true);
    // Between turns the session is idle again, which is what lets
    // ProcessManager accept the next message.
    expect(state.process).toBeNull();

    const turn2 = engine.spawn({
      sessionId: "s1",
      state,
      text: "second question",
      onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 0));
    // Same process: no second spawn, and the second frame went down the same
    // stdin.
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(written[1]!.trim()).message.content[0].text).toBe("second question");

    say(`${RESULT_LINE}\n`);
    expect(await turn2).toBe(0);
    expect(engine.isWarm("s1")).toBe(true);
  });

  it("respawns when a process-level setting changes", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    let n = 0;
    const spawnFn = vi.fn(() => children[n++]!.child) as unknown as SpawnFn;
    const engine = new WarmClaudeEngine(spawnFn);
    const state = fakeState();

    const t1 = engine.spawn({ sessionId: "s1", state, text: "a", model: "haiku", onEvent: () => {} });
    await new Promise((r) => setTimeout(r, 0));
    first.say(`${RESULT_LINE}\n`);
    await t1;

    const t2 = engine.spawn({ sessionId: "s1", state, text: "b", model: "opus", onEvent: () => {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(spawnFn).toHaveBeenCalledTimes(2);
    second.say(`${RESULT_LINE}\n`);
    await t2;
  });

  it("buffers a split stdout line rather than losing it", async () => {
    const { child, say } = fakeChild();
    const engine = new WarmClaudeEngine(vi.fn(() => child) as unknown as SpawnFn);
    const state = fakeState();
    const events: ParsedEvent[] = [];
    const turn = engine.spawn({
      sessionId: "s1",
      state,
      text: "q",
      onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 0));

    const line = deltaLine("Split");
    say(line.slice(0, 20));
    say(`${line.slice(20)}\n${RESULT_LINE}\n`);
    await turn;
    expect(events.some((e) => e.kind === "delta" && e.text === "Split")).toBe(true);
  });

  it("settles the turn and retires the process on abort", async () => {
    const { child } = fakeChild();
    const engine = new WarmClaudeEngine(vi.fn(() => child) as unknown as SpawnFn);
    const state = fakeState();
    const turn = engine.spawn({ sessionId: "s1", state, text: "q", onEvent: () => {} });
    await new Promise((r) => setTimeout(r, 0));

    engine.abort(state, "s1");
    // Zero: the turn ended because it was told to, so the socket layer's
    // tier escalation must not re-ask the question the user talked over.
    await expect(turn).resolves.toBe(0);
    expect(engine.isWarm("s1")).toBe(false);
    expect(state.process).toBeNull();
  });
});

describe("warm engine registry", () => {
  it("maps the cold engines onto their warm variants", () => {
    expect(warmEngineIdFor("claude")).toBe("claude-warm");
    expect(warmEngineIdFor("kimi")).toBe("kimi-warm");
    // Code Puppy has no warm variant, and a warm id does not map again.
    expect(warmEngineIdFor("code-puppy")).toBeNull();
    expect(warmEngineIdFor("claude-warm")).toBeNull();
    expect(isWarmEngineId("kimi-warm")).toBe(true);
    expect(isWarmEngineId("kimi")).toBe(false);
  });

  it("registers a warm Kimi that speaks ACP", () => {
    const engine = getEngine("kimi-warm");
    expect(engine?.displayName).toBe("Kimi CLI (warm)");
  });
});
