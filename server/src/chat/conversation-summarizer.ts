import { spawn } from "child_process";
import { execSync } from "child_process";
import fs from "fs";

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

/**
 * Summarize a conversation using a one-shot Claude CLI call.
 * Uses Haiku for cheap summarization.
 * Returns the summary text.
 */
export async function summarizeConversation(
  messages: ChatMessage[]
): Promise<string> {
  if (messages.length === 0) {
    return "No messages to summarize.";
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

  return new Promise<string>((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
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

      try {
        const parsed = JSON.parse(stdout);
        // Extract text from the JSON response
        const text =
          parsed.content?.[0]?.text ||
          parsed.text ||
          "Summary unavailable.";
        resolve(text);
      } catch (err) {
        reject(new Error(`Failed to parse summarization output: ${err}`));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Summarization spawn error: ${err.message}`));
    });
  });
}
