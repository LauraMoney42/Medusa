import { spawn } from "child_process";
import { execSync } from "child_process";
import fs from "fs";
import type { TokenLogger } from "../metrics/token-logger.js";

/**
 * Find the Claude CLI binary.
 * Reuses the same logic as ProcessManager for consistency.
 */
function findClaudeBinary(): string {
  const candidates = [
    (() => {
      try {
        return execSync("which claude", { encoding: "utf-8" }).trim();
      } catch {
        return null;
      }
    })(),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];

  for (const p of candidates) {
    if (!p) continue;
    try {
      const real = fs.realpathSync(p);
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch {
      // continue
    }
  }

  return "claude";
}

const CLAUDE_BIN = findClaudeBinary();

export interface ChatMessage {
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

export interface SummarizationResult {
  summary: string;
  costUsd: number;
  durationMs: number;
}

/**
 * Summarize a conversation using a one-shot Claude CLI call.
 * Uses Haiku for cheap summarization.
 * Returns summary text + cost metrics for token logging.
 *
 * Uses stream-json output format to capture the result event with cost data.
 * The old json format only returned the response text with no metrics.
 */
export async function summarizeConversation(
  messages: ChatMessage[],
  opts?: {
    sessionId?: string;
    botName?: string;
    tokenLogger?: TokenLogger;
  }
): Promise<SummarizationResult> {
  if (messages.length === 0) {
    return { summary: "No messages to summarize.", costUsd: 0, durationMs: 0 };
  }

  // Build a transcript for the summarizer
  const transcript = messages
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      return `${role}: ${m.text}`;
    })
    .join("\n\n");

  const prompt = `Please summarize this conversation concisely. Focus on:
- Key decisions made
- Important context established
- Tasks completed
- Open questions or next steps

Conversation transcript:
${transcript}

Provide a concise summary (under 200 words):`;

  return new Promise<SummarizationResult>((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--model",
      "haiku",
    ];

    const child = spawn(CLAUDE_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`Summarization failed (exit ${code}): ${stderr}`)
        );
      }

      // Parse NDJSON stream to extract text deltas and the result event
      let summaryText = "";
      let costUsd = 0;
      let durationMs = 0;
      let durationApiMs: number | undefined;
      let numTurns: number | undefined;
      let claudeSessionId = "";

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);

          // Accumulate text from deltas
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            summaryText += event.delta.text;
          }

          // Extract cost from result event
          if (event.type === "result" && event.subtype === "success") {
            costUsd = event.total_cost_usd ?? 0;
            durationMs = event.duration_ms ?? 0;
            durationApiMs = event.duration_api_ms;
            numTurns = event.num_turns;
            claudeSessionId = event.session_id ?? "";
          }
        } catch {
          // Skip non-JSON lines
        }
      }

      if (!summaryText) {
        summaryText = "Summary unavailable.";
      }

      // TC-2B: Log summarization cost
      if (opts?.tokenLogger) {
        opts.tokenLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: opts.sessionId ?? "",
          botName: opts.botName ?? "summarizer",
          claudeSessionId,
          messageId: "",
          source: "summarizer",
          costUsd,
          durationMs,
          durationApiMs,
          numTurns,
          success: true,
        });
      }

      resolve({ summary: summaryText, costUsd, durationMs });
    });

    child.on("error", (err) => {
      reject(new Error(`Summarization spawn error: ${err.message}`));
    });
  });
}
