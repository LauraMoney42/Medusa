// -------------------------------------------------------
// Raw NDJSON types emitted by:
//   claude -p --output-format stream-json --verbose --include-partial-messages
// -------------------------------------------------------

export interface SystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd: string;
  model: string;
  tools: string[];
}

export interface ContentBlockText {
  type: "text";
  text: string;
}

export interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type ContentBlock =
  | ContentBlockText
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

export interface ContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}

export interface ContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta: TextDelta | InputJsonDelta;
}

export interface ContentBlockStop {
  type: "content_block_stop";
  index: number;
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
  };
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
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | AssistantMessage
  | ResultEvent;

// -------------------------------------------------------
// Parsed events -- a simplified, normalized layer the
// socket handler and frontend can consume directly
// -------------------------------------------------------

export interface ParsedInit {
  kind: "init";
  sessionId: string;
  model: string;
  tools: string[];
  cwd: string;
}

export interface ParsedDelta {
  kind: "delta";
  text: string;
}

export interface ParsedToolUseStart {
  kind: "tool_use_start";
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ParsedToolResult {
  kind: "tool_result";
  toolUseId: string;
  content: string;
}

export interface ParsedAssistantComplete {
  kind: "assistant_complete";
  content: ContentBlock[];
}

export interface ParsedResult {
  kind: "result";
  success: boolean;
  result?: string;
  error?: string;
  totalCostUsd?: number;
  durationMs?: number;
  sessionId: string;
}

export interface ParsedError {
  kind: "error";
  message: string;
}

export type ParsedEvent =
  | ParsedInit
  | ParsedDelta
  | ParsedToolUseStart
  | ParsedToolResult
  | ParsedAssistantComplete
  | ParsedResult
  | ParsedError;
