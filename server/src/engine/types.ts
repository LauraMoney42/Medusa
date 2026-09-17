import type { ChildProcess } from "child_process";
import type { ParsedEvent } from "../claude/types.js";

/** The event shape every engine emits. Socket/hub layers consume this unchanged. */
export type ClaudeStreamEvent = ParsedEvent;

/**
 * Informational engine-level notice with no ParsedEvent equivalent, e.g. an
 * ACP agent's plan update. Additive only: the socket handler switches on
 * `kind` with no default branch, so consumers that don't know this kind
 * ignore it. Kept out of `ClaudeStreamEvent` on purpose so the existing
 * `(event: ParsedEvent) => void` callbacks keep type-checking.
 */
export interface ParsedSystemInfo {
  kind: "system";
  subtype: "info";
  text: string;
}

/** What an engine may emit internally, before narrowing to ClaudeStreamEvent. */
export type EngineStreamEvent = ClaudeStreamEvent | ParsedSystemInfo;

export interface ModelInfo {
  id: string;
  label: string;
}

/**
 * Per-session mutable state owned by ProcessManager but written by engines
 * (resume bookkeeping, the live child handle, Kimi's rotating session key).
 */
export interface EngineSessionState {
  process: ChildProcess | null;
  isFirstMessage: boolean;
  workingDir: string;
  kimiSessionKey: string;
}

export interface EngineSpawnOptions {
  sessionId: string;
  state: EngineSessionState;
  text: string;
  images?: string[];
  files?: string[];
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  /** Force a brand-new session instead of resuming, used by the retry paths. */
  forceNew?: boolean;
  onEvent: (event: ClaudeStreamEvent) => void;
}

export interface Engine {
  id: string;
  displayName: string;
  /** Resolves with the child's exit code (null when it never started). */
  spawn(opts: EngineSpawnOptions): Promise<number | null>;
  abort(state: EngineSessionState, sessionId: string): void;
  listModels(): Promise<ModelInfo[]>;
}

/** Shared SIGTERM-then-SIGKILL teardown; both CLI engines kill the same way. */
export function abortChildProcess(
  state: EngineSessionState,
  sessionId: string
): void {
  if (!state.process) return;

  const child = state.process;
  state.process = null;

  child.kill("SIGTERM");

  const killTimer = setTimeout(() => {
    if (!child.killed) {
      console.warn(`[process-manager] Process for session ${sessionId} didn't respond to SIGTERM, sending SIGKILL`);
      child.kill("SIGKILL");
    }
  }, 5_000);

  // Don't block graceful shutdown waiting for this timer
  killTimer.unref();
}
