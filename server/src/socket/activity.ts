import type { ContentBlock, ParsedEvent } from "../claude/types.js";

/**
 * The Activity Log data path (UI addendum, "Activity Log").
 *
 * Everything in this file is pure: `ParsedEvent` (or a subagent socket
 * payload) in, zero or more `ActivityEvent`s out. The socket handler does the
 * emitting; keeping the mapping pure is what makes it unit-testable and what
 * keeps the handler from growing another 200-line switch.
 */

/** Kinds the panel renders as badges. One per line in the log. */
export type ActivityKind =
  | "init"
  | "text"
  | "thinking"
  | "tool"
  | "tool_input"
  | "tool_result"
  | "assistant"
  | "result"
  | "error"
  | "subagent_start"
  | "subagent_text"
  | "subagent_tool"
  | "subagent_tool_result"
  | "subagent_end"
  | "warning";

/**
 * Details longer than this are clipped before they hit the wire. The Activity
 * Log is a debugging surface, not a transcript store: a single 4 MB tool
 * result must not be broadcast to every open tab.
 */
export const ACTIVITY_DETAIL_LIMIT = 8_000;

export interface ActivityTokens {
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  costUsd?: number;
}

export interface ActivityEvent {
  sessionId: string;
  /** ISO-8601. */
  ts: string;
  kind: ActivityKind;
  /** One line, already short enough to render without wrapping. */
  summary: string;
  /** The expandable body. Absent when there is nothing more to show. */
  detail?: string;
  /** True when `detail` was clipped at ACTIVITY_DETAIL_LIMIT. */
  detailTruncated?: boolean;
  tokens?: ActivityTokens;
  /** Set on every `subagent_*` line. */
  subagentId?: string;
  /** The parent's `spawn_agent` tool_use block, when one is correlated. */
  parentToolUseId?: string | null;
}

/** Clip `text` to the detail limit, reporting whether anything was dropped. */
export function truncateDetail(text: string): {
  detail: string;
  truncated: boolean;
} {
  if (text.length <= ACTIVITY_DETAIL_LIMIT) {
    return { detail: text, truncated: false };
  }
  return { detail: text.slice(0, ACTIVITY_DETAIL_LIMIT), truncated: true };
}

/** Collapse whitespace and clip, for the single-line summary column. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 3))}...`;
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function withDetail(
  base: ActivityEvent,
  rawDetail: string | undefined
): ActivityEvent {
  if (!rawDetail) return base;
  const { detail, truncated } = truncateDetail(rawDetail);
  return truncated ? { ...base, detail, detailTruncated: true } : { ...base, detail };
}

// -- spawn_agent correlation ------------------------------------------------

/**
 * Both spellings reach the parent stream: engines that mount the Medusa MCP
 * server namespace the tool (`mcp__medusa__spawn_agent`), the shim's own
 * in-process path does not.
 */
export function isSpawnAgentToolName(name: string): boolean {
  return name === "spawn_agent" || name === "mcp__medusa__spawn_agent";
}

/** The minimum a subagent record needs for the card to find its tool block. */
export interface SubagentAnchor {
  agentId: string;
  parentToolUseId?: string | null;
}

/**
 * Match a parent `spawn_agent` tool_use block to the subagent it started.
 *
 * The server correlates the two in `SubagentManager.registerSpawnToolUse`, so
 * the anchor is usually an exact `parentToolUseId` hit. The fallback exists
 * because a subagent spawned before its tool_use block was seen (a fast shim
 * call, or a `wait:false` spawn collected later) carries a null anchor: the
 * oldest unanchored subagent is then the right card for the oldest unmatched
 * block, which is the same FIFO rule the manager uses.
 */
export function matchSubagentId(
  anchors: SubagentAnchor[],
  toolUseId: string | undefined | null
): string | null {
  if (!toolUseId) return null;
  const exact = anchors.find((a) => a.parentToolUseId === toolUseId);
  if (exact) return exact.agentId;
  const unanchored = anchors.find(
    (a) => a.parentToolUseId == null || a.parentToolUseId === ""
  );
  return unanchored?.agentId ?? null;
}

// -- ParsedEvent -> ActivityEvent -------------------------------------------

function thinkingActivity(
  sessionId: string,
  ts: string,
  content: ContentBlock[],
  parentToolUseId: string | null | undefined
): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const block of content) {
    if (block.type !== "thinking" || !block.thinking) continue;
    out.push(
      withDetail(
        {
          sessionId,
          ts,
          kind: "thinking",
          summary: oneLine(block.thinking),
          parentToolUseId: parentToolUseId ?? null,
        },
        block.thinking
      )
    );
  }
  return out;
}

/**
 * Map one parsed stream event to the lines the Activity Log should show.
 *
 * Returns an array because a single `assistant_complete` can produce both a
 * thinking line and a summary line, and because some kinds map to nothing.
 */
export function activityFromParsedEvent(
  sessionId: string,
  event: ParsedEvent,
  ts: string
): ActivityEvent[] {
  const parentToolUseId = event.parentToolUseId ?? null;
  const base = { sessionId, ts, parentToolUseId };

  switch (event.kind) {
    case "init":
      return [
        withDetail(
          {
            ...base,
            kind: "init",
            summary: `session started · ${event.model}`,
          },
          stringify({
            sessionId: event.sessionId,
            model: event.model,
            cwd: event.cwd,
            tools: event.tools,
          })
        ),
      ];

    case "delta":
      if (!event.text) return [];
      return [
        {
          ...base,
          kind: "text",
          summary: oneLine(event.text),
        },
      ];

    case "tool_use_start":
      return [
        withDetail(
          {
            ...base,
            kind: "tool",
            summary: `${event.toolName} (${event.toolId})`,
          },
          stringify(event.input)
        ),
      ];

    case "tool_input_delta":
      // Summary only: the completed tool_use carries the whole input, so the
      // partial JSON is noise unless someone is watching the stream live.
      return [
        {
          ...base,
          kind: "tool_input",
          summary: `input #${event.index} +${event.partialJson.length}b`,
        },
      ];

    case "tool_result":
      return [
        withDetail(
          {
            ...base,
            kind: "tool_result",
            summary: `${event.isError ? "error" : "result"} ${event.toolUseId} · ${
              event.content.length
            }b`,
          },
          event.content
        ),
      ];

    case "assistant_complete": {
      const lines = thinkingActivity(sessionId, ts, event.content, parentToolUseId);
      const kinds = event.content.map((b) => b.type).join(", ");
      lines.push(
        withDetail(
          {
            ...base,
            kind: "assistant",
            summary: `assistant message · ${event.content.length} block${
              event.content.length === 1 ? "" : "s"
            }${kinds ? ` (${kinds})` : ""}`,
          },
          stringify(event.content)
        )
      );
      return lines;
    }

    case "result": {
      const tokens: ActivityTokens = {
        input: event.usage?.input_tokens,
        output: event.usage?.output_tokens,
        cacheCreation: event.usage?.cache_creation_input_tokens,
        cacheRead: event.usage?.cache_read_input_tokens,
        costUsd: event.totalCostUsd,
      };
      const parts = [event.success ? "success" : "failed"];
      if (event.durationMs != null) parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
      if (event.numTurns != null) parts.push(`${event.numTurns} turns`);
      return [
        withDetail(
          {
            ...base,
            kind: "result",
            summary: `turn ${parts.join(" · ")}`,
            tokens,
          },
          event.success ? event.result : event.error
        ),
      ];
    }

    case "error":
      return [
        withDetail(
          { ...base, kind: "error", summary: oneLine(event.message) },
          event.message
        ),
      ];

    default:
      return [];
  }
}

// -- subagent socket payload -> ActivityEvent -------------------------------

/** The subset of each `subagent:*` payload this mapping reads. */
export interface SubagentActivityPayload {
  sessionId?: string;
  agentId?: string;
  parentToolUseId?: string | null;
  name?: string;
  task?: string;
  engineId?: string;
  model?: string | null;
  cwd?: string;
  delta?: string;
  tool?: { id?: string; name?: string; input?: unknown };
  toolResult?: { toolUseId?: string; output?: string; isError?: boolean };
  status?: string;
  resultText?: string;
  durationMs?: number;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/**
 * Map a `subagent:*` socket emission to an Activity Log line. `subagent:event`
 * is deliberately ignored: it is the raw passthrough of the same ParsedEvent
 * the narrow `subagent:delta` / `subagent:tool` events already carry, so
 * mapping it too would double every subagent line.
 */
export function activityFromSubagentEvent(
  eventName: string,
  payload: SubagentActivityPayload,
  ts: string
): ActivityEvent[] {
  const sessionId = payload.sessionId;
  if (!sessionId) return [];
  const base = {
    sessionId,
    ts,
    subagentId: payload.agentId,
    parentToolUseId: payload.parentToolUseId ?? null,
  };
  const label = payload.name || payload.agentId || "subagent";

  switch (eventName) {
    case "subagent:start":
      return [
        withDetail(
          {
            ...base,
            kind: "subagent_start",
            summary: `${label} started · ${payload.engineId ?? "?"}/${
              payload.model ?? "default"
            }`,
          },
          payload.task
        ),
      ];

    case "subagent:delta":
      if (!payload.delta) return [];
      return [
        { ...base, kind: "subagent_text", summary: oneLine(payload.delta) },
      ];

    case "subagent:tool":
      if (payload.tool) {
        return [
          withDetail(
            {
              ...base,
              kind: "subagent_tool",
              summary: `${label} · ${payload.tool.name ?? "tool"}`,
            },
            stringify(payload.tool.input)
          ),
        ];
      }
      if (payload.toolResult) {
        const output = payload.toolResult.output ?? "";
        return [
          withDetail(
            {
              ...base,
              kind: "subagent_tool_result",
              summary: `${label} · ${
                payload.toolResult.isError ? "error" : "result"
              } ${payload.toolResult.toolUseId ?? ""} · ${output.length}b`,
            },
            output
          ),
        ];
      }
      return [];

    case "subagent:end": {
      const seconds =
        payload.durationMs != null ? ` · ${(payload.durationMs / 1000).toFixed(1)}s` : "";
      return [
        withDetail(
          {
            ...base,
            kind: "subagent_end",
            summary: `${label} ${payload.status ?? "ended"}${seconds}`,
            tokens: {
              input: payload.usage?.inputTokens,
              output: payload.usage?.outputTokens,
              costUsd: payload.usage?.costUsd,
            },
          },
          payload.error ?? payload.resultText
        ),
      ];
    }

    default:
      return [];
  }
}
