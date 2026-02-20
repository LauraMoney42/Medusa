import fs from "fs";
import path from "path";

export interface PersistedMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  images?: string[];
  toolUses?: { name: string; input?: unknown; output?: string }[];
  timestamp: string;
  cost?: number;
  durationMs?: number;
}

/**
 * Persists chat messages per session to individual JSON files.
 * Files are stored at ~/.claude-chat/chats/{sessionId}.json
 */
export class ChatStore {
  private dir: string;

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, "chats");
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  private filePath(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.json`);
  }

  private summaryFilePath(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.summary.txt`);
  }

  /** Load all messages for a session. */
  loadMessages(sessionId: string): PersistedMessage[] {
    const fp = this.filePath(sessionId);
    if (!fs.existsSync(fp)) return [];
    try {
      const raw = fs.readFileSync(fp, "utf-8");
      return JSON.parse(raw) as PersistedMessage[];
    } catch {
      return [];
    }
  }

  /** Append a message to a session's chat file. */
  appendMessage(msg: PersistedMessage): void {
    const messages = this.loadMessages(msg.sessionId);
    messages.push(msg);
    this.writeAtomic(msg.sessionId, messages);
  }

  /** Update the last message (used to finalize assistant messages after streaming). */
  updateLastAssistant(
    sessionId: string,
    messageId: string,
    update: Partial<PersistedMessage>
  ): void {
    const messages = this.loadMessages(sessionId);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      messages[idx] = { ...messages[idx], ...update };
      this.writeAtomic(sessionId, messages);
    }
  }

  /** Load the conversation summary for a session (if any). */
  loadSummary(sessionId: string): string | null {
    const fp = this.summaryFilePath(sessionId);
    if (!fs.existsSync(fp)) return null;
    try {
      return fs.readFileSync(fp, "utf-8");
    } catch {
      return null;
    }
  }

  /** Save a conversation summary for a session. */
  saveSummary(sessionId: string, summary: string): void {
    const fp = this.summaryFilePath(sessionId);
    fs.writeFileSync(fp, summary, "utf-8");
  }

  /** Delete chat history and summary for a session. */
  deleteSession(sessionId: string): void {
    const fp = this.filePath(sessionId);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
    const sfp = this.summaryFilePath(sessionId);
    if (fs.existsSync(sfp)) {
      fs.unlinkSync(sfp);
    }
  }

  private writeAtomic(sessionId: string, messages: PersistedMessage[]): void {
    const fp = this.filePath(sessionId);
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(messages, null, 2), "utf-8");
    fs.renameSync(tmp, fp);
  }
}
