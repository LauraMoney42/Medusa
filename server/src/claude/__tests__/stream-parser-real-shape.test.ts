import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { StreamParser } from "../stream-parser.js";
import type { ParsedEvent } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));

function collect(chunks: string[]): ParsedEvent[] {
  const parser = new StreamParser();
  const events: ParsedEvent[] = [];
  parser.onEvent = (e) => events.push(e);
  for (const chunk of chunks) parser.feed(chunk);
  parser.flush();
  return events;
}

/** Wrap a raw Anthropic API event the way --include-partial-messages does. */
function wrap(event: unknown, parentToolUseId: string | null = null): string {
  return JSON.stringify({
    type: "stream_event",
    event,
    session_id: "sess-1",
    parent_tool_use_id: parentToolUseId,
  });
}

describe("StreamParser: stream_event envelope", () => {
  it("unwraps a wrapped text delta", () => {
    const line = wrap({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi" },
    });
    expect(collect([line + "\n"])).toMatchObject([
      { kind: "delta", text: "Hi", parentToolUseId: null },
    ]);
  });

  it("emits a tool_input_delta for input_json_delta", () => {
    const line = wrap({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"a":' },
    });
    expect(collect([line + "\n"])).toMatchObject([
      { kind: "tool_input_delta", index: 1, partialJson: '{"a":' },
    ]);
  });

  it("ignores message_start, content_block_stop, message_delta and message_stop", () => {
    const lines = [
      wrap({ type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      wrap({ type: "content_block_stop", index: 0 }),
      wrap({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      wrap({ type: "message_stop" }),
    ];
    expect(collect([lines.join("\n") + "\n"])).toEqual([]);
  });

  it("does not emit a card for a streamed tool_use block with an empty input", () => {
    const line = wrap({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t9", name: "Read", input: {} },
    });
    expect(collect([line + "\n"])).toEqual([]);
  });

  it("carries parent_tool_use_id through", () => {
    const line = wrap(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } },
      "toolu_parent"
    );
    expect(collect([line + "\n"])[0]).toMatchObject({
      kind: "delta",
      parentToolUseId: "toolu_parent",
    });
  });
});

describe("StreamParser: assistant and user messages", () => {
  it("splits an assistant message into assistant_complete plus one card per tool_use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-6",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.json" } },
          { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "x" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
      },
      parent_tool_use_id: null,
      session_id: "sess-1",
    });
    const events = collect([line + "\n"]);
    expect(events.map((e) => e.kind)).toEqual([
      "assistant_complete",
      "tool_use_start",
      "tool_use_start",
    ]);
    expect(events[1]).toMatchObject({
      toolId: "t1",
      toolName: "Read",
      input: { file_path: "/a.json" },
    });
  });

  it("parses tool_result blocks out of a user message", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }],
      },
      parent_tool_use_id: null,
      session_id: "sess-1",
    });
    expect(collect([line + "\n"])).toMatchObject([
      { kind: "tool_result", toolUseId: "t1", content: "file body", isError: false },
    ]);
  });

  it("flattens an array-shaped tool_result and keeps is_error", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
            is_error: true,
          },
        ],
      },
    });
    expect(collect([line + "\n"])[0]).toMatchObject({
      kind: "tool_result",
      content: "line one\nline two",
      isError: true,
    });
  });

  it("ignores a subagent's opening plain-text user message", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "go do the thing" }] },
      parent_tool_use_id: "toolu_parent",
    });
    expect(collect([line + "\n"])).toEqual([]);
  });

  it("emits one card when a tool appears both as a stream_event and on the assistant message", () => {
    const started = wrap({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name: "Read", input: {} },
    });
    const completed = JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        model: "m",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }],
        stop_reason: "tool_use",
        stop_sequence: null,
      },
    });
    const events = collect([started + "\n" + completed + "\n"]);
    expect(events.filter((e) => e.kind === "tool_use_start")).toHaveLength(1);
  });
});

describe("StreamParser over the stream-tool-use fixture", () => {
  const fixture = readFileSync(join(here, "fixtures", "stream-tool-use.jsonl"), "utf-8");
  const events = collect([fixture]);

  it("streams text token by token", () => {
    const deltas = events.filter(
      (e): e is Extract<ParsedEvent, { kind: "delta" }> => e.kind === "delta"
    );
    expect(deltas).toHaveLength(4);
    expect(
      deltas
        .slice(0, 3)
        .map((d) => d.text)
        .join("")
    ).toBe("I'll read package.json.");
  });

  it("reports the session from system/init", () => {
    expect(events.find((e) => e.kind === "init")).toMatchObject({
      kind: "init",
      sessionId: "11111111-2222-3333-4444-555555555555",
      model: "claude-opus-4-6",
    });
  });

  it("extracts every tool_use exactly once, with its input", () => {
    const tools = events.filter(
      (e): e is Extract<ParsedEvent, { kind: "tool_use_start" }> =>
        e.kind === "tool_use_start"
    );
    expect(tools.map((t) => t.toolName)).toEqual(["Read", "Task", "Grep", "Read"]);
    expect(tools[0]).toMatchObject({
      toolId: "toolu_01ReadPackageJson",
      input: { file_path: "/tmp/fixture-repo/package.json" },
    });
  });

  it("pairs every tool_result with its call by id", () => {
    const tools = events.filter(
      (e): e is Extract<ParsedEvent, { kind: "tool_use_start" }> =>
        e.kind === "tool_use_start"
    );
    const results = events.filter(
      (e): e is Extract<ParsedEvent, { kind: "tool_result" }> => e.kind === "tool_result"
    );
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(tools.some((t) => t.toolId === result.toolUseId)).toBe(true);
    }
    expect(
      results.find((r) => r.toolUseId === "toolu_01ReadPackageJson")?.content
    ).toContain('"name": "medusa"');
  });

  it("flags the failed tool result and only that one", () => {
    expect(events.filter((e) => e.kind === "tool_result" && e.isError)).toMatchObject([
      { toolUseId: "toolu_01MissingFile", content: "File does not exist." },
    ]);
  });

  it("attributes subagent activity to the spawning Agent call", () => {
    const sub = events.filter(
      (e) =>
        (e.kind === "tool_use_start" || e.kind === "tool_result") &&
        e.parentToolUseId === "toolu_01SpawnAgent"
    );
    expect(sub.map((e) => e.kind)).toEqual(["tool_use_start", "tool_result"]);
  });

  it("keeps result usage, cost and session id", () => {
    expect(events.find((e) => e.kind === "result")).toMatchObject({
      kind: "result",
      success: true,
      totalCostUsd: 0.0412,
      numTurns: 4,
      sessionId: "11111111-2222-3333-4444-555555555555",
      usage: {
        input_tokens: 18,
        output_tokens: 233,
        cache_creation_input_tokens: 812,
        cache_read_input_tokens: 14210,
      },
    });
  });
});
