import fs from "fs";
import { spawn, ChildProcess, execSync } from "child_process";
import type { ParsedEvent } from "./types.js";
import { StreamParser } from "./stream-parser.js";
import { getActiveConfigDir } from "../settings/store.js";

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
    model?: string
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
    const spawnPromise = this.spawnClaude(sessionId, entry, text, images, onEvent, false, yoloMode, systemPrompt, model);
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
    model?: string
  ): Promise<number | null> {
    // Build the prompt: prepend image references if any
    let prompt = text;
    if (images && images.length > 0) {
      const imageLines = images
        .map((p) => `Please read this image: ${p}`)
        .join("\n");
      prompt = `${imageLines}\n\n${prompt}`;
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

    // Collect raw stdout to detect "No conversation found" errors
    let rawStdout = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      rawStdout += str;
      parser.feed(str);
    });

    // Forward stderr lines as error events so the client knows something went wrong
    child.stderr!.on("data", (chunk: Buffer) => {
      const errText = chunk.toString("utf-8").trim();
      if (errText) {
        onEvent({ kind: "error", message: errText });
      }
    });

    return new Promise<number | null>((resolve) => {
      child.on("close", (code) => {
        parser.flush();
        entry.process = null;

        // If --resume failed because no session exists, retry with --session-id
        if (
          code !== 0 &&
          !useSessionId &&
          !forceNew &&
          rawStdout.includes("No conversation found")
        ) {
          console.log(
            `[claude] Session ${sessionId} not found in Claude, retrying with --session-id`
          );
          entry.isFirstMessage = true;
          resolve(
            this.spawnClaude(sessionId, entry, text, images, onEvent, true, yoloMode, systemPrompt, model)
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
    if (!entry?.process) return;

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
