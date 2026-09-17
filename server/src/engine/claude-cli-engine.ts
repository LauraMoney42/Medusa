import fs from "fs";
import { spawn, execSync } from "child_process";
import { StreamParser } from "../claude/stream-parser.js";
import { getActiveConfigDir, getActiveProvider } from "../settings/store.js";
import { getHeadroomEnv } from "../headroom/proxy-manager.js";
import {
  getAnthropicCompatibleEnv,
  isAnthropicCompatibleProvider,
  listModels as listProviderModels,
} from "../settings/providers.js";
import {
  abortChildProcess,
  type Engine,
  type EngineSessionState,
  type EngineSpawnOptions,
  type ModelInfo,
} from "./types.js";

/**
 * Resolve the absolute path to the `claude` CLI binary.
 * Tries `which claude` first, then falls back to common install locations.
 * Resolves symlinks to avoid ENOENT issues on some Node.js versions.
 */
function findClaudeBinary(): string {
  const candidates = [
    // Try which first
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
      // Resolve symlinks to get the real binary path
      const real = fs.realpathSync(p);
      fs.accessSync(real, fs.constants.X_OK);
      console.log(`[claude] Found binary: ${p} -> ${real}`);
      return real;
    } catch {
      // continue
    }
  }

  // Last resort -- hope it is on PATH at runtime
  console.warn("[claude] Binary not found, falling back to 'claude'");
  return "claude";
}

const CLAUDE_BIN = findClaudeBinary();

/**
 * Detects Claude CLI usage/billing warnings on stderr.
 * These are informational (e.g. "You're out of extra usage · resets 1pm")
 * and should be logged, not forwarded as errors to the client.
 */
function isUsageWarning(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("out of extra usage") ||
    lower.includes("out of usage") ||
    lower.includes("usage resets") ||
    lower.includes("rate limit") ||
    (lower.includes("resets") && lower.includes("america/"))
  );
}

/**
 * Detects Anthropic context-window-exceeded errors.
 * When the accumulated conversation + system prompt exceeds 262,144 tokens,
 * the API returns a 400 with "exceeded model token limit".
 */
function isTokenLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("exceeded model token limit") ||
    lower.includes("token limit") && lower.includes("exceeded")
  );
}

export class ClaudeCliEngine implements Engine {
  readonly id = "claude";
  readonly displayName = "Claude Code";

  async listModels(): Promise<ModelInfo[]> {
    // This engine drives the `claude` CLI for the native Anthropic provider AND
    // for Anthropic-compatible ones (OpenRouter), so the model list depends on
    // which provider is active: OpenRouter's is fetched live by providers.ts.
    const provider = getActiveProvider();
    if (isAnthropicCompatibleProvider(provider)) {
      const models = await listProviderModels(provider as string);
      return models.map((m) => ({ id: m.id, label: m.displayName }));
    }

    return [
      { id: "haiku", label: "Haiku" },
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "fable", label: "Fable" },
    ];
  }

  abort(state: EngineSessionState, sessionId: string): void {
    abortChildProcess(state, sessionId);
  }

  spawn(opts: EngineSpawnOptions): Promise<number | null> {
    const {
      sessionId,
      state: entry,
      text,
      images,
      files,
      systemPrompt,
      model,
      onEvent,
    } = opts;
    const yoloMode = opts.yoloMode ?? false;
    const forceNew = opts.forceNew ?? false;

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

    const useSessionId = entry.isFirstMessage || forceNew;

    // Build args
    const args: string[] = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      // Without this the CLI emits one `assistant` message per completed block
      // and no `stream_event` lines at all, so text lands in one lump instead
      // of streaming token by token.
      "--include-partial-messages",
    ];

    if (useSessionId) {
      args.push("--session-id", sessionId);
    } else {
      args.push("--resume", sessionId);
    }

    if (yoloMode) {
      args.push("--dangerously-skip-permissions");
    }

    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    if (model) {
      args.push("--model", model);
    }

    // Headroom (the compression proxy in front of native Anthropic) and an
    // Anthropic-compatible custom provider (OpenRouter, etc.) both want to own
    // ANTHROPIC_BASE_URL, so only one can apply per spawn: Headroom for the
    // native provider, the provider env otherwise. getHeadroomEnv() returns {}
    // when the proxy is down, which means direct Anthropic.
    // The session's own provider wins; the global setting is only the default.
    const activeProvider = opts.providerId ?? getActiveProvider();
    const providerEnv = isAnthropicCompatibleProvider(activeProvider)
      ? getAnthropicCompatibleEnv(activeProvider as string, { model: model || "" })
      : getHeadroomEnv();

    const child = spawn(CLAUDE_BIN, args, {
      cwd: entry.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: undefined, ...(getActiveConfigDir() ? { CLAUDE_CONFIG_DIR: getActiveConfigDir() } : {}), ...providerEnv },
    });

    entry.process = child;

    const parser = new StreamParser();
    parser.onEvent = onEvent;

    // Collect raw stdout/stderr to detect retry-able errors
    let rawStdout = "";
    let rawStderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      rawStdout += str;
      parser.feed(str);
    });

    // Track whether we hit a token limit so we can retry with a fresh session
    let tokenLimitHit = false;

    // Forward stderr lines as error events so the client knows something went wrong.
    // Filter out Claude CLI usage/billing warnings, they're informational, not errors,
    // and pollute the response text when appended by the client's setError handler.
    child.stderr!.on("data", (chunk: Buffer) => {
      const errText = chunk.toString("utf-8").trim();
      if (!errText) return;
      rawStderr += errText + "\n";
      if (isUsageWarning(errText)) {
        console.log(`[claude] Usage warning (session ${sessionId}): ${errText}`);
        return;
      }
      if (isTokenLimitError(errText)) {
        tokenLimitHit = true;
        console.warn(
          `[claude] Token limit exceeded for session ${sessionId}. Will retry with fresh session.`
        );
        // Still emit so the user sees it in Hub/chat, then retry transparently
      }
      onEvent({ kind: "error", message: errText });
    });

    return new Promise<number | null>((resolve) => {
      child.on("close", (code) => {
        parser.flush();
        entry.process = null;

        const combined = rawStdout + rawStderr;

        // If --resume failed because no session exists, retry with --session-id
        if (
          code !== 0 &&
          !useSessionId &&
          !forceNew &&
          combined.includes("No conversation found")
        ) {
          console.log(
            `[claude] Session ${sessionId} not found in Claude, retrying with --session-id`
          );
          entry.isFirstMessage = true;
          resolve(this.spawn({ ...opts, forceNew: true }));
          return;
        }

        // If --session-id failed because session already exists, retry with --resume
        if (
          code !== 0 &&
          useSessionId &&
          combined.includes("already in use")
        ) {
          console.log(
            `[claude] Session ${sessionId} already exists in Claude, retrying with --resume`
          );
          entry.isFirstMessage = false;
          resolve(this.spawn({ ...opts, forceNew: false }));
          return;
        }

        // If token limit exceeded, retry with a fresh session (--session-id).
        // The CLI's internal conversation history grew too large; starting fresh
        // clears Anthropic's side and gives us a clean context window.
        if (
          code !== 0 &&
          tokenLimitHit
        ) {
          console.log(
            `[claude] Retrying session ${sessionId} with fresh context after token limit error`
          );
          entry.isFirstMessage = true;
          resolve(this.spawn({ ...opts, forceNew: true }));
          return;
        }

        // Only mark first message done on success (exit 0)
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
