import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const HubMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  text: z.string(),
  timestamp: z.string(),
  sessionId: z.string(),
  images: z.array(z.string()).optional(),
});

const CompletedTaskSchema = z.object({
  id: z.string(),
  hubMessageId: z.string(),
  from: z.string(),
  description: z.string(),
  timestamp: z.string(),
  sessionId: z.string(),
  acknowledged: z.boolean(),
});

const HubMessagesFileSchema = z.array(HubMessageSchema);
const TasksFileSchema = z.array(CompletedTaskSchema);

export type HubMessage = z.infer<typeof HubMessageSchema>;
export type CompletedTask = z.infer<typeof CompletedTaskSchema>;

const MAX_MESSAGES = 200;

/**
 * Persists hub messages to disk as a JSON file with an in-memory cache.
 * FIFO — trims to MAX_MESSAGES when the limit is exceeded.
 *
 * Also tracks completed tasks ([TASK-DONE:] markers) in a separate file.
 */
export class HubStore {
  private filePath: string;
  private messages: HubMessage[] = [];

  private tasksFilePath: string;
  private tasks: CompletedTask[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    // tasks.json lives alongside hub.json
    this.tasksFilePath = path.join(path.dirname(filePath), "tasks.json");
    this.load();
    this.loadTasks();
  }

  // ---- Hub Messages ----

  /** Load messages from disk into memory. */
  private load(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      this.writeAtomic(this.filePath, []);
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.messages = HubMessagesFileSchema.parse(JSON.parse(raw));
    } catch {
      this.messages = [];
    }
  }

  /** Atomically write data to disk. */
  private writeAtomic(filePath: string, data: unknown): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  }

  /** Persist current in-memory hub messages to disk. */
  private persist(): void {
    this.writeAtomic(this.filePath, this.messages);
  }

  /** Return all hub messages. */
  getAll(): HubMessage[] {
    return [...this.messages];
  }

  /** Return the most recent `n` hub messages. */
  getRecent(n: number): HubMessage[] {
    return this.messages.slice(-n);
  }

  /**
   * Return the most recent `n` hub messages relevant to a specific session.
   * A message is relevant if:
   * - It @mentions the bot by name (case-insensitive)
   * - It was authored by the bot itself (sessionId match)
   * - It's from "System" (system-wide alerts)
   * - It @mentions "You" (user-directed, all bots should see)
   * - It's a broadcast with no @mentions at all
   */
  getRecentForSession(n: number, sessionId: string, sessionName: string): HubMessage[] {
    const lowerName = sessionName.toLowerCase();
    const relevant: HubMessage[] = [];

    // Walk backwards to collect up to n relevant messages
    for (let i = this.messages.length - 1; i >= 0 && relevant.length < n; i--) {
      const msg = this.messages[i];
      const lowerText = msg.text.toLowerCase();

      // Always include messages from/to this bot
      if (msg.sessionId === sessionId) {
        relevant.unshift(msg);
        continue;
      }

      // Always include system messages
      if (msg.from === "System") {
        relevant.unshift(msg);
        continue;
      }

      // Include if bot is @mentioned
      if (lowerText.includes(`@${lowerName}`)) {
        relevant.unshift(msg);
        continue;
      }

      // Include @all broadcasts — they target every bot explicitly
      if (lowerText.includes("@all")) {
        relevant.unshift(msg);
        continue;
      }

      // Include @You messages (user-directed escalations all bots should see)
      if (lowerText.includes("@you")) {
        relevant.unshift(msg);
        continue;
      }

      // Include broadcast messages (no @ mentions at all)
      if (!lowerText.includes("@")) {
        relevant.unshift(msg);
        continue;
      }
    }

    return relevant;
  }

  /**
   * TC-5: Delta hub context — return recent relevant messages split into
   * "previously seen" and "new since last check" for a specific session.
   * Enables sending only new messages as full context with a summary anchor
   * for previously seen messages, cutting token usage 40-60%.
   *
   * @param n Max messages to return total
   * @param sessionId Bot's session ID
   * @param sessionName Bot's display name
   * @param sinceMessageId Last message ID the bot already saw
   * @returns { previousCount, newMessages } in chronological order
   */
  getRecentForSessionDelta(
    n: number,
    sessionId: string,
    sessionName: string,
    sinceMessageId?: string
  ): { previousCount: number; newMessages: HubMessage[] } {
    const allRelevant = this.getRecentForSession(n, sessionId, sessionName);

    if (!sinceMessageId) {
      return { previousCount: 0, newMessages: allRelevant };
    }

    const sinceIdx = allRelevant.findIndex((m) => m.id === sinceMessageId);
    if (sinceIdx === -1) {
      // sinceMessageId trimmed — fall back to full context
      return { previousCount: 0, newMessages: allRelevant };
    }

    const newMessages = allRelevant.slice(sinceIdx + 1);
    const previousCount = sinceIdx + 1;

    // Safety: always include at least 3 recent context messages even if "old"
    const MIN_CONTEXT = 3;
    if (newMessages.length < MIN_CONTEXT && allRelevant.length > newMessages.length) {
      const contextStart = Math.max(0, allRelevant.length - Math.max(newMessages.length, MIN_CONTEXT));
      return { previousCount: contextStart, newMessages: allRelevant.slice(contextStart) };
    }

    return { previousCount, newMessages };
  }

  /** Add a new message. Trims to FIFO limit and persists. */
  add(msg: Omit<HubMessage, "id" | "timestamp">): HubMessage {
    const hubMessage: HubMessage = {
      id: uuidv4(),
      from: msg.from,
      text: msg.text,
      timestamp: new Date().toISOString(),
      sessionId: msg.sessionId,
      ...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
    };
    this.messages.push(hubMessage);

    // FIFO trim
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }

    this.persist();
    return hubMessage;
  }

  // ---- Completed Tasks ----

  /** Load tasks from disk. */
  private loadTasks(): void {
    if (!fs.existsSync(this.tasksFilePath)) {
      this.writeAtomic(this.tasksFilePath, []);
    }
    try {
      const raw = fs.readFileSync(this.tasksFilePath, "utf-8");
      this.tasks = TasksFileSchema.parse(JSON.parse(raw));
    } catch {
      this.tasks = [];
    }
  }

  /** Persist tasks to disk. */
  private persistTasks(): void {
    this.writeAtomic(this.tasksFilePath, this.tasks);
  }

  /** Add a completed task and persist. */
  addCompletedTask(task: Omit<CompletedTask, "id" | "timestamp" | "acknowledged">): CompletedTask {
    const completedTask: CompletedTask = {
      id: uuidv4(),
      hubMessageId: task.hubMessageId,
      from: task.from,
      description: task.description,
      timestamp: new Date().toISOString(),
      sessionId: task.sessionId,
      acknowledged: false,
    };
    this.tasks.push(completedTask);
    this.persistTasks();
    return completedTask;
  }

  /** Return all unacknowledged tasks. */
  getUnacknowledged(): CompletedTask[] {
    return this.tasks.filter((t) => !t.acknowledged);
  }

  /** Mark all tasks as acknowledged. */
  acknowledgeAll(): void {
    for (const task of this.tasks) {
      task.acknowledged = true;
    }
    this.persistTasks();
  }
}
