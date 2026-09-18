import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { ParsedEvent } from "../claude/types.js";
import type { Engine, EngineSessionState } from "../engine/types.js";
import { getEngine as getRegisteredEngine } from "../engine/registry.js";
import config from "../config.js";
import {
  RESULT_TEXT_LIMIT,
  toResultView,
  toStatusView,
  type ParentSessionInfo,
  type SpawnAgentInput,
  type SubagentRecord,
  type SubagentResultView,
  type SubagentStatus,
  type SubagentStatusView,
  type SubagentUsageEntry,
} from "./types.js";

/** Emits into the parent session's socket room. */
export type SubagentEmitter = (
  sessionId: string,
  event: string,
  payload: Record<string, unknown>
) => void;

export interface SubagentManagerOptions {
  /** Looks up the chat that is spawning. Returns null for an unknown chat. */
  getParent: (sessionId: string) => ParentSessionInfo | null;
  emit?: SubagentEmitter;
  /** Injectable for tests; defaults to the real engine registry. */
  getEngine?: (engineId: string) => Engine | undefined;
  /** Cost attribution hook, called once per finished subagent. */
  logUsage?: (entry: SubagentUsageEntry) => void;
  maxTotal?: number;
  maxPerSession?: number;
  subagentsDir?: string;
  now?: () => number;
}

interface Entry {
  record: SubagentRecord;
  state: EngineSessionState;
  engine: Engine;
  /** Resolves when the record reaches a terminal status. */
  settled: Promise<SubagentRecord>;
  resolveSettled: (record: SubagentRecord) => void;
  cancelRequested: boolean;
  startedAtMs: number;
  /** Text accumulated from `delta` events, the fallback when no result text. */
  streamedText: string;
  sawSuccessfulResult: boolean;
  transcriptOk: boolean;
}

/** A `spawn_agent` tool_use seen in the parent stream, waiting to be claimed. */
interface PendingToolUse {
  toolUseId: string;
  task: string | null;
}

function newAgentId(): string {
  return `sa_${crypto.randomBytes(6).toString("hex")}`;
}

export class SubagentError extends Error {}

/**
 * Owns the whole subagent lifecycle: a full `Engine` per subagent, so any
 * engine/model can be a subagent's brain regardless of the parent's engine.
 *
 * Deliberately NOT handed an `mcpConfig`: subagents get no `medusa` MCP
 * server, so they cannot spawn subagents of their own and the tree stays one
 * level deep.
 */
export class SubagentManager {
  private readonly entries = new Map<string, Entry>();
  /** Global FIFO of queued agent ids. */
  private readonly queue: string[] = [];
  private readonly pendingToolUses = new Map<string, PendingToolUse[]>();

  private readonly getParent: (sessionId: string) => ParentSessionInfo | null;
  private readonly emitEvent: SubagentEmitter;
  private readonly lookupEngine: (engineId: string) => Engine | undefined;
  private readonly logUsage: ((entry: SubagentUsageEntry) => void) | undefined;
  private readonly maxTotal: number;
  private readonly maxPerSession: number;
  private readonly subagentsDir: string;
  private readonly now: () => number;

  constructor(opts: SubagentManagerOptions) {
    this.getParent = opts.getParent;
    this.emitEvent = opts.emit ?? (() => {});
    this.lookupEngine = opts.getEngine ?? getRegisteredEngine;
    this.logUsage = opts.logUsage;
    this.maxTotal = opts.maxTotal ?? config.maxSubagentsTotal;
    this.maxPerSession = opts.maxPerSession ?? config.maxSubagentsPerSession;
    this.subagentsDir = opts.subagentsDir ?? config.subagentsDir;
    this.now = opts.now ?? (() => Date.now());
  }

  // -- parent tool_use correlation ----------------------------------------

  /**
   * Called by the socket handler when it sees a `spawn_agent` /
   * `mcp__medusa__spawn_agent` tool_use block in the parent's stream. The MCP
   * shim cannot know that id (the CLI never tells the tool its own call id),
   * so the manager matches spawns to blocks here: exact task text first, then
   * the oldest unclaimed block for that chat.
   */
  registerSpawnToolUse(
    sessionId: string,
    toolUseId: string,
    task: string | null
  ): void {
    const list = this.pendingToolUses.get(sessionId) ?? [];
    list.push({ toolUseId, task });
    // Bound the list so a chat that never spawns cannot grow it forever.
    while (list.length > 32) list.shift();
    this.pendingToolUses.set(sessionId, list);
  }

  /** Drop any unclaimed tool_use blocks for a chat (called when a turn ends). */
  clearSpawnToolUses(sessionId: string): void {
    this.pendingToolUses.delete(sessionId);
  }

  private claimToolUseId(sessionId: string, task: string): string | null {
    const list = this.pendingToolUses.get(sessionId);
    if (!list || list.length === 0) return null;
    let index = list.findIndex((p) => p.task !== null && p.task === task);
    if (index === -1) index = 0;
    const [claimed] = list.splice(index, 1);
    if (list.length === 0) this.pendingToolUses.delete(sessionId);
    return claimed?.toolUseId ?? null;
  }

  // -- spawn ---------------------------------------------------------------

  /**
   * Create a subagent. Resolves as soon as the record exists (queued or
   * running); use `waitFor()` for the `wait: true` case.
   */
  spawn(input: SpawnAgentInput): SubagentRecord {
    const parent = this.getParent(input.parentSessionId);
    if (!parent) {
      throw new SubagentError(`Unknown parent session: ${input.parentSessionId}`);
    }

    const task = (input.task ?? "").trim();
    if (!task) throw new SubagentError("task is required");

    const engineId = (input.engine || parent.engineId || "claude").trim();
    const engine = this.lookupEngine(engineId);
    if (!engine) throw new SubagentError(`Unknown engine: ${engineId}`);

    const cwd = this.resolveCwd(parent.workingDir, input.cwd);
    const model = input.model ?? parent.model ?? null;
    const id = newAgentId();
    const startedAt = new Date(this.now()).toISOString();

    const record: SubagentRecord = {
      id,
      parentSessionId: input.parentSessionId,
      parentToolUseId:
        input.parentToolUseId ?? this.claimToolUseId(input.parentSessionId, task),
      name: (input.name || "").trim() || this.deriveName(task),
      task,
      engineId: engine.id,
      model,
      cwd,
      // A subagent inherits yolo from its parent and cannot escalate:
      // `spawn_agent` has no yolo parameter, by design (spec A.8).
      yolo: parent.yoloMode,
      status: "queued",
      startedAt,
      endedAt: null,
      resultText: "",
      truncated: false,
      transcriptPath: path.join(
        this.subagentsDir,
        input.parentSessionId,
        `${id}.jsonl`
      ),
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      toolCallCount: 0,
      engineSessionId: crypto.randomUUID(),
    };

    let resolveSettled!: (r: SubagentRecord) => void;
    const settled = new Promise<SubagentRecord>((resolve) => {
      resolveSettled = resolve;
    });

    this.entries.set(id, {
      record,
      state: {
        process: null,
        isFirstMessage: true,
        workingDir: cwd,
        kimiSessionKey: record.engineSessionId,
      },
      engine,
      settled,
      resolveSettled,
      cancelRequested: false,
      startedAtMs: this.now(),
      streamedText: "",
      sawSuccessfulResult: false,
      transcriptOk: true,
    });

    this.queue.push(id);
    this.pump();
    return this.entries.get(id)!.record;
  }

  /** Resolves when the subagent reaches a terminal status. */
  waitFor(agentId: string): Promise<SubagentRecord> {
    const entry = this.entries.get(agentId);
    if (!entry) return Promise.reject(new SubagentError(`Unknown agent: ${agentId}`));
    return entry.settled;
  }

  /**
   * `cwd` must stay inside the parent chat's folder. Same guard shape as the
   * ACP engine's `resolveInsideCwd`.
   */
  private resolveCwd(workingDir: string, raw: string | undefined): string {
    const base = path.resolve(workingDir);
    if (!raw) return base;
    const target = path.resolve(base, raw);
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new SubagentError(
        `cwd escapes the chat's working directory: ${raw}`
      );
    }
    return target;
  }

  private deriveName(task: string): string {
    const firstLine = task.split("\n")[0]!.trim();
    return firstLine.length > 48 ? `${firstLine.slice(0, 45)}...` : firstLine;
  }

  // -- scheduling ----------------------------------------------------------

  private runningCount(sessionId?: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.record.status !== "running") continue;
      if (sessionId && entry.record.parentSessionId !== sessionId) continue;
      count++;
    }
    return count;
  }

  /**
   * Start every queued subagent the caps allow.
   *
   * The queue is scanned in order and the first *eligible* entry starts, which
   * is FIFO within a chat while keeping one chat at its per-session cap from
   * head-of-line blocking another chat's work.
   */
  private pump(): void {
    for (;;) {
      if (this.runningCount() >= this.maxTotal) return;
      const index = this.queue.findIndex((id) => {
        const entry = this.entries.get(id);
        if (!entry) return false;
        return (
          this.runningCount(entry.record.parentSessionId) < this.maxPerSession
        );
      });
      if (index === -1) return;
      const [id] = this.queue.splice(index, 1);
      const entry = this.entries.get(id!);
      if (!entry) continue;
      this.start(entry);
    }
  }

  private start(entry: Entry): void {
    const { record } = entry;
    record.status = "running";
    record.startedAt = new Date(this.now()).toISOString();
    entry.startedAtMs = this.now();

    this.emitEvent(record.parentSessionId, "subagent:start", {
      sessionId: record.parentSessionId,
      agentId: record.id,
      parentToolUseId: record.parentToolUseId,
      name: record.name,
      task: record.task,
      engineId: record.engineId,
      model: record.model,
      cwd: record.cwd,
      startedAt: record.startedAt,
    });

    let promise: Promise<number | null>;
    try {
      promise = entry.engine.spawn({
        sessionId: record.engineSessionId,
        state: entry.state,
        text: record.task,
        model: record.model ?? undefined,
        yoloMode: record.yolo,
        onEvent: (event: ParsedEvent) => this.onEngineEvent(entry, event),
      });
    } catch (err) {
      // A synchronous throw out of spawn() is still a crash, not a hang.
      this.finish(entry, "error", err instanceof Error ? err.message : String(err));
      return;
    }

    promise.then(
      (code) => {
        if (entry.cancelRequested) {
          this.finish(entry, "cancelled");
        } else if (entry.sawSuccessfulResult || code === 0) {
          this.finish(entry, "done");
        } else {
          this.finish(
            entry,
            "error",
            `${record.engineId} exited with code ${code ?? "null"}`
          );
        }
      },
      (err: unknown) => {
        // The child crashed or never started: still a terminal status, and
        // `subagent:end` is still emitted so no card is left spinning.
        if (entry.cancelRequested) {
          this.finish(entry, "cancelled");
          return;
        }
        this.finish(entry, "error", err instanceof Error ? err.message : String(err));
      }
    );
  }

  // -- streaming -----------------------------------------------------------

  private onEngineEvent(entry: Entry, event: ParsedEvent): void {
    const { record } = entry;
    this.appendTranscript(entry, event);

    switch (event.kind) {
      case "delta":
        entry.streamedText += event.text;
        this.emitEvent(record.parentSessionId, "subagent:delta", {
          sessionId: record.parentSessionId,
          agentId: record.id,
          parentToolUseId: record.parentToolUseId,
          delta: event.text,
        });
        break;
      case "tool_use_start":
        record.toolCallCount++;
        this.emitEvent(record.parentSessionId, "subagent:tool", {
          sessionId: record.parentSessionId,
          agentId: record.id,
          parentToolUseId: record.parentToolUseId,
          tool: { id: event.toolId, name: event.toolName, input: event.input },
        });
        break;
      case "tool_result":
        this.emitEvent(record.parentSessionId, "subagent:tool", {
          sessionId: record.parentSessionId,
          agentId: record.id,
          parentToolUseId: record.parentToolUseId,
          toolResult: {
            toolUseId: event.toolUseId,
            output: event.content,
            isError: event.isError ?? false,
          },
        });
        break;
      case "result":
        if (event.success) entry.sawSuccessfulResult = true;
        if (event.result) entry.streamedText = event.result;
        if (typeof event.totalCostUsd === "number") {
          record.usage.costUsd = event.totalCostUsd;
        }
        if (event.usage) {
          record.usage.inputTokens = event.usage.input_tokens ?? 0;
          record.usage.outputTokens = event.usage.output_tokens ?? 0;
        }
        if (!event.success && event.error) record.error = event.error;
        break;
      case "error":
        record.error = event.message;
        break;
      default:
        break;
    }

    // The generic passthrough the spec names (A.6). `subagent:delta` and
    // `subagent:tool` above are the narrow convenience events; both are
    // emitted so a client can subscribe to whichever it prefers.
    this.emitEvent(record.parentSessionId, "subagent:event", {
      sessionId: record.parentSessionId,
      agentId: record.id,
      parentToolUseId: record.parentToolUseId,
      event,
    });
  }

  private appendTranscript(entry: Entry, event: ParsedEvent): void {
    if (!entry.transcriptOk) return;
    try {
      fs.mkdirSync(path.dirname(entry.record.transcriptPath), { recursive: true });
      fs.appendFileSync(
        entry.record.transcriptPath,
        `${JSON.stringify({ ts: new Date(this.now()).toISOString(), event })}\n`,
        "utf-8"
      );
    } catch (err) {
      // A transcript is a nicety; losing it must not kill the run.
      entry.transcriptOk = false;
      console.warn(
        `[subagents] transcript write failed for ${entry.record.id}:`,
        err
      );
    }
  }

  // -- completion ----------------------------------------------------------

  private finish(entry: Entry, status: SubagentStatus, error?: string): void {
    const { record } = entry;
    if (record.endedAt) return;

    record.status = status;
    record.endedAt = new Date(this.now()).toISOString();
    if (error && !record.error) record.error = error;

    const full = entry.streamedText;
    if (full.length > RESULT_TEXT_LIMIT) {
      record.resultText = full.slice(0, RESULT_TEXT_LIMIT);
      record.truncated = true;
    } else {
      record.resultText = full;
      record.truncated = false;
    }

    const durationMs = Math.max(0, this.now() - entry.startedAtMs);

    this.emitEvent(record.parentSessionId, "subagent:end", {
      sessionId: record.parentSessionId,
      agentId: record.id,
      parentToolUseId: record.parentToolUseId,
      // The card already knows the name from `subagent:start`; the follow-up
      // service (S14-B) only ever sees this event, so it carries it too.
      name: record.name,
      status: record.status,
      resultText: record.resultText,
      truncated: record.truncated,
      usage: { ...record.usage },
      durationMs,
      endedAt: record.endedAt,
      ...(record.error ? { error: record.error } : {}),
    });

    try {
      this.logUsage?.({
        sessionId: record.parentSessionId,
        agentId: record.id,
        role: "subagent",
        engineId: record.engineId,
        model: record.model,
        durationMs,
        usage: { ...record.usage },
      });
    } catch (err) {
      console.warn(`[subagents] usage logging failed for ${record.id}:`, err);
    }

    entry.resolveSettled(record);
    this.pump();
  }

  // -- cancellation --------------------------------------------------------

  /** Cancel one subagent, queued or running. Returns false for an unknown id. */
  cancel(agentId: string): boolean {
    const entry = this.entries.get(agentId);
    if (!entry) return false;
    if (entry.record.endedAt) return false;

    entry.cancelRequested = true;

    if (entry.record.status === "queued") {
      const index = this.queue.indexOf(agentId);
      if (index !== -1) this.queue.splice(index, 1);
      this.finish(entry, "cancelled");
      return true;
    }

    // Running: the engine's own abort (SIGTERM then SIGKILL) settles the
    // spawn promise, and the rejection/resolution handler calls finish().
    try {
      entry.engine.abort(entry.state, entry.record.engineSessionId);
    } catch (err) {
      console.warn(`[subagents] abort failed for ${agentId}:`, err);
      this.finish(entry, "cancelled");
    }
    return true;
  }

  /** A subagent must never outlive its parent turn. */
  cancelForParent(parentSessionId: string): number {
    let cancelled = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.record.parentSessionId !== parentSessionId) continue;
      if (entry.record.endedAt) continue;
      if (this.cancel(entry.record.id)) cancelled++;
    }
    this.clearSpawnToolUses(parentSessionId);
    return cancelled;
  }

  /** Graceful-shutdown hook. */
  cancelAll(): number {
    let cancelled = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.record.endedAt) continue;
      if (this.cancel(entry.record.id)) cancelled++;
    }
    return cancelled;
  }

  // -- reads ---------------------------------------------------------------

  get(agentId: string): SubagentRecord | undefined {
    return this.entries.get(agentId)?.record;
  }

  /** Scoped to one chat: a chat can never see another chat's subagents. */
  getForParent(agentId: string, parentSessionId: string): SubagentRecord | undefined {
    const record = this.get(agentId);
    if (!record || record.parentSessionId !== parentSessionId) return undefined;
    return record;
  }

  status(agentId: string, parentSessionId: string): SubagentStatusView | undefined {
    const record = this.getForParent(agentId, parentSessionId);
    return record ? toStatusView(record) : undefined;
  }

  result(agentId: string, parentSessionId: string): SubagentResultView | undefined {
    const record = this.getForParent(agentId, parentSessionId);
    return record ? toResultView(record) : undefined;
  }

  listForParent(parentSessionId: string): SubagentStatusView[] {
    const out: SubagentStatusView[] = [];
    for (const entry of this.entries.values()) {
      if (entry.record.parentSessionId !== parentSessionId) continue;
      out.push(toStatusView(entry.record));
    }
    return out;
  }

  /**
   * Every subagent across every chat, each tagged with its parent session id
   * so a cross-chat view (the Tasks panel, S15) can hydrate on load without
   * looping over every known session id. Not part of the MCP tool surface:
   * only the app's own authenticated client calls this, via `GET
   * /api/subagents?all=1`.
   */
  listAll(): (SubagentStatusView & { parentSessionId: string })[] {
    const out: (SubagentStatusView & { parentSessionId: string })[] = [];
    for (const entry of this.entries.values()) {
      out.push({ ...toStatusView(entry.record), parentSessionId: entry.record.parentSessionId });
    }
    return out;
  }
}
