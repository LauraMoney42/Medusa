export interface ToolUse {
  name: string;
  input?: unknown;
  output?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  images?: string[];
  toolUses?: ToolUse[];
  timestamp: string;
  isStreaming?: boolean;
  cost?: number;
  durationMs?: number;
}
