import type {
  StreamEvent,
  ParsedEvent,
  SystemInit,
  ContentBlockStart,
  ContentBlockDelta,
  AssistantMessage,
  ResultEvent,
  TextDelta,
  ContentBlockToolUse,
  ContentBlockToolResult,
} from "./types.js";

/**
 * Incrementally parses NDJSON output from the Claude CLI streaming format.
 * Call `feed(chunk)` with raw stdout data; the parser buffers partial lines
 * and invokes `onEvent` for each successfully parsed event.
 */
export class StreamParser {
  private buffer: string = "";
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
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const raw = JSON.parse(trimmed) as StreamEvent;
        const parsed = this.translate(raw);
        if (parsed) {
          this.onEvent(parsed);
        }
      } catch {
        // Non-JSON lines (e.g. stderr leaking into stdout) are ignored
      }
    }
  }

  /**
   * Flush any remaining buffered content. Call this when the process exits
   * to handle a final line that was not newline-terminated.
   */
  flush(): void {
    if (this.buffer.trim()) {
      try {
        const raw = JSON.parse(this.buffer.trim()) as StreamEvent;
        const parsed = this.translate(raw);
        if (parsed) {
          this.onEvent(parsed);
        }
      } catch {
        // Ignore unparseable trailing content
      }
    }
    this.buffer = "";
  }

  /**
   * Translate a raw StreamEvent into the simplified ParsedEvent union.
   */
  private translate(raw: StreamEvent): ParsedEvent | null {
    switch (raw.type) {
      case "system": {
        const ev = raw as SystemInit;
        if (ev.subtype === "init") {
          return {
            kind: "init",
            sessionId: ev.session_id,
            model: ev.model,
            tools: ev.tools,
            cwd: ev.cwd,
          };
        }
        return null;
      }

      case "content_block_delta": {
        const ev = raw as ContentBlockDelta;
        if (ev.delta.type === "text_delta") {
          return {
            kind: "delta",
            text: (ev.delta as TextDelta).text,
          };
        }
        // input_json_delta events are ignored for now; tool input
        // arrives as a complete object in content_block_start
        return null;
      }

      case "content_block_start": {
        const ev = raw as ContentBlockStart;
        if (ev.content_block.type === "tool_use") {
          const block = ev.content_block as ContentBlockToolUse;
          return {
            kind: "tool_use_start",
            toolId: block.id,
            toolName: block.name,
            input: block.input,
          };
        }
        if (ev.content_block.type === "tool_result") {
          const block = ev.content_block as ContentBlockToolResult;
          return {
            kind: "tool_result",
            toolUseId: block.tool_use_id,
            content: block.content,
          };
        }
        return null;
      }

      case "assistant": {
        const ev = raw as AssistantMessage;
        return {
          kind: "assistant_complete",
          content: ev.message.content,
        };
      }

      case "result": {
        const ev = raw as ResultEvent;
        if (ev.subtype === "success") {
          return {
            kind: "result",
            success: true,
            result: ev.result,
            totalCostUsd: ev.total_cost_usd,
            durationMs: ev.duration_ms,
            sessionId: ev.session_id,
          };
        }
        return {
          kind: "result",
          success: false,
          error: ev.error,
          sessionId: ev.session_id,
        };
      }

      default:
        return null;
    }
  }
}
