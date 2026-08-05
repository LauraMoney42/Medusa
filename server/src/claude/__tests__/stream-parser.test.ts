import { describe, it, expect, vi } from "vitest";
import { StreamParser } from "../stream-parser.js";
import type { ParsedEvent } from "../types.js";

/**
 * Helper: collect every event a parser emits for the given raw NDJSON chunks.
 */
function collect(chunks: string[]): ParsedEvent[] {
  const parser = new StreamParser();
  const events: ParsedEvent[] = [];
  parser.onEvent = (e) => events.push(e);
  for (const chunk of chunks) parser.feed(chunk);
  parser.flush();
  return events;
}

const initLine = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  model: "claude-sonnet",
  tools: ["Read", "Edit"],
  cwd: "/work",
});

const textDeltaLine = JSON.stringify({
  type: "content_block_delta",
  delta: { type: "text_delta", text: "Hello" },
});

describe("StreamParser.feed", () => {
  it("parses a single complete NDJSON line", () => {
    const events = collect([initLine + "\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "init",
      sessionId: "sess-1",
      model: "claude-sonnet",
      tools: ["Read", "Edit"],
      cwd: "/work",
    });
  });

  it("reassembles a JSON object split across multiple chunks", () => {
    const mid = Math.floor(textDeltaLine.length / 2);
    const events = collect([textDeltaLine.slice(0, mid), textDeltaLine.slice(mid) + "\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "delta", text: "Hello" });
  });

  it("parses multiple newline-delimited objects in one chunk", () => {
    const events = collect([initLine + "\n" + textDeltaLine + "\n"]);
    expect(events.map((e) => e.kind)).toEqual(["init", "delta"]);
  });

  it("ignores non-JSON lines (e.g. stderr leaking into stdout)", () => {
    const events = collect(["not json at all\n" + textDeltaLine + "\n"]);
    expect(events).toEqual([{ kind: "delta", text: "Hello" }]);
  });

  it("ignores blank and whitespace-only lines", () => {
    const events = collect(["\n   \n" + initLine + "\n"]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("init");
  });

  it("does not emit for a non-init system event", () => {
    const line = JSON.stringify({ type: "system", subtype: "other" });
    expect(collect([line + "\n"])).toEqual([]);
  });
});

describe("StreamParser.flush", () => {
  it("emits a final line that was not newline-terminated", () => {
    const parser = new StreamParser();
    const events: ParsedEvent[] = [];
    parser.onEvent = (e) => events.push(e);
    parser.feed(initLine); // no trailing newline
    expect(events).toHaveLength(0); // still buffered
    parser.flush();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("init");
  });

  it("is a no-op when the buffer is empty", () => {
    const parser = new StreamParser();
    const onEvent = vi.fn();
    parser.onEvent = onEvent;
    parser.flush();
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("StreamParser.translate event kinds", () => {
  it("maps a tool_use content block", () => {
    const line = JSON.stringify({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "t1", name: "Edit", input: { path: "a.ts" } },
    });
    expect(collect([line + "\n"])[0]).toEqual({
      kind: "tool_use_start",
      toolId: "t1",
      toolName: "Edit",
      input: { path: "a.ts" },
    });
  });

  it("maps a tool_result content block", () => {
    const line = JSON.stringify({
      type: "content_block_start",
      content_block: { type: "tool_result", tool_use_id: "t1", content: "ok" },
    });
    expect(collect([line + "\n"])[0]).toEqual({
      kind: "tool_result",
      toolUseId: "t1",
      content: "ok",
    });
  });

  it("maps a successful result event with usage/cost", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.12,
      duration_ms: 900,
      duration_api_ms: 700,
      num_turns: 3,
      session_id: "sess-1",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(collect([line + "\n"])[0]).toMatchObject({
      kind: "result",
      success: true,
      result: "done",
      totalCostUsd: 0.12,
      numTurns: 3,
    });
  });

  it("maps a failed result event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      error: "boom",
      session_id: "sess-1",
    });
    expect(collect([line + "\n"])[0]).toMatchObject({
      kind: "result",
      success: false,
      error: "boom",
    });
  });

  it("ignores an unknown top-level event type", () => {
    expect(collect([JSON.stringify({ type: "mystery" }) + "\n"])).toEqual([]);
  });
});
