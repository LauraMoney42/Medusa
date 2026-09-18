import fs from "fs";
import path from "path";
import { getModelPricing } from "./pricing.js";

/**
 * Single log entry representing one Claude CLI interaction's cost/performance metrics.
 * Append-only JSONL format for easy streaming analysis.
 */
export interface TokenUsageEntry {
  timestamp: string;
  /** Medusa session ID. For a subagent entry this is the PARENT session id,
   *  so the session's total and the token ring stay correct. */
  sessionId: string;
  /**
   * @deprecated Superseded by `sessionTitle`. Kept optional so pre-S10 JSONL
   * lines (which only ever had this field) still parse; new entries should
   * set `sessionTitle` instead.
   */
  botName?: string;
  /** Human title of the session at log time (the chat's display name). */
  sessionTitle?: string;
  /** Claude CLI session ID */
  claudeSessionId: string;
  /** Medusa message ID for correlation. For a subagent entry, its agent id. */
  messageId: string;
  /** What triggered this interaction */
  source: "user" | "autonomous" | "poll" | "summarizer" | "mention" | "resume" | "nudge" | "subagent";
  /** Aggregate cost from Claude CLI (or computed from tokens, see `costEstimated`) */
  costUsd: number;
  /** True when `costUsd` was computed from token counts and a pricing table
   *  rather than reported directly by the CLI (OpenRouter models only). */
  costEstimated?: boolean;
  /** Total wall-clock duration (ms) */
  durationMs: number;
  /** API-only duration (ms) — network + inference time */
  durationApiMs?: number;
  /** Number of conversation turns in this CLI invocation */
  numTurns?: number;
  /** Input tokens consumed (from Anthropic usage field) */
  inputTokens?: number;
  /** Output tokens consumed (from Anthropic usage field) */
  outputTokens?: number;
  /** Prompt-cache creation tokens (if any) */
  cacheCreationTokens?: number;
  /** Prompt-cache read tokens (if any) */
  cacheReadTokens?: number;
  /** Whether the CLI call succeeded */
  success: boolean;
  /** LLM provider id used for this interaction (e.g. "claude", "kimi", "openrouter").
   *  For a subagent entry, the engine id the subagent actually ran on. */
  provider?: string;
  /** Model id used for this interaction (a tier like "sonnet" for native Claude,
   *  or a full model id like "openai/gpt-5.1" when routed through OpenRouter) */
  model?: string;
  /** Set to "subagent" when this entry represents a spawned agent's completion
   *  rather than the session's own turn. Absent means a normal session turn. */
  role?: "subagent";
  /** Present when role === "subagent": the spawned agent's own id. */
  agentId?: string;
  /** Present when role === "subagent": a short summary of the task it was given. */
  subagentTask?: string;
  /** Present when role === "subagent": the subagent's display name. */
  subagentName?: string;
}

interface BreakdownStats {
  costUsd: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
}

/** One row of the "Cost by Session" breakdown. */
export interface SessionBreakdown extends BreakdownStats {
  /** Session display name, resolved from sessionTitle, legacy botName, or the id itself. */
  title: string;
}

/** One row of the "Cost by Subagent" breakdown. */
export interface SubagentBreakdown extends BreakdownStats {
  engine: string;
  model: string | null;
  parentSessionId: string;
  /** Short summary of what the subagent was asked to do. */
  task: string;
}

export interface ModelBreakdown {
  costUsd: number;
  messages: number;
  /** False when at least one entry in this bucket had unknown per-token pricing. */
  priceKnown: boolean;
}

/**
 * Aggregated usage summary for a time period or session.
 */
export interface UsageSummary {
  totalCostUsd: number;
  totalMessages: number;
  totalDurationMs: number;
  avgCostPerMessage: number;
  avgDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  /** Keyed by sessionId. Subagent entries roll into their parent session here too. */
  bySession: Record<string, SessionBreakdown>;
  /** Keyed by subagent agentId. Only subagent-role entries appear here. */
  bySubagent: Record<string, SubagentBreakdown>;
  bySource: Record<string, BreakdownStats>;
  /** Keyed by "<provider>/<model>" (falls back to just the model, or "unknown"). */
  byModel: Record<string, ModelBreakdown>;
}

const EMPTY_STATS = (): BreakdownStats => ({ costUsd: 0, messages: 0, inputTokens: 0, outputTokens: 0 });

/** Resolve the display title for a bySession row from whatever the entry carries. */
function resolveSessionTitle(e: TokenUsageEntry): string {
  return e.sessionTitle || e.botName || e.sessionId || "unknown";
}

/** Trim a subagent task string down to a short summary for the breakdown table. */
function summarizeTask(task: string | undefined): string {
  if (!task) return "";
  const trimmed = task.trim().replace(/\s+/g, " ");
  return trimmed.length > 140 ? `${trimmed.slice(0, 140)}...` : trimmed;
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
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
      bySession: {},
      bySubagent: {},
      bySource: {},
      byModel: {},
    };

    let entriesWithTokens = 0;

    for (const e of entries) {
      const inputTokens = e.inputTokens ?? 0;
      const outputTokens = e.outputTokens ?? 0;
      const cacheCreationTokens = e.cacheCreationTokens ?? 0;
      const cacheReadTokens = e.cacheReadTokens ?? 0;

      // Cost: trust the CLI-reported figure unless this is an OpenRouter
      // model with known per-token pricing, in which case recompute from
      // tokens (the CLI's own cost accounting assumes Anthropic pricing).
      const pricing = getModelPricing(e.provider, e.model);
      let costUsd = e.costUsd;
      const priceKnown = e.provider === "openrouter" ? pricing.known : true;
      if (e.provider === "openrouter" && pricing.known) {
        costUsd = inputTokens * pricing.usdPerInputToken + outputTokens * pricing.usdPerOutputToken;
      }

      summary.totalCostUsd += costUsd;
      summary.totalDurationMs += e.durationMs;

      if (e.inputTokens !== undefined || e.outputTokens !== undefined) {
        summary.totalInputTokens += inputTokens;
        summary.totalOutputTokens += outputTokens;
        summary.totalCacheCreationTokens += cacheCreationTokens;
        summary.totalCacheReadTokens += cacheReadTokens;
        entriesWithTokens++;
      }

      // By session: every entry, including subagent entries, whose sessionId
      // is always the PARENT session, so a subagent's cost rolls into its
      // parent's total automatically. A blank/missing sessionId (only ever
      // possible on a malformed legacy line) keys as "unknown".
      const sid = e.sessionId || "unknown";
      if (!summary.bySession[sid]) {
        summary.bySession[sid] = { title: resolveSessionTitle(e), ...EMPTY_STATS() };
      }
      const sessionRow = summary.bySession[sid];
      sessionRow.costUsd += costUsd;
      sessionRow.messages += 1;
      sessionRow.inputTokens += inputTokens;
      sessionRow.outputTokens += outputTokens;

      // By subagent: only entries logged for a spawned agent's own completion.
      if (e.role === "subagent" && e.agentId) {
        if (!summary.bySubagent[e.agentId]) {
          summary.bySubagent[e.agentId] = {
            engine: e.provider || "unknown",
            model: e.model ?? null,
            parentSessionId: e.sessionId,
            task: summarizeTask(e.subagentTask),
            ...EMPTY_STATS(),
          };
        }
        const subagentRow = summary.bySubagent[e.agentId];
        subagentRow.costUsd += costUsd;
        subagentRow.messages += 1;
        subagentRow.inputTokens += inputTokens;
        subagentRow.outputTokens += outputTokens;
      }

      // By source
      if (!summary.bySource[e.source]) {
        summary.bySource[e.source] = EMPTY_STATS();
      }
      summary.bySource[e.source].costUsd += costUsd;
      summary.bySource[e.source].messages += 1;
      summary.bySource[e.source].inputTokens += inputTokens;
      summary.bySource[e.source].outputTokens += outputTokens;

      // By model: "<provider>/<model>" when both are known, else whichever is present.
      const modelKey = e.provider && e.model
        ? `${e.provider}/${e.model}`
        : e.model || e.provider || "unknown";
      if (!summary.byModel[modelKey]) {
        summary.byModel[modelKey] = { costUsd: 0, messages: 0, priceKnown: true };
      }
      summary.byModel[modelKey].costUsd += costUsd;
      summary.byModel[modelKey].messages += 1;
      if (!priceKnown) {
        summary.byModel[modelKey].priceKnown = false;
      }
    }

    if (entries.length > 0) {
      summary.avgCostPerMessage = summary.totalCostUsd / entries.length;
      summary.avgDurationMs = summary.totalDurationMs / entries.length;
    }

    if (entriesWithTokens > 0) {
      summary.avgInputTokens = summary.totalInputTokens / entriesWithTokens;
      summary.avgOutputTokens = summary.totalOutputTokens / entriesWithTokens;
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
