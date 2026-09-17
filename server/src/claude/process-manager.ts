import type { ParsedEvent } from "./types.js";
import { getActiveProvider } from "../settings/store.js";
import { getEngineOrDefault } from "../engine/registry.js";
import type { EngineSessionState } from "../engine/types.js";

interface SessionEntry extends EngineSessionState {
  /** Lock to prevent concurrent sendMessage calls */
  spawnLock: Promise<any> | null;
  /** Engine that last spawned for this session, so abort tears down the same way */
  engineId: string;
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
      kimiSessionKey: id,
      engineId: "claude",
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
   * Spawn the active engine for the given session and stream parsed events
   * back via the provided callback.  Resolves when the process exits.
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
    if (!provider) {
      return Promise.reject(new Error("No provider selected. Go to Settings and choose Claude or Kimi."));
    }

    const engine = getEngineOrDefault(provider);
    entry.engineId = engine.id;

    const spawnPromise = engine.spawn({
      sessionId,
      state: entry,
      text,
      images,
      files,
      systemPrompt,
      model,
      yoloMode,
      onEvent,
    });
    entry.spawnLock = spawnPromise;

    // Clear the lock when done (success or failure)
    spawnPromise.finally(() => {
      entry.spawnLock = null;
    });

    return spawnPromise;
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

    getEngineOrDefault(entry.engineId).abort(entry, sessionId);
  }

  /** Abort any running process and remove the session from the map. */
  deleteSession(sessionId: string): void {
    this.abort(sessionId);
    this.sessions.delete(sessionId);
  }
}
