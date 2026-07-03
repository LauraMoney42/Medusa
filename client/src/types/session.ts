export interface SessionMeta {
  id: string;
  name: string;
  workingDir: string;
  createdAt: string;
  lastActiveAt: string;
  yoloMode?: boolean;
  systemPrompt?: string;
  skills?: string[];
  /** Per-bot model override tier: "haiku" | "sonnet" | "opus" | "fable". Undefined = auto-routing. */
  model?: string;
}
