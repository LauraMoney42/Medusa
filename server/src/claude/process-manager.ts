import fs from "fs";
import { spawn, ChildProcess, execSync } from "child_process";
import type { ParsedEvent } from "./types.js";
import { StreamParser } from "./stream-parser.js";
import { getActiveConfigDir, getActiveProvider } from "../settings/store.js";

interface SessionEntry {
  process: ChildProcess | null;
  isFirstMessage: boolean;
  workingDir: string;
  /** Lock to prevent concurrent sendMessage calls */
  spawnLock: Promise<any> | null;
}

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

export class ProcessManager {
  private sessions: Map<string, SessionEntry> = new Map();

  /** Register a new session (does not spawn anything yet). Skips if already registered. */
  createSession(id: string, workingDir: string, isFirstMessage = true): void {
    if (this.sessions.has(id)) return;
    this.sessions.set(id, {
      process: null,
      isFirstMessage,
      workingDir,
      spawnLock: null,
    });
  }

  /** Reset a session to use --session-id on the next message (e.g. after summarization). */
  resetSession(id: string): void {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.isFirstMessage = true;
    }
  }

  /** Returns true when a claude process is currently running for the session. */
  isSessionBusy(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    return entry?.process != null;
  }

  /**
   * Spawn `claude` for the given session and stream parsed events back via
   * the provided callback.  Resolves when the process exits.
   */
  sendMessage(
    sessionId: string,
    text: string,
    images: string[] | undefined,
    onEvent: (event: ParsedEvent) => void,
    yoloMode = false,
    systemPrompt?: string,
    model?: string,
    files?: string[]
  ): Promise<number | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return Promise.reject(new Error(`Session ${sessionId} not found`));
    }
    // Check both process AND spawnLock to prevent race conditions
    if (entry.process || entry.spawnLock) {
      return Promise.reject(
        new Error(`Session ${sessionId} is busy -- abort first`)
      );
    }

    // Claim the lock immediately before spawning
    const provider = getActiveProvider();
    const spawnPromise = provider === "kimi"
      ? this.spawnKimi(sessionId, entry, text, images, onEvent, yoloMode, systemPrompt, model, files)
      : this.spawnClaude(sessionId, entry, text, images, onEvent, false, yoloMode, systemPrompt, model, files);
    entry.spawnLock = spawnPromise;

    // Clear the lock when done (success or failure)
    spawnPromise.finally(() => {
      entry.spawnLock = null;
    });

    return spawnPromise;
  }

  private spawnClaude(
    sessionId: string,
    entry: SessionEntry,
    text: string,
    images: string[] | undefined,
    onEvent: (event: ParsedEvent) => void,
    forceNew = false,
    yoloMode = false,
    systemPrompt?: string,
    model?: string,
    files?: string[]
  ): Promise<number | null> {
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

    const child = spawn(CLAUDE_BIN, args, {
      cwd: entry.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CONFIG_DIR: getActiveConfigDir() },
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

    // Forward stderr lines as error events so the client knows something went wrong.
    // Filter out Claude CLI usage/billing warnings — they're informational, not errors,
    // and pollute the response text when appended by the client's setError handler.
    child.stderr!.on("data", (chunk: Buffer) => {
      const errText = chunk.toString("utf-8").trim();
      if (!errText) return;
      rawStderr += errText + "\n";
      if (isUsageWarning(errText)) {
        console.log(`[claude] Usage warning (session ${sessionId}): ${errText}`);
        return;
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
          resolve(
            this.spawnClaude(sessionId, entry, text, images, onEvent, true, yoloMode, systemPrompt, model, files)
          );
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
          resolve(
            this.spawnClaude(sessionId, entry, text, images, onEvent, false, yoloMode, systemPrompt, model, files)
          );
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

  private spawnKimi(
    sessionId: string,
    entry: SessionEntry,
    text: string,
    images: string[] | undefined,
    onEvent: (event: ParsedEvent) => void,
    yoloMode = false,
    systemPrompt?: string,
    _model?: string,
    files?: string[]
  ): Promise<number | null> {
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
      sessionId,
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

        // Parse each JSON line from stdout
        const lines = rawStdout.split("\n").map((l) => l.trim()).filter(Boolean);
        let emittedText = false;

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.role === "assistant" && Array.isArray(obj.content)) {
              for (const block of obj.content) {
                if (block.type === "text" && block.text) {
                  onEvent({ kind: "delta", text: block.text });
                  emittedText = true;
                }
                // thinking blocks are skipped to avoid cluttering output
              }
            }
            // tool_calls and tool results are emitted inline as text by kimi,
            // so we don't need special handling here.
          } catch {
            // Ignore non-JSON lines
          }
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

  /** Returns session IDs that have an active Claude process. */
  getBusySessions(): string[] {
    const busy: string[] = [];
    for (const [id, entry] of this.sessions) {
      if (entry.process) busy.push(id);
    }
    return busy;
  }

  /** Send SIGTERM to the running process, escalate to SIGKILL after 5s if still alive. */
  abort(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    // Always clear spawnLock so the session is no longer considered busy
    entry.spawnLock = null;

    if (!entry.process) return;

    const child = entry.process;
    entry.process = null;

    child.kill("SIGTERM");

    // Escalate to SIGKILL if process hasn't exited after 5 seconds
    const killTimer = setTimeout(() => {
      if (!child.killed) {
        console.warn(`[process-manager] Process for session ${sessionId} didn't respond to SIGTERM, sending SIGKILL`);
        child.kill("SIGKILL");
      }
    }, 5_000);

    // Don't block graceful shutdown waiting for this timer
    killTimer.unref();
  }

  /** Abort any running process and remove the session from the map. */
  deleteSession(sessionId: string): void {
    this.abort(sessionId);
    this.sessions.delete(sessionId);
  }
}
