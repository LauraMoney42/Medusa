import fs from "fs";
import { spawn, execSync } from "child_process";
import {
  abortChildProcess,
  type Engine,
  type EngineSessionState,
  type EngineSpawnOptions,
  type ModelInfo,
} from "./types.js";

/**
 * Resolve the absolute path to the `kimi` CLI binary.
 */
function findKimiBinary(): string {
  const candidates = [
    (() => {
      try {
        return execSync("which kimi", { encoding: "utf-8" }).trim();
      } catch {
        return null;
      }
    })(),
    "/usr/local/bin/kimi",
    "/opt/homebrew/bin/kimi",
    `${process.env.HOME}/.local/bin/kimi`,
    `${process.env.HOME}/.npm-global/bin/kimi`,
  ];

  for (const p of candidates) {
    if (!p) continue;
    try {
      const real = fs.realpathSync(p);
      fs.accessSync(real, fs.constants.X_OK);
      console.log(`[kimi] Found binary: ${p} -> ${real}`);
      return real;
    } catch {
      // continue
    }
  }

  console.warn("[kimi] Binary not found, falling back to 'kimi'");
  return "kimi";
}

const KIMI_BIN = findKimiBinary();

export class KimiCliEngine implements Engine {
  readonly id = "kimi";
  readonly displayName = "Kimi CLI";

  async listModels(): Promise<ModelInfo[]> {
    // The kimi CLI takes no --model flag; the model is picked in its own config.
    return [];
  }

  abort(state: EngineSessionState, sessionId: string): void {
    abortChildProcess(state, sessionId);
  }

  spawn(opts: EngineSpawnOptions): Promise<number | null> {
    const { sessionId, state: entry, text, images, files, onEvent } = opts;
    const yoloMode = opts.yoloMode ?? false;
    const systemPrompt = opts.systemPrompt;

    // Build the prompt: prepend image and file references if any
    let prompt = text;
    if (images && images.length > 0) {
      const imageLines = images
        .map((p) => `Please read this image: ${p}`)
        .join("\n");
      prompt = `${imageLines}\n\n${prompt}`;
    }
    if (files && files.length > 0) {
      const fileLines = files
        .map((p) => `Please read this file: ${p}`)
        .join("\n");
      prompt = `${fileLines}\n\n${prompt}`;
    }

    // Kimi doesn't support --system-prompt; prepend to prompt
    if (systemPrompt) {
      prompt = `--- SYSTEM INSTRUCTIONS ---\n${systemPrompt}\n--- END SYSTEM INSTRUCTIONS ---\n\n${prompt}`;
    }

    const args: string[] = [
      "--print",
      "--output-format",
      "stream-json",
      "--prompt",
      prompt,
      "--session",
      entry.kimiSessionKey,
      "--work-dir",
      entry.workingDir,
    ];

    if (yoloMode) {
      args.push("--yolo");
    }

    const child = spawn(KIMI_BIN, args, {
      cwd: entry.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    entry.process = child;

    // Collect raw stdout/stderr
    let rawStdout = "";
    let rawStderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      rawStdout += chunk.toString("utf-8");
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      const errText = chunk.toString("utf-8").trim();
      if (!errText) return;
      rawStderr += errText + "\n";
      // Kimi outputs session resume hint on stderr; ignore it
      if (errText.includes("To resume this session:")) return;
      onEvent({ kind: "error", message: errText });
    });

    return new Promise<number | null>((resolve) => {
      child.on("close", (code) => {
        entry.process = null;

        // Detect token limit errors in full stdout (message may span lines)
        const tokenLimitHit =
          rawStdout.includes("exceeded model token limit") ||
          (rawStdout.includes("token limit") && rawStdout.includes("exceeded"));

        // Parse each JSON line from stdout
        const lines = rawStdout.split("\n").map((l) => l.trim()).filter(Boolean);
        let emittedText = false;
        let errorText = "";

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.role === "assistant") {
              // Kimi 1.47+ sends the final answer as a plain string; earlier
              // versions and tool-calling turns use a block array.
              if (typeof obj.content === "string" && obj.content) {
                onEvent({ kind: "delta", text: obj.content });
                emittedText = true;
              } else if (Array.isArray(obj.content)) {
                for (const block of obj.content) {
                  if (block.type === "text" && block.text) {
                    onEvent({ kind: "delta", text: block.text });
                    emittedText = true;
                  }
                  // thinking blocks are skipped to avoid cluttering output
                }
              }
              if (Array.isArray(obj.tool_calls)) {
                for (const call of obj.tool_calls) {
                  let input: Record<string, unknown> = {};
                  try {
                    input = JSON.parse(call.function?.arguments ?? "{}");
                  } catch {
                    input = { arguments: call.function?.arguments };
                  }
                  onEvent({
                    kind: "tool_use_start",
                    toolId: call.id,
                    toolName: call.function?.name ?? "tool",
                    input,
                  });
                }
              }
            } else if (obj.role === "tool" && obj.tool_call_id) {
              const content = Array.isArray(obj.content)
                ? obj.content
                    .map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text ?? "" : ""))
                    .join("\n")
                : String(obj.content ?? "");
              onEvent({ kind: "tool_result", toolUseId: obj.tool_call_id, content });
            }
          } catch {
            // Not valid JSON, could be an error message from the CLI
            errorText += line + "\n";
          }
        }

        // If token limit exceeded, retry with a fresh Kimi session.
        // Rotate the session key so Kimi starts with a clean context window.
        if (code !== 0 && tokenLimitHit) {
          const oldKey = entry.kimiSessionKey;
          entry.kimiSessionKey = `${sessionId}-fresh-${Date.now()}`;
          console.log(
            `[kimi] Token limit hit for session ${sessionId} (key=${oldKey}). ` +
            `Retrying with fresh key ${entry.kimiSessionKey}`
          );
          resolve(this.spawn(opts));
          return;
        }

        // If the process failed and we have non-JSON output, emit it as an error
        if (code !== 0 && errorText.trim() && !emittedText) {
          onEvent({ kind: "error", message: errorText.trim() });
        }

        // Emit result event so the stream is properly finalized
        onEvent({
          kind: "result",
          success: code === 0,
          sessionId,
        });

        if (code === 0) {
          entry.isFirstMessage = false;
        }
        resolve(code);
      });

      child.on("error", (err) => {
        onEvent({ kind: "error", message: err.message });
        entry.process = null;
        resolve(null);
      });
    });
  }
}
