import type { ParsedEvent } from "./types.js";
import { getActiveProvider } from "../settings/store.js";
import { getEngineOrDefault } from "../engine/registry.js";
import type { EngineSessionState } from "../engine/types.js";

interface SessionEntry extends EngineSessionState {
  /** Lock to prevent concurrent sendMessage calls */
  spawnLock: Promise<any> | null;
  /** Engine that last spawned for this session, so abort tears down the same way */
  spawnedEngineId: string;
  /** Per-session engine (CLI harness). Falls back to the provider, then the global setting. */
  engineId?: string;
  /** Per-session provider (env selection). Falls back to the global setting. */
  providerId?: string;
}

/** Per-session engine/provider overrides carried from SessionMeta into the spawn path. */
export interface SessionEngineOptions {
  engineId?: string;
  providerId?: string;
}

/** What a resolved session actually spawns: which harness, and whose env. */
interface ResolvedEngine {
  engineId: string;
  providerId?: string;
}

export class ProcessManager {
  private sessions: Map<string, SessionEntry> = new Map();

  /** Register a new session (does not spawn anything yet). Skips if already registered. */
  createSession(
    id: string,
    workingDir: string,
    isFirstMessage = true,
    engine?: SessionEngineOptions
  ): void {
    if (this.sessions.has(id)) return;
    this.sessions.set(id, {
      process: null,
      isFirstMessage,
      workingDir,
      spawnLock: null,
      kimiSessionKey: id,
      spawnedEngineId: "claude",
      engineId: engine?.engineId,
      providerId: engine?.providerId,
    });
  }

  /**
   * Set (or clear) the per-session engine/provider used on the next spawn.
   * One chat = one folder + one provider + one model + one engine, so the
   * session's own settings win over the global provider selection.
   */
  configureSession(id: string, engine: SessionEngineOptions): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    entry.engineId = engine.engineId;
    entry.providerId = engine.providerId;
  }

  /** Point an existing session at a different folder. */
  updateWorkingDir(id: string, workingDir: string): void {
    const entry = this.sessions.get(id);
    if (entry) entry.workingDir = workingDir;
  }

  /**
   * Resolve which harness to spawn for this session, and which provider env
   * it runs with.
   *
   * Precedence: per-call override, then the session's own engine/provider,
   * then the global provider setting.
   *
   * engineId picks the harness directly. A providerId on its own maps through
   * the engine registry: "kimi" and "code-puppy" are engines in their own
   * right, while "claude"/"anthropic"/"openrouter" are all providers that run
   * on the claude harness and differ only in the env it is spawned with
   * (getEngineOrDefault falls back to claude for any id it does not know).
   */
  private resolveEngine(
    entry: SessionEntry,
    override?: SessionEngineOptions
  ): ResolvedEngine | null {
    const engineId = override?.engineId ?? entry.engineId;
    const providerId = override?.providerId ?? entry.providerId;

    if (engineId) {
      return { engineId: getEngineOrDefault(engineId).id, providerId };
    }
    if (providerId) {
      return { engineId: getEngineOrDefault(providerId).id, providerId };
    }

    const active = getActiveProvider();
    if (!active) return null;
    // The global setting is a provider id too, so map it the same way.
    return { engineId: getEngineOrDefault(active).id, providerId: active };
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
    files?: string[],
    engine?: SessionEngineOptions
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
    const resolved = this.resolveEngine(entry, engine);
    if (!resolved) {
      return Promise.reject(new Error("No provider selected. Go to Settings and choose Claude or Kimi."));
    }

    const selected = getEngineOrDefault(resolved.engineId);
    entry.spawnedEngineId = selected.id;

    const spawnPromise = selected.spawn({
      sessionId,
      state: entry,
      text,
      images,
      files,
      systemPrompt,
      model,
      yoloMode,
      providerId: resolved.providerId,
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

    getEngineOrDefault(entry.spawnedEngineId).abort(entry, sessionId);
  }

  /** Abort any running process and remove the session from the map. */
  deleteSession(sessionId: string): void {
    this.abort(sessionId);
    this.sessions.delete(sessionId);
  }
}
