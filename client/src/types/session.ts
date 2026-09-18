export interface SessionMeta {
  id: string;
  name: string;
  /** The chat's project folder. One chat = one folder. */
  workingDir: string;
  createdAt: string;
  lastActiveAt: string;
  yoloMode?: boolean;
  systemPrompt?: string;
  skills?: string[];
  /** Per-chat model override, e.g. "sonnet" or "openai/gpt-5.1". Undefined = auto. */
  model?: string;
  /** Harness that runs this chat: "claude" | "kimi" | "code-puppy". */
  engineId?: string;
  /** Credential/env set: "claude" | "kimi" | "openrouter". */
  providerId?: string;
  archived?: boolean;
  /**
   * S14-A: per-session override of which model handles voice turns (for
   * example a faster tier than the chat's normal model), defaulting to the
   * session model when unset. Persisted via PATCH /api/sessions.
   */
  voiceModel?: string | null;
}
