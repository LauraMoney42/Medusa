export interface ToolUse {
  /** Claude's `toolu_...` id. Used to pair a result with its call. */
  id?: string;
  name: string;
  input?: unknown;
  output?: string;
  /** True when the tool returned an error result. */
  isError?: boolean;
  /**
   * The id of the Agent tool call that spawned this activity, or null/undefined
   * for the main conversation. Drives the "subagent" badge.
   */
  parentToolUseId?: string | null;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  // 'system' is not produced by any engine turn; it is reserved for the
  // event-driven subagent follow-ups from S14-B (see isFollowupMessage below).
  role: 'user' | 'assistant' | 'system';
  text: string;
  images?: string[];
  files?: string[];
  toolUses?: ToolUse[];
  timestamp: string;
  isStreaming?: boolean;
  cost?: number;
  durationMs?: number;
  /**
   * Distinct engine/handler error lines for this message, in the order they
   * occurred. Consecutive-deduped: the same error text never appears twice
   * in a row, so a tier-escalation retry that fails the same way doesn't
   * render the same line repeatedly.
   */
  errors?: string[];
  /**
   * S14-B's follow-up contract is not final yet (FOLLOWUP_CONTRACT.md lands
   * with the server side), so this client accepts any of three shapes on a
   * `message:user` event and renders all of them as the same compact system
   * chip instead of a user bubble: `role: "system"`, `kind: "followup"`, or
   * `source: "agent-followup"`. See isFollowupMessage.
   */
  kind?: string;
  source?: string;
  /** Present on a follow-up chip so the UI can offer "see full result". */
  agentId?: string;
}

/** True when a message should render as a compact system chip, not a bubble. */
export function isFollowupMessage(msg: ChatMessage): boolean {
  return msg.role === 'system' || msg.kind === 'followup' || msg.source === 'agent-followup';
}
