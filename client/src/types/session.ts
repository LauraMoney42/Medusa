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
}
