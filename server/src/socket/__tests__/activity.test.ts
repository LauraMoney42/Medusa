import { describe, it, expect } from "vitest";
import {
  ACTIVITY_DETAIL_LIMIT,
  activityFromParsedEvent,
  activityFromSubagentEvent,
  isSpawnAgentToolName,
  matchSubagentId,
  oneLine,
  truncateDetail,
} from "../activity.js";
import type { ParsedEvent } from "../../claude/types.js";

const SESSION = "sess_1";
const TS = "2026-09-17T12:00:00.000Z";

function map(event: ParsedEvent) {
  return activityFromParsedEvent(SESSION, event, TS);
}

describe("truncateDetail", () => {
  it("leaves short text alone", () => {
    expect(truncateDetail("hello")).toEqual({ detail: "hello", truncated: false });
  });

  it("keeps text exactly at the limit whole", () => {
    const text = "x".repeat(ACTIVITY_DETAIL_LIMIT);
    expect(truncateDetail(text)).toEqual({ detail: text, truncated: false });
  });

  it("clips past the limit and flags it", () => {
    const result = truncateDetail("y".repeat(ACTIVITY_DETAIL_LIMIT + 500));
    expect(result.truncated).toBe(true);
    expect(result.detail).toHaveLength(ACTIVITY_DETAIL_LIMIT);
  });
});

describe("oneLine", () => {
  it("collapses whitespace", () => {
    expect(oneLine("a\n  b\tc")).toBe("a b c");
  });

  it("clips long text with an ellipsis", () => {
    expect(oneLine("z".repeat(200))).toHaveLength(120);
    expect(oneLine("z".repeat(200)).endsWith("...")).toBe(true);
  });
});

describe("activityFromParsedEvent", () => {
  it("maps init with the model and full detail", () => {
    const [line] = map({
      kind: "init",
      sessionId: "claude_abc",
      model: "sonnet",
      tools: ["Read", "Bash"],
      cwd: "/repo",
    });
    expect(line.kind).toBe("init");
    expect(line.summary).toContain("sonnet");
    expect(line.detail).toContain("/repo");
    expect(line.sessionId).toBe(SESSION);
    expect(line.ts).toBe(TS);
  });

  it("maps a text delta", () => {
    const [line] = map({ kind: "delta", text: "hello there" });
    expect(line.kind).toBe("text");
    expect(line.summary).toBe("hello there");
  });

  it("drops an empty delta", () => {
    expect(map({ kind: "delta", text: "" })).toHaveLength(0);
  });

  it("maps tool_use_start with the input as detail", () => {
    const [line] = map({
      kind: "tool_use_start",
      toolId: "toolu_1",
      toolName: "Read",
      input: { file_path: "/a.ts" },
    });
    expect(line.kind).toBe("tool");
    expect(line.summary).toBe("Read (toolu_1)");
    expect(line.detail).toContain("/a.ts");
  });

  it("maps tool_input_delta to a summary-only line", () => {
    const [line] = map({ kind: "tool_input_delta", index: 2, partialJson: '{"a":1}' });
    expect(line.kind).toBe("tool_input");
    expect(line.summary).toBe("input #2 +7b");
    expect(line.detail).toBeUndefined();
  });

  it("maps tool_result and flags an error one", () => {
    const [ok] = map({ kind: "tool_result", toolUseId: "toolu_1", content: "done" });
    expect(ok.kind).toBe("tool_result");
    expect(ok.summary).toContain("result toolu_1");
    expect(ok.detail).toBe("done");

    const [bad] = map({
      kind: "tool_result",
      toolUseId: "toolu_2",
      content: "boom",
      isError: true,
    });
    expect(bad.summary).toContain("error toolu_2");
  });

  it("truncates an oversized tool_result detail", () => {
    const [line] = map({
      kind: "tool_result",
      toolUseId: "toolu_1",
      content: "q".repeat(ACTIVITY_DETAIL_LIMIT * 2),
    });
    expect(line.detailTruncated).toBe(true);
    expect(line.detail).toHaveLength(ACTIVITY_DETAIL_LIMIT);
  });

  it("emits a thinking line before the assistant line when thinking is present", () => {
    const lines = map({
      kind: "assistant_complete",
      content: [
        { type: "thinking", thinking: "let me consider the options" },
        { type: "text", text: "answer" },
      ],
    });
    expect(lines.map((l) => l.kind)).toEqual(["thinking", "assistant"]);
    expect(lines[0]!.detail).toBe("let me consider the options");
    expect(lines[1]!.summary).toContain("2 blocks");
  });

  it("emits only the assistant line when there is no thinking", () => {
    const lines = map({
      kind: "assistant_complete",
      content: [{ type: "text", text: "answer" }],
    });
    expect(lines.map((l) => l.kind)).toEqual(["assistant"]);
    expect(lines[0]!.summary).toContain("1 block");
  });

  it("maps result with usage tokens and cost", () => {
    const [line] = map({
      kind: "result",
      success: true,
      result: "all done",
      totalCostUsd: 0.42,
      durationMs: 2500,
      numTurns: 3,
      sessionId: "claude_abc",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 7,
      },
    });
    expect(line.kind).toBe("result");
    expect(line.summary).toBe("turn success · 2.5s · 3 turns");
    expect(line.tokens).toMatchObject({ input: 100, output: 20, cacheRead: 7, costUsd: 0.42 });
    expect(line.detail).toBe("all done");
  });

  it("maps a failed result with the error as detail", () => {
    const [line] = map({
      kind: "result",
      success: false,
      error: "exited 1",
      sessionId: "claude_abc",
    });
    expect(line.summary).toContain("failed");
    expect(line.detail).toBe("exited 1");
  });

  it("maps error", () => {
    const [line] = map({ kind: "error", message: "Not logged in" });
    expect(line.kind).toBe("error");
    expect(line.summary).toBe("Not logged in");
    expect(line.detail).toBe("Not logged in");
  });

  it("carries parentToolUseId through", () => {
    const [line] = map({ kind: "delta", text: "sub text", parentToolUseId: "toolu_9" });
    expect(line.parentToolUseId).toBe("toolu_9");
  });

  it("covers every ParsedEvent kind", () => {
    const kinds: ParsedEvent["kind"][] = [
      "init",
      "delta",
      "tool_use_start",
      "tool_input_delta",
      "tool_result",
      "assistant_complete",
      "result",
      "error",
    ];
    const samples: ParsedEvent[] = [
      { kind: "init", sessionId: "s", model: "m", tools: [], cwd: "/" },
      { kind: "delta", text: "t" },
      { kind: "tool_use_start", toolId: "t1", toolName: "Read", input: {} },
      { kind: "tool_input_delta", index: 0, partialJson: "{}" },
      { kind: "tool_result", toolUseId: "t1", content: "c" },
      { kind: "assistant_complete", content: [{ type: "text", text: "x" }] },
      { kind: "result", success: true, sessionId: "s" },
      { kind: "error", message: "e" },
    ];
    expect(samples.map((s) => s.kind)).toEqual(kinds);
    for (const sample of samples) {
      expect(map(sample).length).toBeGreaterThan(0);
    }
  });
});

describe("activityFromSubagentEvent", () => {
  const base = { sessionId: SESSION, agentId: "sa_abc", parentToolUseId: "toolu_1" };

  it("maps subagent:start with engine and model", () => {
    const [line] = activityFromSubagentEvent(
      "subagent:start",
      { ...base, name: "Audit", task: "audit the socket events", engineId: "kimi", model: "k2" },
      TS
    );
    expect(line.kind).toBe("subagent_start");
    expect(line.summary).toBe("Audit started · kimi/k2");
    expect(line.detail).toBe("audit the socket events");
    expect(line.subagentId).toBe("sa_abc");
  });

  it("maps subagent:delta", () => {
    const [line] = activityFromSubagentEvent("subagent:delta", { ...base, delta: "hi" }, TS);
    expect(line.kind).toBe("subagent_text");
    expect(line.summary).toBe("hi");
  });

  it("maps a subagent tool call and a tool result", () => {
    const [call] = activityFromSubagentEvent(
      "subagent:tool",
      { ...base, name: "Audit", tool: { id: "t1", name: "Grep", input: { pattern: "io" } } },
      TS
    );
    expect(call.kind).toBe("subagent_tool");
    expect(call.summary).toBe("Audit · Grep");

    const [result] = activityFromSubagentEvent(
      "subagent:tool",
      { ...base, name: "Audit", toolResult: { toolUseId: "t1", output: "abc", isError: false } },
      TS
    );
    expect(result.kind).toBe("subagent_tool_result");
    expect(result.detail).toBe("abc");
  });

  it("maps subagent:end with usage", () => {
    const [line] = activityFromSubagentEvent(
      "subagent:end",
      {
        ...base,
        name: "Audit",
        status: "done",
        durationMs: 41000,
        resultText: "found 3",
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      },
      TS
    );
    expect(line.summary).toBe("Audit done · 41.0s");
    expect(line.tokens).toMatchObject({ input: 10, output: 5, costUsd: 0.01 });
    expect(line.detail).toBe("found 3");
  });

  it("ignores the raw subagent:event passthrough", () => {
    expect(
      activityFromSubagentEvent("subagent:event", { ...base, delta: "x" }, TS)
    ).toHaveLength(0);
  });

  it("ignores a payload with no sessionId", () => {
    expect(activityFromSubagentEvent("subagent:start", { agentId: "sa_x" }, TS)).toHaveLength(0);
  });
});

describe("spawn_agent correlation", () => {
  it("recognizes both tool name spellings", () => {
    expect(isSpawnAgentToolName("spawn_agent")).toBe(true);
    expect(isSpawnAgentToolName("mcp__medusa__spawn_agent")).toBe(true);
    expect(isSpawnAgentToolName("Task")).toBe(false);
    expect(isSpawnAgentToolName("spawn_agent_v2")).toBe(false);
  });

  it("matches on an exact parentToolUseId", () => {
    const anchors = [
      { agentId: "sa_1", parentToolUseId: "toolu_a" },
      { agentId: "sa_2", parentToolUseId: "toolu_b" },
    ];
    expect(matchSubagentId(anchors, "toolu_b")).toBe("sa_2");
  });

  it("falls back to the oldest unanchored subagent", () => {
    const anchors = [
      { agentId: "sa_1", parentToolUseId: "toolu_a" },
      { agentId: "sa_2", parentToolUseId: null },
      { agentId: "sa_3", parentToolUseId: null },
    ];
    expect(matchSubagentId(anchors, "toolu_zzz")).toBe("sa_2");
  });

  it("returns null with no candidates or no tool id", () => {
    expect(matchSubagentId([], "toolu_a")).toBeNull();
    expect(matchSubagentId([{ agentId: "sa_1", parentToolUseId: "toolu_a" }], undefined)).toBeNull();
    expect(matchSubagentId([{ agentId: "sa_1", parentToolUseId: "toolu_a" }], "toolu_z")).toBeNull();
  });
});
