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
  role: 'user' | 'assistant';
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
}
