/**
 * Event-driven subagent follow-ups (S14-B, spec section 2).
 *
 * When a subagent reaches a terminal status the parent chat is told about it
 * as a new turn, rather than the orchestrator holding a turn open waiting for
 * it. That is the whole point of the two-lane model: the conversation lane
 * stays free while the work lane runs.
 *
 * This file is deliberately split in two:
 *
 *  - `FollowupService` owns the *policy* (dedupe, coalescing, the rate cap,
 *    idle vs busy) and talks to the outside world only through injected
 *    functions, so every rule in the spec is unit-testable without a socket,
 *    an engine, or a filesystem.
 *  - `createFollowupTurnRunner` owns the *mechanism* (emit the message, spawn
 *    the engine, stream it back) and is wired in `index.ts`.
 *
 * The socket payload the client consumes is documented in
 * `FOLLOWUP_CONTRACT.md` next to this file; keep the two in sync.
 */

import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type { SubagentStatus } from "./types.js";

/** `source` on the delivered turn. The client renders it as a system chip. */
export const FOLLOWUP_SOURCE = "agent-followup";
/** Completions landing within this window become one follow-up message. */
export const COALESCE_MS = 2_000;
/** Never more than one follow-up turn per session per this interval. */
export const MIN_INTERVAL_MS = 10_000;
/** How much of a subagent's result text the follow-up carries. */
export const SUMMARY_LIMIT = 1_500;
/** How often a held follow-up re-checks whether the session went idle. */
export const IDLE_POLL_MS = 500;
/** Give up on a follow-up whose turn will not start after this many tries. */
export const MAX_DELIVERY_ATTEMPTS = 6;

/** Terminal statuses that earn a follow-up. `queued`/`running` never do. */
const TERMINAL: ReadonlySet<string> = new Set<SubagentStatus>([
  "done",
  "error",
  "cancelled",
]);

/** The subset of a `subagent:end` payload a follow-up needs. */
export interface SubagentEndPayload {
  sessionId?: string;
  agentId?: string;
  name?: string;
  status?: string;
  resultText?: string;
  error?: string;
  truncated?: boolean;
}

/** One finished agent, waiting to be told to the orchestrator. */
export interface FollowupItem {
  agentId: string;
  name: string;
  status: string;
  summary: string;
}

/** What the service hands to `startTurn` once it decides to deliver. */
export interface FollowupTurn {
  sessionId: string;
  text: string;
  agentIds: string[];
}

export interface FollowupDeps {
  /** True while the parent session has an engine process running. */
  isBusy: (sessionId: string) => boolean;
  /** Start the actual turn. Rejecting puts the follow-up back in the queue. */
  startTurn: (turn: FollowupTurn) => void | Promise<unknown>;
  /** Socket emission into the parent session's room. */
  emit: (sessionId: string, event: string, payload: Record<string, unknown>) => void;
  /** Activity Log line emitter. Optional so tests can ignore it. */
  emitActivity?: (line: {
    sessionId: string;
    ts: string;
    kind: string;
    summary: string;
    detail?: string;
    subagentId?: string;
  }) => void;
  now?: () => number;
  /**
   * JSON file of agent ids already reported, so a restart cannot replay a
   * follow-up the user has already seen. Defaults to
   * `<dirname(sessionsFile)>/followups.json`; pass "" to disable persistence.
   */
  statePath?: string;
  coalesceMs?: number;
  minIntervalMs?: number;
  idlePollMs?: number;
}

interface SessionState {
  pending: FollowupItem[];
  timer: ReturnType<typeof setTimeout> | null;
  lastDeliveredAt: number;
  delivering: boolean;
  /** Consecutive failed delivery attempts; drives the retry backoff. */
  failures: number;
}

/** First `SUMMARY_LIMIT` chars of the result, or the error when there is one. */
export function summarizeEnd(payload: SubagentEndPayload): string {
  const status = payload.status ?? "ended";
  const raw =
    status === "error"
      ? payload.error || payload.resultText || "no output"
      : payload.resultText || payload.error || "no output";
  const flat = raw.trim() || "no output";
  return flat.length > SUMMARY_LIMIT ? flat.slice(0, SUMMARY_LIMIT) : flat;
}

/**
 * The exact text delivered as the follow-up turn. One block per agent, in
 * completion order, each naming the tool call that gets the untruncated text.
 */
export function formatFollowupMessage(items: FollowupItem[]): string {
  return items
    .map(
      (item) =>
        `[Agent ${item.name} ${item.status}] ${item.summary}\n` +
        `Call agent_result('${item.agentId}') for the full output.`
    )
    .join("\n\n");
}

export class FollowupService {
  private readonly sessions = new Map<string, SessionState>();
  /** Queued or delivered in this process. Guards against a repeated event. */
  private readonly seen = new Set<string>();
  /** Delivered, persisted across restarts. */
  private readonly reported = new Set<string>();

  private readonly deps: FollowupDeps;
  private readonly now: () => number;
  private readonly statePath: string;
  private readonly coalesceMs: number;
  private readonly minIntervalMs: number;
  private readonly idlePollMs: number;

  constructor(deps: FollowupDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.statePath = deps.statePath ?? "";
    this.coalesceMs = deps.coalesceMs ?? COALESCE_MS;
    this.minIntervalMs = deps.minIntervalMs ?? MIN_INTERVAL_MS;
    this.idlePollMs = deps.idlePollMs ?? IDLE_POLL_MS;
    this.loadReported();
  }

  /**
   * The SubagentManager's emitter feeds every `subagent:*` event through here;
   * everything but `subagent:end` is ignored.
   */
  handleSubagentEvent(eventName: string, payload: SubagentEndPayload): void {
    if (eventName !== "subagent:end") return;
    this.onSubagentEnd(payload);
  }

  onSubagentEnd(payload: SubagentEndPayload): void {
    const sessionId = payload.sessionId;
    const agentId = payload.agentId;
    if (!sessionId || !agentId) return;
    const status = payload.status ?? "";
    if (!TERMINAL.has(status)) return;
    // Restart-safe: an agent reported before (this run or a previous one)
    // never produces a second follow-up.
    if (this.seen.has(agentId) || this.reported.has(agentId)) return;

    this.seen.add(agentId);
    const item: FollowupItem = {
      agentId,
      name: payload.name || agentId,
      status,
      summary: summarizeEnd(payload),
    };

    const state = this.stateFor(sessionId);
    state.pending.push(item);

    this.deps.emit(sessionId, "followup:queued", { sessionId, agentId, status });
    this.activity(sessionId, "subagent_end", `follow-up queued: ${item.name} ${status}`, agentId);

    this.schedule(sessionId);
  }

  /** Drop every timer. Called from graceful shutdown and from tests. */
  dispose(): void {
    for (const state of this.sessions.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
  }

  /** Test/introspection helper: agent ids waiting for delivery. */
  pendingFor(sessionId: string): string[] {
    return (this.sessions.get(sessionId)?.pending ?? []).map((i) => i.agentId);
  }

  // -- internals -----------------------------------------------------------

  private stateFor(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        pending: [],
        timer: null,
        lastDeliveredAt: 0,
        delivering: false,
        failures: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * Arm the delivery timer. An armed timer is never re-armed by a later
   * completion: that is what makes coalescing bounded rather than a window a
   * steady stream of agents could push forward forever.
   */
  private schedule(sessionId: string, minDelayMs?: number): void {
    const state = this.stateFor(sessionId);
    if (state.timer || state.delivering) return;
    if (state.pending.length === 0) return;

    const sinceLast = this.now() - state.lastDeliveredAt;
    const rateWait = state.lastDeliveredAt
      ? Math.max(0, this.minIntervalMs - sinceLast)
      : 0;
    const delay = Math.max(minDelayMs ?? this.coalesceMs, rateWait);

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.fire(sessionId);
    }, delay);
  }

  private async fire(sessionId: string): Promise<void> {
    const state = this.stateFor(sessionId);
    if (state.pending.length === 0) return;

    // Busy: hold everything and look again shortly. Anything that finishes
    // meanwhile merges into the same message.
    if (this.deps.isBusy(sessionId)) {
      this.schedule(sessionId, this.idlePollMs);
      return;
    }

    const items = state.pending;
    state.pending = [];
    state.delivering = true;
    const agentIds = items.map((i) => i.agentId);
    const text = formatFollowupMessage(items);

    try {
      await this.deps.startTurn({ sessionId, text, agentIds });
      state.lastDeliveredAt = this.now();
      for (const id of agentIds) this.reported.add(id);
      this.persistReported();
      this.deps.emit(sessionId, "followup:delivered", { sessionId, agentIds, text });
      this.activity(
        sessionId,
        "subagent_end",
        `follow-up delivered: ${agentIds.length} agent${agentIds.length === 1 ? "" : "s"}`,
        agentIds[0],
        text
      );
      state.failures = 0;
    } catch (err) {
      // The session went busy between the idle check and the spawn (a user
      // message won the race). Put the items back, oldest first, and retry.
      state.pending = [...items, ...state.pending];
      state.failures++;
      console.warn(
        `[followups] delivery failed for ${sessionId} (attempt ${state.failures}):`,
        err
      );
      // Some failures are permanent (no provider selected, a deleted session).
      // Retrying those forever would busy-loop, so give up loudly after a few
      // backed-off attempts rather than retrying twice a second.
      if (state.failures >= MAX_DELIVERY_ATTEMPTS) {
        const dropped = state.pending.map((i) => i.agentId);
        state.pending = [];
        state.failures = 0;
        for (const id of dropped) this.reported.add(id);
        this.persistReported();
        this.activity(
          sessionId,
          "warning",
          `follow-up dropped after ${MAX_DELIVERY_ATTEMPTS} attempts: ${
            err instanceof Error ? err.message : String(err)
          }`,
          dropped[0]
        );
      }
    } finally {
      state.delivering = false;
      // Exponential backoff on repeated failure, capped, so a permanently
      // broken session cannot spin the event loop.
      const retryDelay =
        state.failures > 0
          ? Math.min(this.idlePollMs * 2 ** state.failures, 30_000)
          : this.idlePollMs;
      this.schedule(sessionId, retryDelay);
    }
  }

  private activity(
    sessionId: string,
    kind: string,
    summary: string,
    subagentId?: string,
    detail?: string
  ): void {
    this.deps.emitActivity?.({
      sessionId,
      ts: new Date(this.now()).toISOString(),
      kind,
      summary,
      ...(detail ? { detail } : {}),
      ...(subagentId ? { subagentId } : {}),
    });
  }

  private loadReported(): void {
    if (!this.statePath) return;
    try {
      const raw = fs.readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      const ids = Array.isArray(parsed)
        ? parsed
        : (parsed as { reported?: unknown })?.reported;
      if (Array.isArray(ids)) {
        for (const id of ids) if (typeof id === "string") this.reported.add(id);
      }
    } catch {
      // Missing or corrupt file just means nothing was reported yet.
    }
  }

  private persistReported(): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      // Bounded: only the most recent ids matter, an agent id is never reused.
      const ids = [...this.reported].slice(-500);
      fs.writeFileSync(
        this.statePath,
        JSON.stringify({ reported: ids }, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.warn("[followups] could not persist reported ids:", err);
    }
  }
}

/** A fresh message id for the delivered follow-up turn. */
export function newFollowupMessageId(): string {
  return uuidv4();
}

// -- the turn runner --------------------------------------------------------

/**
 * Everything the runner needs from the server, passed in rather than imported
 * so `index.ts` stays the only place that knows about the real instances.
 *
 * `sendMessage` mirrors `ProcessManager.sendMessage`'s first arguments; the
 * runner deliberately skips model routing and tier escalation, which belong to
 * a user turn: a follow-up is a short "tell the user what came back" turn on
 * the session's own model.
 */
export interface FollowupTurnRunnerDeps {
  getSession: (sessionId: string) => {
    workingDir: string;
    engineId?: string;
    providerId?: string;
    model?: string;
    systemPrompt?: string;
    yoloMode?: boolean;
    name?: string;
  } | null;
  emit: (sessionId: string, event: string, payload: Record<string, unknown>) => void;
  /** Persist a message so reloading the chat shows the follow-up exchange. */
  persist: (msg: {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    text: string;
    timestamp: string;
    source?: string;
    kind?: string;
    cost?: number;
    durationMs?: number;
  }) => void;
  sendMessage: (
    sessionId: string,
    text: string,
    // Structurally a ParsedEvent; typed loosely so this module imports no
    // engine types and stays testable with plain objects.
    onEvent: (event: any) => void,
    opts: {
      yoloMode: boolean;
      systemPrompt?: string;
      model?: string;
      engineId?: string;
      providerId?: string;
    }
  ) => Promise<number | null>;
  /** Builds the orchestrator prompt for this session. */
  buildPrompt: (session: {
    engineId?: string;
    systemPrompt?: string;
    workingDir: string;
  }) => string;
  now?: () => number;
}

/**
 * The concrete `startTurn` for `FollowupService`.
 *
 * Resolves as soon as the turn is under way (the user message is on the wire
 * and the engine has been asked to spawn), NOT when the reply finishes: the
 * service's coalescing and rate-cap clocks measure how often follow-ups are
 * *started*, and rejecting here is what signals "the session was busy after
 * all, requeue me".
 */
export function createFollowupTurnRunner(
  deps: FollowupTurnRunnerDeps
): (turn: FollowupTurn) => Promise<void> {
  const now = deps.now ?? (() => Date.now());

  return async function runFollowupTurn(turn: FollowupTurn): Promise<void> {
    const { sessionId, text, agentIds } = turn;
    const session = deps.getSession(sessionId);
    if (!session) throw new Error(`Unknown session for follow-up: ${sessionId}`);

    const ts = new Date(now()).toISOString();
    const userMsgId = newFollowupMessageId();
    const assistantMsgId = newFollowupMessageId();

    let assistantText = "";
    let gotDeltas = false;
    let streamEnded = false;

    const onEvent = (event: any) => {
      switch (event.kind) {
        case "delta": {
          if (event.parentToolUseId) break;
          gotDeltas = true;
          assistantText += String(event.text ?? "");
          deps.emit(sessionId, "message:stream:delta", {
            sessionId,
            messageId: assistantMsgId,
            delta: String(event.text ?? ""),
          });
          break;
        }
        case "assistant_complete": {
          if (event.parentToolUseId || gotDeltas) break;
          const blocks = (event.content ?? []) as { type: string; text?: string }[];
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              assistantText += block.text;
              deps.emit(sessionId, "message:stream:delta", {
                sessionId,
                messageId: assistantMsgId,
                delta: block.text,
              });
            }
          }
          gotDeltas = true;
          break;
        }
        case "tool_use_start":
          deps.emit(sessionId, "message:stream:tool", {
            sessionId,
            messageId: assistantMsgId,
            tool: {
              id: event.toolId,
              name: event.toolName,
              input: event.input,
              parentToolUseId: event.parentToolUseId ?? null,
            },
          });
          break;
        case "tool_result":
          deps.emit(sessionId, "message:stream:tool_result", {
            sessionId,
            messageId: assistantMsgId,
            toolUseId: event.toolUseId,
            output: event.content,
            isError: event.isError ?? false,
            parentToolUseId: event.parentToolUseId ?? null,
          });
          break;
        case "result":
          streamEnded = true;
          deps.emit(sessionId, "message:stream:end", {
            sessionId,
            messageId: assistantMsgId,
            cost: event.totalCostUsd,
            durationMs: event.durationMs,
          });
          break;
        case "error":
          deps.emit(sessionId, "message:error", {
            sessionId,
            messageId: assistantMsgId,
            error: String(event.message ?? "Unknown error"),
          });
          break;
        default:
          break;
      }
    };

    const systemPrompt = deps.buildPrompt({
      engineId: session.engineId,
      systemPrompt: session.systemPrompt,
      workingDir: session.workingDir,
    });

    // Spawn FIRST, emit the chip second. `sendMessage` rejects immediately
    // when the session turned busy between the service's idle check and here,
    // and a follow-up that never ran must leave no message behind: the items
    // go back in the queue and the next delivery emits a fresh pair of ids.
    // No engine event can arrive in between, since a child process's output
    // is a macrotask and the two awaits below are microtasks.
    let turnStarted = false;
    let spawnFailed = false;
    let spawnError: unknown;

    const pending = deps
      .sendMessage(sessionId, text, onEvent, {
        yoloMode: session.yoloMode === true,
        systemPrompt: systemPrompt || undefined,
        model: session.model,
        engineId: session.engineId,
        providerId: session.providerId,
      })
      .then(
        () => {},
        (err: unknown) => {
          if (!turnStarted) {
            spawnFailed = true;
            spawnError = err;
            return;
          }
          deps.emit(sessionId, "message:error", {
            sessionId,
            messageId: assistantMsgId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      );

    await Promise.resolve();
    await Promise.resolve();
    if (spawnFailed) throw spawnError;
    turnStarted = true;

    // The message the orchestrator is answering. `role: "system"` plus
    // `kind: "followup"` is what tells the client to draw a compact chip
    // instead of a user bubble (see FOLLOWUP_CONTRACT.md).
    deps.emit(sessionId, "message:user", {
      id: userMsgId,
      sessionId,
      role: "system",
      kind: "followup",
      source: FOLLOWUP_SOURCE,
      text,
      agentIds,
      timestamp: ts,
    });
    deps.persist({
      id: userMsgId,
      sessionId,
      // PersistedMessage has no "system" role; the kind/source fields are what
      // the client keys off when it reloads history.
      role: "user",
      text,
      timestamp: ts,
      source: FOLLOWUP_SOURCE,
      kind: "followup",
    });

    deps.emit(sessionId, "message:stream:start", {
      id: assistantMsgId,
      sessionId,
      role: "assistant",
      text: "",
      source: FOLLOWUP_SOURCE,
      timestamp: ts,
    });

    void pending.then(() => {
      if (!streamEnded) {
        deps.emit(sessionId, "message:stream:end", {
          sessionId,
          messageId: assistantMsgId,
        });
      }
      deps.persist({
        id: assistantMsgId,
        sessionId,
        role: "assistant",
        text: assistantText,
        timestamp: new Date(now()).toISOString(),
        source: FOLLOWUP_SOURCE,
      });
    });
  };
}
