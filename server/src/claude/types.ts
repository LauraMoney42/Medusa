// -------------------------------------------------------
// Raw NDJSON types emitted by:
//   claude -p --output-format stream-json --verbose --include-partial-messages
//
// The CLI does NOT emit `content_block_delta` / `content_block_start` at the
// top level. Those are raw Anthropic API events and arrive wrapped:
//   {"type":"stream_event","event":{...},"parent_tool_use_id":null,...}
// The top-level shapes below are still declared (and still handled by the
// parser) because older recorded fixtures and tests use them.
// -------------------------------------------------------

export interface SystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd: string;
  model: string;
  tools: string[];
  /** Present on real CLI output; carried through for future use. */
  permissionMode?: string;
  apiKeySource?: string;
  claude_code_version?: string;
  mcp_servers?: { name: string; status: string }[];
  uuid?: string;
}

export interface ContentBlockText {
  type: "text";
  text: string;
}

export interface ContentBlockThinking {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A tool result as it appears inside a `type:"user"` message. `content` is a
 * plain string for most tools and an array of content blocks for tools that
 * return structured output (images, multiple text blocks).
 */
export interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockThinking
  | ContentBlockToolUse
  | ContentBlockToolResult;

export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}

export interface ThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}

export type BlockDelta = TextDelta | InputJsonDelta | ThinkingDelta;

export interface ContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}

export interface ContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta: BlockDelta;
}

export interface ContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface MessageStartEvent {
  type: "message_start";
  message: {
    id: string;
    role: "assistant";
    model?: string;
    content: ContentBlock[];
    usage?: UsageInfo;
  };
}

export interface MessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason?: string | null; stop_sequence?: string | null };
  usage?: Partial<UsageInfo>;
}

export interface MessageStopEvent {
  type: "message_stop";
}

/** The raw Anthropic API events that ride inside a `stream_event` envelope. */
export type RawApiEvent =
  | MessageStartEvent
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | MessageDeltaEvent
  | MessageStopEvent;

/**
 * The envelope the CLI emits for every partial-message event when
 * `--include-partial-messages` is passed.
 */
export interface StreamEventEnvelope {
  type: "stream_event";
  event: RawApiEvent;
  session_id?: string;
  /** null on the main conversation; the Agent tool call id for a subagent. */
  parent_tool_use_id?: string | null;
  user_message_uuid?: string;
  uuid?: string;
}

export interface AssistantMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: ContentBlock[];
    model: string;
    stop_reason: string | null;
    stop_sequence: string | null;
    usage?: UsageInfo;
  };
  session_id?: string;
  parent_tool_use_id?: string | null;
}

/**
 * How tool results actually reach the stream, and how a foreground subagent's
 * opening prompt arrives.
 */
export interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: ContentBlock[] | string;
  };
  session_id?: string;
  parent_tool_use_id?: string | null;
  tool_use_result?: unknown;
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ResultSuccess {
  type: "result";
  subtype: "success";
  result: string;
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  session_id: string;
  num_turns: number;
  usage?: UsageInfo;
  is_error?: boolean;
  stop_reason?: string | null;
}

export interface ResultError {
  type: "result";
  subtype: "error";
  error: string;
  session_id: string;
}

export type ResultEvent = ResultSuccess | ResultError;

/** Union of all raw NDJSON line types we may encounter */
export type StreamEvent =
  | SystemInit
  | StreamEventEnvelope
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | AssistantMessage
  | UserMessage
  | ResultEvent;

// -------------------------------------------------------
// Parsed events -- a simplified, normalized layer the
// socket handler and frontend can consume directly
// -------------------------------------------------------

/**
 * Every parsed event that can originate from a subagent carries the id of the
 * Agent tool call that spawned it. `null`/undefined means the main conversation.
 */
export interface ParentAttributed {
  parentToolUseId?: string | null;
}

export interface ParsedInit extends ParentAttributed {
  kind: "init";
  sessionId: string;
  model: string;
  tools: string[];
  cwd: string;
}

export interface ParsedDelta extends ParentAttributed {
  kind: "delta";
  text: string;
}

export interface ParsedToolUseStart extends ParentAttributed {
  kind: "tool_use_start";
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** A chunk of a tool's input JSON, streamed while the model writes it. */
export interface ParsedToolInputDelta extends ParentAttributed {
  kind: "tool_input_delta";
  /** Content block index; the CLI does not repeat the tool id on deltas. */
  index: number;
  partialJson: string;
}

export interface ParsedToolResult extends ParentAttributed {
  kind: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ParsedAssistantComplete extends ParentAttributed {
  kind: "assistant_complete";
  content: ContentBlock[];
}

export interface ParsedResult extends ParentAttributed {
  kind: "result";
  success: boolean;
  result?: string;
  error?: string;
  totalCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  sessionId: string;
  usage?: UsageInfo;
}

export interface ParsedError extends ParentAttributed {
  kind: "error";
  message: string;
}

export type ParsedEvent =
  | ParsedInit
  | ParsedDelta
  | ParsedToolUseStart
  | ParsedToolInputDelta
  | ParsedToolResult
  | ParsedAssistantComplete
  | ParsedResult
  | ParsedError;
