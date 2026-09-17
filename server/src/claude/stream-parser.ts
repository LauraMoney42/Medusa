import type {
  StreamEvent,
  StreamEventEnvelope,
  RawApiEvent,
  ParsedEvent,
  SystemInit,
  ContentBlock,
  ContentBlockStart,
  ContentBlockDelta,
  AssistantMessage,
  UserMessage,
  ResultEvent,
  TextDelta,
  InputJsonDelta,
  ContentBlockToolUse,
  ContentBlockToolResult,
} from "./types.js";

/**
 * Flatten a tool_result's `content`, which the CLI sends either as a plain
 * string or as an array of content blocks (structured tool output).
 */
function flattenResultContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      // Images and other non-text blocks have no useful string form; name them
      // so the UI shows something rather than an empty card.
      return `[${block.type}]`;
    })
    .join("\n");
}

/**
 * Incrementally parses NDJSON output from the Claude CLI streaming format.
 * Call `feed(chunk)` with raw stdout data; the parser buffers partial lines
 * and invokes `onEvent` for each successfully parsed event.
 *
 * One raw line can yield several parsed events: an `assistant` message with a
 * text block and two `tool_use` blocks becomes one `assistant_complete` plus
 * two `tool_use_start` events.
 */
export class StreamParser {
  private buffer: string = "";
  /**
   * Tool-use ids already surfaced, so a tool that appears both as a streamed
   * `content_block_start` and again on the completed `assistant` message
   * produces one card, not two.
   */
  private emittedToolIds = new Set<string>();
  public onEvent: (event: ParsedEvent) => void = () => {};

  /**
   * Feed a raw string chunk (may contain zero, one, or many newline-delimited
   * JSON objects, and may end with an incomplete line).
   */
  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");

    // The last element is either an empty string (if chunk ended with \n)
    // or an incomplete line that we keep in the buffer.
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      this.consumeLine(line);
    }
  }

  /**
   * Flush any remaining buffered content. Call this when the process exits
   * to handle a final line that was not newline-terminated.
   */
  flush(): void {
    if (this.buffer.trim()) {
      this.consumeLine(this.buffer);
    }
    this.buffer = "";
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Fixture files carry `#` header comments; real CLI output never does.
    if (trimmed.startsWith("#")) return;

    let raw: StreamEvent;
    try {
      raw = JSON.parse(trimmed) as StreamEvent;
    } catch {
      // Non-JSON lines (e.g. stderr leaking into stdout) are ignored
      return;
    }

    for (const parsed of this.translate(raw)) {
      this.onEvent(parsed);
    }
  }

  /**
   * Translate a raw StreamEvent into zero or more ParsedEvents.
   */
  private translate(raw: StreamEvent): ParsedEvent[] {
    switch (raw.type) {
      case "system": {
        const ev = raw as SystemInit;
        if (ev.subtype === "init") {
          return [
            {
              kind: "init",
              sessionId: ev.session_id,
              model: ev.model,
              tools: ev.tools,
              cwd: ev.cwd,
            },
          ];
        }
        return [];
      }

      // The real shape: partial-message events arrive wrapped in an envelope
      // that also carries the subagent attribution.
      case "stream_event": {
        const ev = raw as StreamEventEnvelope;
        if (!ev.event) return [];
        return this.translateApiEvent(ev.event, ev.parent_tool_use_id ?? null);
      }

      // Legacy/flat shapes. The CLI does not emit these at the top level, but
      // recorded fixtures and the existing tests do, so keep handling them.
      case "content_block_delta":
      case "content_block_start":
      case "content_block_stop":
        return this.translateApiEvent(raw as RawApiEvent, null);

      case "assistant": {
        const ev = raw as AssistantMessage;
        const parentToolUseId = ev.parent_tool_use_id ?? null;
        const content = ev.message?.content ?? [];
        const out: ParsedEvent[] = [
          { kind: "assistant_complete", content, parentToolUseId },
        ];
        // tool_use blocks only ever arrive complete on the assistant message
        // (the streamed input_json_delta chunks are a preview, not the truth),
        // so this is where tool cards get their input.
        for (const block of content) {
          if (block.type === "tool_use") {
            const tu = block as ContentBlockToolUse;
            if (this.emittedToolIds.has(tu.id)) continue;
            this.emittedToolIds.add(tu.id);
            out.push({
              kind: "tool_use_start",
              toolId: tu.id,
              toolName: tu.name,
              input: tu.input ?? {},
              parentToolUseId,
            });
          }
        }
        return out;
      }

      case "user": {
        const ev = raw as UserMessage;
        const parentToolUseId = ev.parent_tool_use_id ?? null;
        const content = ev.message?.content;
        if (!Array.isArray(content)) return [];
        const out: ParsedEvent[] = [];
        for (const block of content) {
          if (block.type === "tool_result") {
            const tr = block as ContentBlockToolResult;
            out.push({
              kind: "tool_result",
              toolUseId: tr.tool_use_id,
              content: flattenResultContent(tr.content),
              isError: tr.is_error === true,
              parentToolUseId,
            });
          }
        }
        // A subagent's opening prompt is a plain-text user message; it carries
        // no tool result and is intentionally not surfaced as chat text.
        return out;
      }

      case "result": {
        const ev = raw as ResultEvent;
        if (ev.subtype === "success") {
          return [
            {
              kind: "result",
              success: true,
              result: ev.result,
              totalCostUsd: ev.total_cost_usd,
              durationMs: ev.duration_ms,
              durationApiMs: ev.duration_api_ms,
              numTurns: ev.num_turns,
              sessionId: ev.session_id,
              usage: ev.usage,
            },
          ];
        }
        return [
          {
            kind: "result",
            success: false,
            error: ev.error,
            sessionId: ev.session_id,
          },
        ];
      }

      default:
        return [];
    }
  }

  /**
   * Translate one raw Anthropic API event (unwrapped from `stream_event`).
   */
  private translateApiEvent(
    event: RawApiEvent,
    parentToolUseId: string | null
  ): ParsedEvent[] {
    switch (event.type) {
      case "content_block_delta": {
        const ev = event as ContentBlockDelta;
        if (ev.delta?.type === "text_delta") {
          return [
            {
              kind: "delta",
              text: (ev.delta as TextDelta).text,
              parentToolUseId,
            },
          ];
        }
        if (ev.delta?.type === "input_json_delta") {
          return [
            {
              kind: "tool_input_delta",
              index: ev.index,
              partialJson: (ev.delta as InputJsonDelta).partial_json,
              parentToolUseId,
            },
          ];
        }
        // thinking_delta is not surfaced yet
        return [];
      }

      case "content_block_start": {
        const ev = event as ContentBlockStart;
        const block = ev.content_block;
        if (!block) return [];
        if (block.type === "tool_use") {
          const tu = block as ContentBlockToolUse;
          // A streamed tool_use block starts with an empty input that the
          // following input_json_delta chunks fill in. Emitting it now would
          // show a card with no input and duplicate the one the completed
          // `assistant` message produces, so wait for that message instead.
          const hasInput =
            tu.input != null && Object.keys(tu.input).length > 0;
          if (!hasInput || this.emittedToolIds.has(tu.id)) return [];
          this.emittedToolIds.add(tu.id);
          return [
            {
              kind: "tool_use_start",
              toolId: tu.id,
              toolName: tu.name,
              input: tu.input,
              parentToolUseId,
            },
          ];
        }
        if (block.type === "tool_result") {
          const tr = block as ContentBlockToolResult;
          return [
            {
              kind: "tool_result",
              toolUseId: tr.tool_use_id,
              content: flattenResultContent(tr.content),
              isError: tr.is_error === true,
              parentToolUseId,
            },
          ];
        }
        return [];
      }

      default:
        // message_start / message_delta / message_stop / content_block_stop
        // carry nothing the UI needs yet.
        return [];
    }
  }
}
