import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SubagentManager, SubagentError } from "../manager.js";
import { RESULT_TEXT_LIMIT, type ParentSessionInfo } from "../types.js";
import type {
  Engine,
  EngineSessionState,
  EngineSpawnOptions,
  ModelInfo,
} from "../../engine/types.js";

/**
 * A fake Engine whose runs are driven by hand. No child_process anywhere, so
 * nothing in this suite can spawn a real CLI.
 */
class FakeEngine implements Engine {
  readonly displayName = "Fake";
  readonly runs: Array<{
    opts: EngineSpawnOptions;
    finish: (code: number | null) => void;
    fail: (err: Error) => void;
    emit: EngineSpawnOptions["onEvent"];
  }> = [];
  readonly aborted: string[] = [];
  /** Set to throw synchronously out of spawn(). */
  throwOnSpawn: Error | null = null;

  constructor(readonly id: string) {}

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  spawn(opts: EngineSpawnOptions): Promise<number | null> {
    if (this.throwOnSpawn) throw this.throwOnSpawn;
    let finish!: (code: number | null) => void;
    let fail!: (err: Error) => void;
    const promise = new Promise<number | null>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    this.runs.push({ opts, finish, fail, emit: opts.onEvent });
    return promise;
  }

  abort(_state: EngineSessionState, sessionId: string): void {
    this.aborted.push(sessionId);
    // Real engines settle the spawn promise when the child dies.
    const run = this.runs.find((r) => r.opts.sessionId === sessionId);
    run?.finish(143);
  }
}

const PARENT = "parent-1";
const OTHER_PARENT = "parent-2";
const WORKING_DIR = path.resolve("/tmp/medusa-project");

let tmpDir: string;
let engine: FakeEngine;
let events: Array<{ sessionId: string; event: string; payload: any }>;

function parents(overrides: Partial<ParentSessionInfo> = {}) {
  const info: ParentSessionInfo = {
    workingDir: WORKING_DIR,
    engineId: "fake",
    model: "sonnet",
    yoloMode: false,
    ...overrides,
  };
  return (sessionId: string): ParentSessionInfo | null =>
    sessionId === PARENT || sessionId === OTHER_PARENT ? info : null;
}

function makeManager(opts: Partial<ConstructorParameters<typeof SubagentManager>[0]> = {}) {
  return new SubagentManager({
    getParent: parents(),
    getEngine: (id) => (id === "fake" ? engine : undefined),
    emit: (sessionId, event, payload) => events.push({ sessionId, event, payload }),
    maxTotal: 6,
    maxPerSession: 3,
    subagentsDir: tmpDir,
    ...opts,
  });
}

/** Lets the spawn promise's `.then` handlers run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-subagents-"));
  engine = new FakeEngine("fake");
  events = [];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("SubagentManager.spawn", () => {
  it("records the spawn, inherits engine/model/yolo and starts the engine", () => {
    const manager = makeManager({
      getParent: parents({ yoloMode: true, model: "opus", engineId: "fake" }),
    });
    const record = manager.spawn({
      parentSessionId: PARENT,
      task: "audit the socket events",
      name: "Audit",
    });

    expect(record.id).toMatch(/^sa_[0-9a-f]{12}$/);
    expect(record.status).toBe("running");
    expect(record.engineId).toBe("fake");
    expect(record.model).toBe("opus");
    expect(record.yolo).toBe(true);
    expect(record.cwd).toBe(WORKING_DIR);
    expect(engine.runs).toHaveLength(1);
    expect(engine.runs[0]!.opts.text).toBe("audit the socket events");
    expect(engine.runs[0]!.opts.yoloMode).toBe(true);
  });

  it("gives the subagent no medusa MCP server, so it cannot spawn subagents", () => {
    makeManager().spawn({ parentSessionId: PARENT, task: "go" });
    expect(engine.runs[0]!.opts.mcpConfig).toBeUndefined();
  });

  it("uses a UUID engine session id, since claude --session-id rejects sa_ ids", () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    expect(record.engineSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(engine.runs[0]!.opts.sessionId).toBe(record.engineSessionId);
  });

  it("lets an explicit engine and model override the parent's", () => {
    const other = new FakeEngine("other");
    const manager = makeManager({
      getEngine: (id) => (id === "fake" ? engine : id === "other" ? other : undefined),
    });
    const record = manager.spawn({
      parentSessionId: PARENT,
      task: "go",
      engine: "other",
      model: "k2",
    });
    expect(record.engineId).toBe("other");
    expect(record.model).toBe("k2");
    expect(other.runs).toHaveLength(1);
    expect(engine.runs).toHaveLength(0);
  });

  it("rejects an unknown parent, an empty task and an unknown engine", () => {
    const manager = makeManager();
    expect(() => manager.spawn({ parentSessionId: "nope", task: "go" })).toThrow(
      SubagentError
    );
    expect(() => manager.spawn({ parentSessionId: PARENT, task: "   " })).toThrow(
      /task is required/
    );
    expect(() =>
      manager.spawn({ parentSessionId: PARENT, task: "go", engine: "ghost" })
    ).toThrow(/Unknown engine/);
  });
});

describe("cwd containment", () => {
  it("accepts a subdirectory and resolves it absolutely", () => {
    const record = makeManager().spawn({
      parentSessionId: PARENT,
      task: "go",
      cwd: "server/src",
    });
    expect(record.cwd).toBe(path.join(WORKING_DIR, "server", "src"));
  });

  it("rejects a cwd outside the parent working dir", () => {
    const manager = makeManager();
    expect(() =>
      manager.spawn({ parentSessionId: PARENT, task: "go", cwd: "/etc" })
    ).toThrow(/escapes the chat's working directory/);
    expect(() =>
      manager.spawn({ parentSessionId: PARENT, task: "go", cwd: "../../etc" })
    ).toThrow(/escapes the chat's working directory/);
    expect(engine.runs).toHaveLength(0);
  });

  it("rejects a sibling directory that merely shares a name prefix", () => {
    const manager = makeManager();
    expect(() =>
      manager.spawn({ parentSessionId: PARENT, task: "go", cwd: "../medusa-project-evil" })
    ).toThrow(/escapes the chat's working directory/);
  });
});

describe("concurrency caps", () => {
  it("queues past the per-session cap rather than spawning", async () => {
    const manager = makeManager({ maxPerSession: 2, maxTotal: 10 });
    const a = manager.spawn({ parentSessionId: PARENT, task: "a" });
    const b = manager.spawn({ parentSessionId: PARENT, task: "b" });
    const c = manager.spawn({ parentSessionId: PARENT, task: "c" });

    expect([a.status, b.status, c.status]).toEqual(["running", "running", "queued"]);
    expect(engine.runs).toHaveLength(2);
    // A queued card gets no subagent:start until it actually starts.
    expect(events.filter((e) => e.event === "subagent:start")).toHaveLength(2);

    engine.runs[0]!.finish(0);
    await settle();

    expect(manager.get(c.id)!.status).toBe("running");
    expect(engine.runs).toHaveLength(3);
    expect(events.filter((e) => e.event === "subagent:start")).toHaveLength(3);
  });

  it("queues past the global cap across chats", async () => {
    const manager = makeManager({ maxPerSession: 3, maxTotal: 2 });
    manager.spawn({ parentSessionId: PARENT, task: "a" });
    manager.spawn({ parentSessionId: PARENT, task: "b" });
    const c = manager.spawn({ parentSessionId: OTHER_PARENT, task: "c" });

    expect(c.status).toBe("queued");
    expect(engine.runs).toHaveLength(2);

    engine.runs[1]!.finish(0);
    await settle();
    expect(manager.get(c.id)!.status).toBe("running");
  });

  it("starts queued work in FIFO order within a chat", async () => {
    const manager = makeManager({ maxPerSession: 1, maxTotal: 10 });
    manager.spawn({ parentSessionId: PARENT, task: "first" });
    const b = manager.spawn({ parentSessionId: PARENT, task: "second" });
    const c = manager.spawn({ parentSessionId: PARENT, task: "third" });

    engine.runs[0]!.finish(0);
    await settle();
    expect(manager.get(b.id)!.status).toBe("running");
    expect(manager.get(c.id)!.status).toBe("queued");

    engine.runs[1]!.finish(0);
    await settle();
    expect(manager.get(c.id)!.status).toBe("running");
  });

  it("does not let one capped chat block another chat's queue", () => {
    const manager = makeManager({ maxPerSession: 1, maxTotal: 10 });
    manager.spawn({ parentSessionId: PARENT, task: "a" });
    const blocked = manager.spawn({ parentSessionId: PARENT, task: "b" });
    const other = manager.spawn({ parentSessionId: OTHER_PARENT, task: "c" });

    expect(blocked.status).toBe("queued");
    expect(other.status).toBe("running");
  });
});

describe("streaming and completion", () => {
  it("emits start, delta, tool and end anchored to the parent tool_use id", async () => {
    const manager = makeManager();
    manager.registerSpawnToolUse(PARENT, "toolu_123", "survey the engine dir");
    const record = manager.spawn({
      parentSessionId: PARENT,
      task: "survey the engine dir",
    });
    expect(record.parentToolUseId).toBe("toolu_123");

    const run = engine.runs[0]!;
    run.emit({ kind: "delta", text: "looking..." });
    run.emit({ kind: "tool_use_start", toolId: "t1", toolName: "Read", input: {} });
    run.emit({ kind: "tool_result", toolUseId: "t1", content: "ok" });
    run.emit({
      kind: "result",
      success: true,
      result: "6 files",
      sessionId: record.engineSessionId,
      totalCostUsd: 0.12,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    run.finish(0);
    const finished = await manager.waitFor(record.id);

    expect(finished.status).toBe("done");
    expect(finished.resultText).toBe("6 files");
    expect(finished.truncated).toBe(false);
    expect(finished.toolCallCount).toBe(1);
    expect(finished.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0.12 });

    const names = events.map((e) => e.event);
    expect(names[0]).toBe("subagent:start");
    expect(names).toContain("subagent:delta");
    expect(names).toContain("subagent:tool");
    expect(names).toContain("subagent:event");
    expect(names[names.length - 1]).toBe("subagent:end");
    for (const e of events) {
      expect(e.sessionId).toBe(PARENT);
      expect(e.payload.parentToolUseId).toBe("toolu_123");
    }
  });

  it("falls back to the streamed text when the result carries none", async () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    engine.runs[0]!.emit({ kind: "delta", text: "partial answer" });
    engine.runs[0]!.finish(0);
    expect((await manager.waitFor(record.id)).resultText).toBe("partial answer");
  });

  it("truncates resultText over 24k and sets the flag", async () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    const huge = "x".repeat(RESULT_TEXT_LIMIT + 500);
    engine.runs[0]!.emit({
      kind: "result",
      success: true,
      result: huge,
      sessionId: record.engineSessionId,
    });
    engine.runs[0]!.finish(0);

    const finished = await manager.waitFor(record.id);
    expect(RESULT_TEXT_LIMIT).toBe(24_000);
    expect(finished.resultText).toHaveLength(RESULT_TEXT_LIMIT);
    expect(finished.truncated).toBe(true);
    // The full text is still reachable through the transcript.
    expect(fs.existsSync(finished.transcriptPath)).toBe(true);
    expect(fs.readFileSync(finished.transcriptPath, "utf-8")).toContain(huge);

    const end = events.find((e) => e.event === "subagent:end")!;
    expect(end.payload.truncated).toBe(true);
  });

  it("leaves text at exactly the limit untruncated", async () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    engine.runs[0]!.emit({
      kind: "result",
      success: true,
      result: "y".repeat(RESULT_TEXT_LIMIT),
      sessionId: record.engineSessionId,
    });
    engine.runs[0]!.finish(0);
    expect((await manager.waitFor(record.id)).truncated).toBe(false);
  });

  it("reports cost to the usage hook against the PARENT session", async () => {
    const logUsage = vi.fn();
    const manager = makeManager({ logUsage });
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    engine.runs[0]!.emit({
      kind: "result",
      success: true,
      sessionId: record.engineSessionId,
      totalCostUsd: 0.4,
      usage: { input_tokens: 9, output_tokens: 3 },
    });
    engine.runs[0]!.finish(0);
    await manager.waitFor(record.id);

    expect(logUsage).toHaveBeenCalledTimes(1);
    expect(logUsage.mock.calls[0]![0]).toMatchObject({
      sessionId: PARENT,
      agentId: record.id,
      role: "subagent",
      engineId: "fake",
      usage: { inputTokens: 9, outputTokens: 3, costUsd: 0.4 },
    });
  });
});

describe("the crash path", () => {
  it("turns a rejected spawn into status error and still emits subagent:end", async () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    engine.runs[0]!.fail(new Error("ENOENT: claude not found"));

    const finished = await manager.waitFor(record.id);
    expect(finished.status).toBe("error");
    expect(finished.error).toContain("ENOENT");
    expect(finished.endedAt).not.toBeNull();

    const end = events.find((e) => e.event === "subagent:end")!;
    expect(end.payload.status).toBe("error");
    expect(end.payload.error).toContain("ENOENT");
  });

  it("turns a non-zero exit into status error", async () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    engine.runs[0]!.finish(1);
    const finished = await manager.waitFor(record.id);
    expect(finished.status).toBe("error");
    expect(finished.error).toContain("exited with code 1");
  });

  it("treats a successful result event as done even on a non-zero exit", async () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    engine.runs[0]!.emit({
      kind: "result",
      success: true,
      result: "fine",
      sessionId: record.engineSessionId,
    });
    engine.runs[0]!.finish(3);
    expect((await manager.waitFor(record.id)).status).toBe("done");
  });

  it("survives a synchronous throw out of engine.spawn", async () => {
    engine.throwOnSpawn = new Error("boom");
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    const finished = await manager.waitFor(record.id);
    expect(finished.status).toBe("error");
    expect(finished.error).toBe("boom");
    expect(events.some((e) => e.event === "subagent:end")).toBe(true);
  });

  it("frees a slot for the queue when a subagent crashes", async () => {
    const manager = makeManager({ maxPerSession: 1 });
    manager.spawn({ parentSessionId: PARENT, task: "a" });
    const b = manager.spawn({ parentSessionId: PARENT, task: "b" });
    engine.runs[0]!.fail(new Error("boom"));
    await settle();
    expect(manager.get(b.id)!.status).toBe("running");
  });
});

describe("cancellation", () => {
  it("cancels a running subagent through the engine's abort", async () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    expect(manager.cancel(record.id)).toBe(true);
    expect(engine.aborted).toEqual([record.engineSessionId]);
    expect((await manager.waitFor(record.id)).status).toBe("cancelled");
  });

  it("cancels a queued subagent without ever spawning it", async () => {
    const manager = makeManager({ maxPerSession: 1 });
    manager.spawn({ parentSessionId: PARENT, task: "a" });
    const b = manager.spawn({ parentSessionId: PARENT, task: "b" });

    expect(b.status).toBe("queued");
    manager.cancel(b.id);
    expect((await manager.waitFor(b.id)).status).toBe("cancelled");
    expect(engine.runs).toHaveLength(1);
    // It must not be started later when the slot frees up.
    engine.runs[0]!.finish(0);
    await settle();
    expect(engine.runs).toHaveLength(1);
  });

  it("cancelForParent aborts every running and queued child of that chat only", async () => {
    const manager = makeManager({ maxPerSession: 2 });
    const a = manager.spawn({ parentSessionId: PARENT, task: "a" });
    const b = manager.spawn({ parentSessionId: PARENT, task: "b" });
    const queued = manager.spawn({ parentSessionId: PARENT, task: "c" });
    const other = manager.spawn({ parentSessionId: OTHER_PARENT, task: "d" });

    expect(manager.cancelForParent(PARENT)).toBe(3);
    await settle();

    expect(manager.get(a.id)!.status).toBe("cancelled");
    expect(manager.get(b.id)!.status).toBe("cancelled");
    expect(manager.get(queued.id)!.status).toBe("cancelled");
    expect(manager.get(other.id)!.status).toBe("running");
    expect(engine.aborted).toEqual([a.engineSessionId, b.engineSessionId]);
  });

  it("cancelAll stops every chat's subagents", async () => {
    const manager = makeManager();
    manager.spawn({ parentSessionId: PARENT, task: "a" });
    manager.spawn({ parentSessionId: OTHER_PARENT, task: "b" });
    expect(manager.cancelAll()).toBe(2);
    await settle();
    expect(manager.listForParent(PARENT)[0]!.status).toBe("cancelled");
    expect(manager.listForParent(OTHER_PARENT)[0]!.status).toBe("cancelled");
  });

  it("is a no-op for an unknown or already finished agent", async () => {
    const manager = makeManager();
    expect(manager.cancel("sa_nope")).toBe(false);
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    engine.runs[0]!.finish(0);
    await manager.waitFor(record.id);
    expect(manager.cancel(record.id)).toBe(false);
    expect(manager.get(record.id)!.status).toBe("done");
  });
});

describe("parent scoping", () => {
  it("never exposes another chat's subagent", () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    expect(manager.status(record.id, PARENT)).toBeDefined();
    expect(manager.status(record.id, OTHER_PARENT)).toBeUndefined();
    expect(manager.result(record.id, OTHER_PARENT)).toBeUndefined();
    expect(manager.getForParent(record.id, OTHER_PARENT)).toBeUndefined();
    expect(manager.listForParent(OTHER_PARENT)).toEqual([]);
  });

  it("list_agents returns the status shape for this chat only", () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go", name: "Survey" });
    manager.spawn({ parentSessionId: OTHER_PARENT, task: "other" });

    expect(manager.listForParent(PARENT)).toEqual([
      {
        agentId: record.id,
        name: "Survey",
        status: "running",
        engine: "fake",
        model: "sonnet",
        startedAt: record.startedAt,
        toolCallCount: 0,
        tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
    ]);
  });
});

describe("tool_use correlation", () => {
  it("matches on task text before falling back to the oldest block", () => {
    const manager = makeManager();
    manager.registerSpawnToolUse(PARENT, "toolu_a", "task A");
    manager.registerSpawnToolUse(PARENT, "toolu_b", "task B");

    expect(manager.spawn({ parentSessionId: PARENT, task: "task B" }).parentToolUseId).toBe(
      "toolu_b"
    );
    expect(manager.spawn({ parentSessionId: PARENT, task: "task A" }).parentToolUseId).toBe(
      "toolu_a"
    );
    // Nothing left to claim.
    expect(manager.spawn({ parentSessionId: PARENT, task: "task C" }).parentToolUseId).toBeNull();
  });

  it("prefers an explicit parentToolUseId and never claims another chat's block", () => {
    const manager = makeManager();
    manager.registerSpawnToolUse(OTHER_PARENT, "toolu_other", "go");
    const record = manager.spawn({
      parentSessionId: PARENT,
      task: "go",
      parentToolUseId: "toolu_explicit",
    });
    expect(record.parentToolUseId).toBe("toolu_explicit");
  });

  it("clears unclaimed blocks when the parent turn ends", () => {
    const manager = makeManager();
    manager.registerSpawnToolUse(PARENT, "toolu_a", "go");
    manager.clearSpawnToolUses(PARENT);
    expect(manager.spawn({ parentSessionId: PARENT, task: "go" }).parentToolUseId).toBeNull();
  });
});

describe("transcripts", () => {
  it("writes one JSONL line per event under the parent's folder", async () => {
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    engine.runs[0]!.emit({ kind: "delta", text: "one" });
    engine.runs[0]!.emit({ kind: "delta", text: "two" });
    engine.runs[0]!.finish(0);
    await manager.waitFor(record.id);

    expect(record.transcriptPath).toBe(path.join(tmpDir, PARENT, `${record.id}.jsonl`));
    const lines = fs
      .readFileSync(record.transcriptPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { ts: string; event: { kind: string } });
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.event.kind)).toEqual(["delta", "delta"]);
  });

  it("keeps running when the transcript cannot be written", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    const manager = makeManager();
    const record = manager.spawn({ parentSessionId: PARENT, task: "go" });
    engine.runs[0]!.emit({ kind: "delta", text: "still fine" });
    engine.runs[0]!.finish(0);
    expect((await manager.waitFor(record.id)).resultText).toBe("still fine");
  });
});
