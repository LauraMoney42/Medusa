import fs from "fs";
import path from "path";

/**
 * Single log entry representing one Claude CLI interaction's cost/performance metrics.
 * Append-only JSONL format for easy streaming analysis.
 */
export interface TokenUsageEntry {
  timestamp: string;
  /** Medusa session ID (bot session) */
  sessionId: string;
  /** Bot display name */
  botName: string;
  /** Claude CLI session ID */
  claudeSessionId: string;
  /** Medusa message ID for correlation */
  messageId: string;
  /** What triggered this interaction */
  source: "user" | "autonomous" | "poll" | "summarizer" | "mention" | "resume" | "nudge";
  /** Aggregate cost from Claude CLI */
  costUsd: number;
  /** Total wall-clock duration (ms) */
  durationMs: number;
  /** API-only duration (ms) — network + inference time */
  durationApiMs?: number;
  /** Number of conversation turns in this CLI invocation */
  numTurns?: number;
  /** Whether the CLI call succeeded */
  success: boolean;
}

/**
 * Aggregated usage summary for a time period or bot.
 */
export interface UsageSummary {
  totalCostUsd: number;
  totalMessages: number;
  totalDurationMs: number;
  avgCostPerMessage: number;
  avgDurationMs: number;
  byBot: Record<string, { costUsd: number; messages: number }>;
  bySource: Record<string, { costUsd: number; messages: number }>;
}

/**
 * Centralized token usage logger. Writes append-only JSONL to disk.
 *
 * JSONL format chosen over JSON array because:
 * - Append-only (no read-modify-write cycle, crash-safe)
 * - Streamable for large datasets
 * - Each line is independently parseable
 */
export class TokenLogger {
  private filePath: string;
  private writeStream: fs.WriteStream | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ensureDir();
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Log a single usage entry. Non-blocking append.
   * Errors are logged to console, never thrown — logging must not break the app.
   */
  log(entry: TokenUsageEntry): void {
    try {
      if (!this.writeStream) {
        this.writeStream = fs.createWriteStream(this.filePath, { flags: "a" });
        this.writeStream.on("error", (err) => {
          console.error("[token-logger] Write stream error:", err);
          this.writeStream = null;
        });
      }
      this.writeStream.write(JSON.stringify(entry) + "\n");
    } catch (err) {
      console.error("[token-logger] Failed to log entry:", err);
    }
  }

  /**
   * Read all entries from the log file. Returns empty array if file doesn't exist.
   * Used for API queries — NOT on the hot path.
   */
  readAll(): TokenUsageEntry[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const content = fs.readFileSync(this.filePath, "utf-8");
      const entries: TokenUsageEntry[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as TokenUsageEntry);
        } catch {
          // Skip malformed lines — don't break the whole read
        }
      }
      return entries;
    } catch (err) {
      console.error("[token-logger] Failed to read log:", err);
      return [];
    }
  }

  /**
   * Read entries within a time range (ISO date strings).
   */
  readRange(from: string, to: string): TokenUsageEntry[] {
    const all = this.readAll();
    const fromTime = new Date(from).getTime();
    const toTime = new Date(to).getTime();
    return all.filter((e) => {
      const t = new Date(e.timestamp).getTime();
      return t >= fromTime && t <= toTime;
    });
  }

  /**
   * Compute aggregated summary from a set of entries.
   */
  summarize(entries: TokenUsageEntry[]): UsageSummary {
    const summary: UsageSummary = {
      totalCostUsd: 0,
      totalMessages: entries.length,
      totalDurationMs: 0,
      avgCostPerMessage: 0,
      avgDurationMs: 0,
      byBot: {},
      bySource: {},
    };

    for (const e of entries) {
      summary.totalCostUsd += e.costUsd;
      summary.totalDurationMs += e.durationMs;

      // By bot
      if (!summary.byBot[e.botName]) {
        summary.byBot[e.botName] = { costUsd: 0, messages: 0 };
      }
      summary.byBot[e.botName].costUsd += e.costUsd;
      summary.byBot[e.botName].messages += 1;

      // By source
      if (!summary.bySource[e.source]) {
        summary.bySource[e.source] = { costUsd: 0, messages: 0 };
      }
      summary.bySource[e.source].costUsd += e.costUsd;
      summary.bySource[e.source].messages += 1;
    }

    if (entries.length > 0) {
      summary.avgCostPerMessage = summary.totalCostUsd / entries.length;
      summary.avgDurationMs = summary.totalDurationMs / entries.length;
    }

    return summary;
  }

  /**
   * Get today's usage summary.
   */
  todaySummary(): UsageSummary {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return this.summarize(
      this.readRange(today.toISOString(), tomorrow.toISOString())
    );
  }

  /**
   * Graceful shutdown — flush and close the write stream.
   */
  close(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }
}
