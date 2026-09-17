import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import type { ClaudeStreamEvent, EngineSessionState } from "../types.js";

const spawnMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  // Force the binary lookup down its fallback path; no real CLI is touched.
  execSync: () => {
    throw new Error("not found");
  },
}));

const { AcpEngine } = await import("../acp-engine.js");
const { buildMedusaMcpDescriptor } = await import("../../mcp/config.js");

// ---------------------------------------------------------------------------
// A fake ACP agent: we drive the JSON-RPC by hand, line by line.
// ---------------------------------------------------------------------------

interface FakeAgent {
  child: any;
  /** Every line the engine wrote to the agent's stdin, parsed. */
  sent: any[];
  /** Write one raw string to the engine's stdout reader. */
  emitRaw(text: string): void;
  /** Write one JSON-RPC message as a line. */
  send(msg: Record<string, unknown>): void;
  /** Wait until the engine has sent a request for `method`, return it. */
  waitFor(method: string): Promise<any>;
  /** Reply to the request with the given id. */
  reply(id: number, result: unknown): void;
  close(code: number | null): void;
  killed: string[];
}

function makeAgent(): FakeAgent {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child: any = new EventEmitter();
  const sent: any[] = [];
  const killed: string[] = [];
  const waiters: Array<{ method: string; resolve: (msg: any) => void }> = [];

  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = (sig: string) => {
    killed.push(sig);
    child.killed = true;
  };
  child.stdin = {
    write: (line: string) => {
      const msg = JSON.parse(line.trim());
      sent.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].method === msg.method) {
          waiters.splice(i, 1)[0].resolve(msg);
        }
      }
      return true;
    },
  };

  return {
    child,
    sent,
    killed,
    emitRaw: (text) => stdout.emit("data", Buffer.from(text, "utf-8")),
    send(msg) {
      stdout.emit("data", Buffer.from(JSON.stringify(msg) + "\n", "utf-8"));
    },
    waitFor(method) {
      const existing = sent.find((m) => m.method === method);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ method, resolve }));
    },
    reply(id, result) {
      this.send({ jsonrpc: "2.0", id, result });
    },
    close: (code) => child.emit("close", code),
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

function makeEngine() {
  return new AcpEngine({
    id: "test-acp",
    displayName: "Test ACP Agent",
    command: "fake-agent",
    args: ["--acp"],
    models: [{ id: "m1", label: "Model One" }],
  });
}

const INIT_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
  },
  agentInfo: { name: "fake-agent", version: "1.0.0" },
};

/**
 * Runs the initialize + session/new handshake and leaves the turn parked at
 * session/prompt, so each test can drive the interesting part itself.
 */
async function handshake(
  agent: FakeAgent,
  opts: Record<string, unknown> = {}
): Promise<{
  events: ClaudeStreamEvent[];
  state: EngineSessionState;
  promptId: number;
  done: Promise<number | null>;
  engine: InstanceType<typeof AcpEngine>;
}> {
  const engine = makeEngine();
  const events: ClaudeStreamEvent[] = [];
  const state = (opts.state as EngineSessionState) ?? makeState();

  const done = engine.spawn({
    sessionId: "medusa-1",
    state,
    text: "hello",
    onEvent: (e) => events.push(e),
    ...(opts as any),
  });

  const init = await agent.waitFor("initialize");
  agent.reply(init.id, INIT_RESULT);

  const created = await agent.waitFor("session/new");
  agent.reply(created.id, { sessionId: "sess_abc" });

  const prompt = await agent.waitFor("session/prompt");
  return { events, state, promptId: prompt.id, done, engine };
}

describe("AcpEngine", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("exposes its identity and configured model list", async () => {
    const engine = makeEngine();
    expect(engine.id).toBe("test-acp");
    expect(engine.displayName).toBe("Test ACP Agent");
    expect(await engine.listModels()).toEqual([{ id: "m1", label: "Model One" }]);
  });

  it("runs initialize -> session/new -> session/prompt in order", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);

    const { events, promptId, done } = await handshake(agent);
    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;

    expect(agent.sent.map((m) => m.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);

    const init = agent.sent[0];
    expect(init.params.protocolVersion).toBe(1);
    expect(init.params.clientCapabilities.fs).toEqual({
      readTextFile: true,
      writeTextFile: true,
    });

    expect(agent.sent[1].params.cwd).toBe("/tmp/work");
    expect(agent.sent[2].params).toEqual({
      sessionId: "sess_abc",
      prompt: [{ type: "text", text: "hello" }],
    });

    // Synthetic system init so the client's session header logic works
    const initEvent = events.find((e) => e.kind === "init") as any;
    expect(initEvent).toMatchObject({
      kind: "init",
      sessionId: "sess_abc",
      cwd: "/tmp/work",
      tools: [],
    });

    const result = events.find((e) => e.kind === "result") as any;
    expect(result).toMatchObject({ success: true, sessionId: "medusa-1" });

    // The CLI is launched with the configured argv in the session cwd
    expect(spawnMock.mock.calls[0][0]).toBe("fake-agent");
    expect(spawnMock.mock.calls[0][1]).toEqual(["--acp"]);
    expect((spawnMock.mock.calls[0][2] as any).cwd).toBe("/tmp/work");
  });

  it("maps agent_message_chunk notifications to text deltas", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { events, promptId, done } = await handshake(agent);

    for (const text of ["Hel", "lo ", "world"]) {
      agent.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_abc",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    }
    // Thinking deltas have no ParsedEvent equivalent and are dropped
    agent.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_abc",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "hmm" },
        },
      },
    });

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;

    expect(events.filter((e) => e.kind === "delta").map((e: any) => e.text)).toEqual([
      "Hel",
      "lo ",
      "world",
    ]);
  });

  it("translates the tool_call lifecycle into tool_use_start + tool_result", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { events, promptId, done } = await handshake(agent);

    agent.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_abc",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_001",
          title: "Reading configuration file",
          kind: "read",
          status: "pending",
          locations: [{ path: "/tmp/work/config.json" }],
        },
      },
    });

    // An in-progress update must not produce a premature tool_result
    agent.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_abc",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_001",
          status: "in_progress",
        },
      },
    });
    expect(events.filter((e) => e.kind === "tool_result")).toHaveLength(0);

    agent.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_abc",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_001",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "3 files found" } },
          ],
        },
      },
    });

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;

    const starts = events.filter((e) => e.kind === "tool_use_start") as any[];
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      toolId: "call_001",
      toolName: "Reading configuration file",
    });
    expect(starts[0].input).toMatchObject({ kind: "read", status: "pending" });

    const results = events.filter((e) => e.kind === "tool_result") as any[];
    expect(results).toHaveLength(1);
    expect(results[0].toolUseId).toBe("call_001");
    expect(results[0].content).toContain("[read] completed");
    expect(results[0].content).toContain("3 files found");
  });

  it("renders diff content blocks in the tool result", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { events, promptId, done } = await handshake(agent);

    agent.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_abc",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_002",
          title: "Edit config.json",
          kind: "edit",
          status: "completed",
          content: [
            { type: "diff", path: "/tmp/work/c.json", oldText: "old", newText: "new" },
          ],
        },
      },
    });

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;

    // No tool_call was ever seen, so the start is synthesized
    expect(events.filter((e) => e.kind === "tool_use_start")).toHaveLength(1);
    const result = events.find((e) => e.kind === "tool_result") as any;
    expect(result.content).toContain("/tmp/work/c.json");
    expect(result.content).toContain("new");
  });

  it("turns plan updates into a system/info event", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { events, promptId, done } = await handshake(agent);

    agent.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_abc",
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read the file", priority: "high", status: "completed" },
            { content: "Patch it", priority: "high", status: "in_progress" },
            { content: "Run tests", priority: "medium", status: "pending" },
          ],
        },
      },
    });

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;

    const info = events.find((e: any) => e.kind === "system") as any;
    expect(info.subtype).toBe("info");
    expect(info.text).toContain("[x] Read the file");
    expect(info.text).toContain("[>] Patch it");
    expect(info.text).toContain("[ ] Run tests");
  });

  it("auto-allows session/request_permission in yolo mode", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { events, promptId, done } = await handshake(agent, { yoloMode: true });

    agent.send({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: {
        sessionId: "sess_abc",
        toolCall: { toolCallId: "call_001", title: "Run: rm -rf build" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    await new Promise((r) => setImmediate(r));

    const reply = agent.sent.find((m) => m.id === 99);
    expect(reply.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    // Nothing is surfaced to the user when the call is auto-approved
    expect(events.filter((e) => e.kind === "tool_result")).toHaveLength(0);

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;
  });

  it("auto-rejects session/request_permission outside yolo mode and says why", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { events, promptId, done } = await handshake(agent, { yoloMode: false });

    agent.send({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: {
        sessionId: "sess_abc",
        toolCall: { toolCallId: "call_001", title: "Run: rm -rf build" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(agent.sent.find((m) => m.id === 99).result).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    const denial = events.find((e) => e.kind === "tool_result") as any;
    expect(denial.content).toContain("Permission denied");
    expect(denial.content).toContain("YOLO mode");

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;
  });

  it("serves fs/read_text_file and fs/write_text_file inside the session cwd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-fs-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "line1\nline2\nline3", "utf-8");

    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { promptId, done } = await handshake(agent, {
      state: makeState({ workingDir: dir }),
    });

    agent.send({
      jsonrpc: "2.0",
      id: 10,
      method: "fs/read_text_file",
      params: { sessionId: "sess_abc", path: "a.txt" },
    });
    agent.send({
      jsonrpc: "2.0",
      id: 11,
      method: "fs/write_text_file",
      params: { sessionId: "sess_abc", path: "sub/b.txt", content: "written" },
    });
    await new Promise((r) => setImmediate(r));

    expect(agent.sent.find((m) => m.id === 10).result).toEqual({
      content: "line1\nline2\nline3",
    });
    expect(agent.sent.find((m) => m.id === 11).result).toEqual({});
    expect(fs.readFileSync(path.join(dir, "sub", "b.txt"), "utf-8")).toBe("written");

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses fs paths that escape the session cwd", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { promptId, done } = await handshake(agent);

    agent.send({
      jsonrpc: "2.0",
      id: 12,
      method: "fs/read_text_file",
      params: { sessionId: "sess_abc", path: "../../etc/passwd" },
    });
    agent.send({
      jsonrpc: "2.0",
      id: 13,
      method: "fs/write_text_file",
      params: { sessionId: "sess_abc", path: "/etc/evil", content: "x" },
    });
    await new Promise((r) => setImmediate(r));

    expect(agent.sent.find((m) => m.id === 12).error.message).toContain("escapes");
    expect(agent.sent.find((m) => m.id === 13).error.message).toContain("escapes");

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;
  });

  it("answers terminal/* with method-not-found", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { promptId, done } = await handshake(agent);

    agent.send({
      jsonrpc: "2.0",
      id: 20,
      method: "terminal/create",
      params: { sessionId: "sess_abc", command: "ls" },
    });
    await new Promise((r) => setImmediate(r));

    expect(agent.sent.find((m) => m.id === 20).error).toMatchObject({ code: -32601 });

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;
  });

  it("sends session/cancel then SIGTERM on abort", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { state, promptId, done, engine } = await handshake(agent);

    engine.abort(state, "medusa-1");

    const cancel = agent.sent.find((m) => m.method === "session/cancel");
    expect(cancel.params).toEqual({ sessionId: "sess_abc" });
    expect(cancel.id).toBeUndefined(); // notification, not a request
    expect(agent.killed).toEqual(["SIGTERM"]);

    // The agent still answers, as a well-behaved ACP agent does after a cancel
    agent.reply(promptId, { stopReason: "cancelled" });
    agent.close(null);
    await done;
  });

  it("emits an error result when the process dies mid-prompt", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { events, done } = await handshake(agent);

    agent.close(1);
    await done;

    const result = events.find((e) => e.kind === "result") as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Test ACP Agent exited");
    expect(result.error).toContain("code 1");
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  it("reports a non-end_turn stopReason as a failed result", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { events, promptId, done } = await handshake(agent);

    agent.reply(promptId, { stopReason: "refusal" });
    agent.close(0);
    await done;

    const result = events.find((e) => e.kind === "result") as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("refusal");
  });

  it("survives malformed and partial stdout lines", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);

    const engine = makeEngine();
    const events: ClaudeStreamEvent[] = [];
    const done = engine.spawn({
      sessionId: "medusa-1",
      state: makeState(),
      text: "hello",
      onEvent: (e) => events.push(e),
    });

    // Garbage before, between, and after the real responses
    agent.emitRaw("starting up...\n{not json}\n");
    const init = await agent.waitFor("initialize");
    agent.reply(init.id, INIT_RESULT);
    agent.emitRaw("\n   \n[warn] noise\n");

    const created = await agent.waitFor("session/new");
    // Split one valid message across two chunks to exercise the line buffer
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: created.id,
      result: { sessionId: "sess_abc" },
    });
    agent.emitRaw(line.slice(0, 20));
    agent.emitRaw(line.slice(20) + "\n");

    const prompt = await agent.waitFor("session/prompt");
    agent.emitRaw("{\"jsonrpc\": broken\n");
    agent.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_abc",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
      },
    });
    agent.reply(prompt.id, { stopReason: "end_turn" });
    agent.close(0);
    await done;

    expect(events.filter((e) => e.kind === "delta").map((e: any) => e.text)).toEqual(["ok"]);
    expect((events.find((e) => e.kind === "result") as any).success).toBe(true);
  });

  it("resumes with session/load on the second turn, without replaying history", async () => {
    // Turn 1 establishes the ACP session id
    const first = makeAgent();
    spawnMock.mockReturnValue(first.child);
    const engine = makeEngine();
    const state = makeState();

    const run1 = engine.spawn({
      sessionId: "medusa-1",
      state,
      text: "one",
      onEvent: () => {},
    });
    first.reply((await first.waitFor("initialize")).id, INIT_RESULT);
    first.reply((await first.waitFor("session/new")).id, { sessionId: "sess_abc" });
    first.reply((await first.waitFor("session/prompt")).id, { stopReason: "end_turn" });
    first.close(0);
    await run1;

    // Turn 2 reuses it via session/load
    const second = makeAgent();
    spawnMock.mockReturnValue(second.child);
    const events: ClaudeStreamEvent[] = [];
    const run2 = engine.spawn({
      sessionId: "medusa-1",
      state,
      text: "two",
      onEvent: (e) => events.push(e),
    });
    second.reply((await second.waitFor("initialize")).id, INIT_RESULT);

    const load = await second.waitFor("session/load");
    expect(load.params).toEqual({
      sessionId: "sess_abc",
      cwd: "/tmp/work",
      mcpServers: [],
    });
    // The agent replays history while the load is in flight; it must be dropped
    second.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_abc",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "OLD HISTORY" },
        },
      },
    });
    second.reply(load.id, {});

    const prompt = await second.waitFor("session/prompt");
    expect(second.sent.some((m) => m.method === "session/new")).toBe(false);
    second.reply(prompt.id, { stopReason: "end_turn" });
    second.close(0);
    await run2;

    expect(events.some((e: any) => e.kind === "delta" && e.text === "OLD HISTORY")).toBe(
      false
    );
  });

  it("starts a fresh session when forceNew is set", async () => {
    const first = makeAgent();
    spawnMock.mockReturnValue(first.child);
    const engine = makeEngine();
    const state = makeState();

    const run1 = engine.spawn({
      sessionId: "medusa-1",
      state,
      text: "one",
      onEvent: () => {},
    });
    first.reply((await first.waitFor("initialize")).id, INIT_RESULT);
    first.reply((await first.waitFor("session/new")).id, { sessionId: "sess_abc" });
    first.reply((await first.waitFor("session/prompt")).id, { stopReason: "end_turn" });
    first.close(0);
    await run1;

    const second = makeAgent();
    spawnMock.mockReturnValue(second.child);
    const run2 = engine.spawn({
      sessionId: "medusa-1",
      state,
      text: "two",
      forceNew: true,
      onEvent: () => {},
    });
    second.reply((await second.waitFor("initialize")).id, INIT_RESULT);
    const created = await second.waitFor("session/new");
    second.reply(created.id, { sessionId: "sess_def" });
    second.reply((await second.waitFor("session/prompt")).id, { stopReason: "end_turn" });
    second.close(0);
    await run2;

    expect(second.sent.some((m) => m.method === "session/load")).toBe(false);
  });

  it("inlines images as base64 blocks when the agent supports them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-img-"));
    const img = path.join(dir, "shot.png");
    fs.writeFileSync(img, Buffer.from([1, 2, 3]));

    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { promptId, done } = await handshake(agent, {
      images: [img],
      files: ["/tmp/notes.md"],
      systemPrompt: "be terse",
    });

    const blocks = agent.sent.find((m) => m.method === "session/prompt").params.prompt;
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("SYSTEM INSTRUCTIONS");
    expect(blocks[0].text).toContain("Please read this file: /tmp/notes.md");
    expect(blocks[1]).toEqual({
      type: "image",
      data: Buffer.from([1, 2, 3]).toString("base64"),
      mimeType: "image/png",
    });

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends an empty mcpServers array when no descriptor is passed", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);
    const { promptId, done } = await handshake(agent);
    expect(agent.sent[1].params.mcpServers).toEqual([]);
    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;
  });

  it("carries a non-empty mcpServers array naming medusa on session/new", async () => {
    const agent = makeAgent();
    spawnMock.mockReturnValue(agent.child);

    const { promptId, done } = await handshake(agent, {
      mcpConfig: buildMedusaMcpDescriptor({
        parentSessionId: "medusa-1",
        serverUrl: "http://127.0.0.1:3456",
        authToken: "tok",
        shimPath: "/srv/dist/mcp/medusa-mcp-shim.js",
      }),
    });

    const servers = agent.sent[1].params.mcpServers;
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({
      name: "medusa",
      command: "node",
      args: ["/srv/dist/mcp/medusa-mcp-shim.js"],
      // ACP takes env as name/value pairs, not the CLIs' object map.
      env: [
        { name: "MEDUSA_URL", value: "http://127.0.0.1:3456" },
        { name: "MEDUSA_TOKEN", value: "tok" },
        { name: "MEDUSA_PARENT_SESSION_ID", value: "medusa-1" },
      ],
    });

    agent.reply(promptId, { stopReason: "end_turn" });
    agent.close(0);
    await done;
  });
});
