import type { ParsedEvent } from "../claude/types.js";

export type SubagentStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

/** `resultText` longer than this is clipped; the transcript keeps the rest. */
export const RESULT_TEXT_LIMIT = 24_000;

export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SubagentRecord {
  /** "sa_" + 12 hex. */
  id: string;
  parentSessionId: string;
  /** The parent's `spawn_agent` tool_use block this card anchors to. */
  parentToolUseId: string | null;
  name: string;
  task: string;
  engineId: string;
  model: string | null;
  cwd: string;
  yolo: boolean;
  status: SubagentStatus;
  startedAt: string;
  endedAt: string | null;
  resultText: string;
  /** True when `resultText` was clipped at RESULT_TEXT_LIMIT. */
  truncated: boolean;
  transcriptPath: string;
  usage: SubagentUsage;
  toolCallCount: number;
  /** Set when the run failed; surfaced to the parent as the tool error text. */
  error?: string;
  /**
   * The id handed to the engine, distinct from `id` on purpose: the `claude`
   * CLI's `--session-id` only accepts a UUID, so "sa_<hex>" cannot be reused
   * there. Not part of the MCP tool surface.
   */
  engineSessionId: string;
}

export interface SpawnAgentInput {
  parentSessionId: string;
  task: string;
  name?: string;
  engine?: string;
  model?: string;
  cwd?: string;
  wait?: boolean;
  /** Set by the socket layer when it can correlate the parent tool_use block. */
  parentToolUseId?: string | null;
}

/** What the manager needs to know about the chat that is spawning. */
export interface ParentSessionInfo {
  workingDir: string;
  engineId: string;
  model: string | null;
  yoloMode: boolean;
}

/** The `agent_status` tool shape. */
export interface SubagentStatusView {
  agentId: string;
  name: string;
  status: SubagentStatus;
  engine: string;
  model: string | null;
  startedAt: string;
  endedAt?: string;
  toolCallCount: number;
  tokens: SubagentUsage;
}

/** The `agent_result` tool shape. */
export interface SubagentResultView {
  agentId: string;
  status: SubagentStatus;
  text: string;
  truncated: boolean;
  transcriptPath: string;
  usage: SubagentUsage;
  error?: string;
}

export function toStatusView(record: SubagentRecord): SubagentStatusView {
  return {
    agentId: record.id,
    name: record.name,
    status: record.status,
    engine: record.engineId,
    model: record.model,
    startedAt: record.startedAt,
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    toolCallCount: record.toolCallCount,
    tokens: { ...record.usage },
  };
}

export function toResultView(record: SubagentRecord): SubagentResultView {
  return {
    agentId: record.id,
    status: record.status,
    text: record.resultText,
    truncated: record.truncated,
    transcriptPath: record.transcriptPath,
    usage: { ...record.usage },
    ...(record.error ? { error: record.error } : {}),
  };
}

/** One line of a subagent transcript file. */
export interface TranscriptLine {
  ts: string;
  event: ParsedEvent;
}

/**
 * Cost attribution handed to the metrics layer on `subagent:end`. Typed here
 * rather than in `metrics/token-logger.ts` so this workstream stays additive;
 * the usage workstream (S10) wires it to a real `TokenUsageEntry`.
 */
export interface SubagentUsageEntry {
  /** Always the PARENT session, so the token ring stays correct. */
  sessionId: string;
  agentId: string;
  role: "subagent";
  engineId: string;
  model: string | null;
  durationMs: number;
  usage: SubagentUsage;
}
