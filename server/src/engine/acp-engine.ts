import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import type { ChildProcess } from "child_process";
import {
  abortChildProcess,
  type ClaudeStreamEvent,
  type Engine,
  type EngineSessionState,
  type EngineSpawnOptions,
  type EngineStreamEvent,
  type ModelInfo,
} from "./types.js";

// ---------------------------------------------------------------------------
// Minimal JSON-RPC 2.0 client for the Agent Client Protocol (ACP).
//
// Why hand-rolled instead of `@agentclientprotocol/sdk`: Medusa's server has a
// deliberately small dependency list, the wire format is one JSON object per
// line over the child's stdio (the same framing stream-parser.ts already
// handles), and we only need six methods. Adding an npm dependency for ~150
// lines of framing was not worth it. Wire shapes follow the v1 spec at
// https://agentclientprotocol.com.
// ---------------------------------------------------------------------------

type JsonRpcId = number | string;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC error codes we return to the agent. */
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INTERNAL_ERROR = -32603;

/** Thrown by a client-side method handler to produce a JSON-RPC error reply. */
export class AcpRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

interface ConnectionHandlers {
  /** A `method` with no `id`: fire and forget. */
  onNotification: (method: string, params: Record<string, unknown>) => void;
  /** A `method` with an `id`: the agent is calling back into us. */
  onRequest: (
    method: string,
    params: Record<string, unknown>
  ) => Promise<unknown>;
}

/**
 * Line-delimited JSON-RPC over a child process's stdin/stdout.
 * Both directions are supported: ACP agents call back into the client for
 * file access and permission prompts.
 */
export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: ConnectionHandlers,
    private readonly logPrefix: string
  ) {
    child.stdout?.on("data", (chunk: Buffer) => {
      this.feed(chunk.toString("utf-8"));
    });
  }

  /** Feed raw stdout text; complete lines are parsed, partials are buffered. */
  feed(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Agents are supposed to keep stdout pure JSON-RPC, but a stray
        // banner or debug print must not tear down the whole turn.
        console.warn(`${this.logPrefix} Ignoring non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    // Incoming request from the agent (has both method and id)
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      const id = msg.id;
      this.handlers
        .onRequest(msg.method, msg.params ?? {})
        .then((result) => this.write({ jsonrpc: "2.0", id, result: result ?? {} }))
        .catch((err: unknown) => {
          const code = err instanceof AcpRpcError ? err.code : RPC_INTERNAL_ERROR;
          const message = err instanceof Error ? err.message : String(err);
          this.write({ jsonrpc: "2.0", id, error: { code, message } });
        });
      return;
    }

    // Notification from the agent
    if (msg.method) {
      try {
        this.handlers.onNotification(msg.method, msg.params ?? {});
      } catch (err) {
        console.warn(`${this.logPrefix} Notification handler threw:`, err);
      }
      return;
    }

    // Response to one of our requests
    if (msg.id !== undefined && msg.id !== null) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private write(msg: JsonRpcMessage): void {
    if (this.closed) return;
    try {
      this.child.stdin?.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      console.warn(`${this.logPrefix} Failed to write to agent stdin:`, err);
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`${method}: agent connection is closed`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Reject every in-flight request; called when the child dies. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// ACP wire shapes we care about (subset of the v1 schema)
// ---------------------------------------------------------------------------

interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
  };
  agentInfo?: { name?: string; title?: string; version?: string };
}

interface AcpToolCallUpdate {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path?: string; line?: number }>;
  content?: unknown[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AcpEngineOptions {
  id: string;
  displayName: string;
  /** Executable name or absolute path; resolved against PATH on first spawn. */
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  /**
   * Fallback working directory. The session's own `state.workingDir` always
   * wins; this is only used when a session has none.
   */
  cwd?: string;
  /** Static model list surfaced in the UI (ACP has no model-listing method). */
  models?: ModelInfo[];
  /**
   * Runs once before each spawn. Used by the code-puppy engine to pre-seed a
   * config file so the agent's first-run wizard never blocks on stdin.
   */
  prepare?: () => void;
}

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed"]);

/**
 * Generic engine for any agent that speaks the Agent Client Protocol over
 * stdio: Code Puppy (`code-puppy --acp`), Goose (`goose acp`), Gemini CLI, etc.
 *
 * One child process is spawned per prompt turn, matching how the other Medusa
 * engines work. Continuity across turns is handled by remembering the ACP
 * session id and calling `session/load` when the agent advertises
 * `loadSession`; see `resumeSessions` below for the fallback.
 */
export class AcpEngine implements Engine {
  readonly id: string;
  readonly displayName: string;

  private readonly options: AcpEngineOptions;
  private resolvedBinary: string | null = null;

  /**
   * Medusa session id -> ACP session id, so a second message can resume.
   * Limitation: this map is in memory only. After a server restart (or for an
   * agent that does not advertise `loadSession`) the next message starts a
   * brand-new ACP session and the agent loses its conversation history.
   */
  private readonly acpSessions = new Map<string, string>();

  /** Live connections, so abort() can send session/cancel before SIGTERM. */
  private readonly live = new Map<
    string,
    { conn: AcpConnection; acpSessionId: string | null }
  >();

  constructor(options: AcpEngineOptions) {
    this.options = options;
    this.id = options.id;
    this.displayName = options.displayName;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.options.models ?? [];
  }

  /**
   * ACP's `session/cancel` is a notification the agent handles gracefully
   * (it cancels the in-flight task and kills any shells it started). We send
   * it first, then fall back to the shared SIGTERM/SIGKILL teardown because
   * most ACP agents install no SIGTERM handler of their own.
   */
  abort(state: EngineSessionState, sessionId: string): void {
    const entry = this.live.get(sessionId);
    if (entry?.acpSessionId) {
      try {
        entry.conn.notify("session/cancel", { sessionId: entry.acpSessionId });
      } catch {
        // Best effort; the SIGTERM below is the real guarantee.
      }
    }
    abortChildProcess(state, sessionId);
  }

  /** Resolve the CLI once, mirroring findClaudeBinary()'s candidate list. */
  private resolveBinary(): string {
    if (this.resolvedBinary) return this.resolvedBinary;
    const { command } = this.options;
    const candidates = [
      (() => {
        try {
          return execSync(`which ${command}`, { encoding: "utf-8" }).trim();
        } catch {
          return null;
        }
      })(),
      `/usr/local/bin/${command}`,
      `/opt/homebrew/bin/${command}`,
      `${process.env.HOME}/.local/bin/${command}`,
      `${process.env.HOME}/.venvs/${command}/bin/${command}`,
    ];

    for (const p of candidates) {
      if (!p) continue;
      try {
        const real = fs.realpathSync(p);
        fs.accessSync(real, fs.constants.X_OK);
        this.resolvedBinary = real;
        return real;
      } catch {
        // continue
      }
    }

    console.warn(`[${this.id}] Binary not found, falling back to '${command}'`);
    this.resolvedBinary = command;
    return command;
  }

  async spawn(opts: EngineSpawnOptions): Promise<number | null> {
    const { sessionId, state, text, images, files, systemPrompt, model, onEvent } =
      opts;
    const yoloMode = opts.yoloMode ?? false;
    const forceNew = opts.forceNew ?? false;
    const cwd = state.workingDir || this.options.cwd || process.cwd();
    const logPrefix = `[${this.id}]`;

    // The system/info event kind is additive (see engine/types.ts); the socket
    // handler's switch simply ignores kinds it doesn't know.
    const emit = (event: EngineStreamEvent) =>
      onEvent(event as ClaudeStreamEvent);

    try {
      this.options.prepare?.();
    } catch (err) {
      console.warn(`${logPrefix} prepare() failed:`, err);
    }

    const child = spawn(this.resolveBinary(), this.options.args ?? [], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.options.env },
    });
    state.process = child;

    // ACP agents log to stderr on purpose ("stdout is sacred"), so stderr is
    // diagnostic noise, not an error channel. Only surface it if the run fails.
    let stderrText = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      stderrText += s;
      console.log(`${logPrefix} stderr: ${s.trimEnd()}`);
    });

    // --- per-turn translation state -------------------------------------
    let acpSessionId: string | null = null;
    /**
     * session/load replays the whole conversation history back as
     * session/update notifications. Suppress them so old turns aren't
     * re-streamed into the chat as if they were new.
     */
    let replaying = false;
    const seenToolCalls = new Map<string, { title: string; kind: string }>();

    const renderToolContent = (content: unknown[] | undefined): string => {
      if (!Array.isArray(content)) return "";
      const parts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, any>;
        if (b?.type === "content" && b.content?.type === "text") {
          parts.push(String(b.content.text ?? ""));
        } else if (b?.type === "diff") {
          parts.push(
            `--- ${b.path ?? "(file)"}\n${String(b.oldText ?? "")}\n+++\n${String(b.newText ?? "")}`
          );
        } else if (b?.type === "terminal") {
          parts.push(`[terminal ${b.terminalId ?? ""}]`);
        } else if (b?.content?.type === "text") {
          parts.push(String(b.content.text ?? ""));
        }
      }
      return parts.filter(Boolean).join("\n");
    };

    const handleSessionUpdate = (params: Record<string, unknown>): void => {
      if (replaying) return;
      const update = params.update as Record<string, any> | undefined;
      if (!update) return;

      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const chunk = update.content;
          if (chunk?.type === "text" && chunk.text) {
            emit({ kind: "delta", text: String(chunk.text) });
          }
          break;
        }

        // Reasoning deltas have no ParsedEvent equivalent and would clutter
        // the transcript, so they are dropped (same call the kimi engine makes).
        case "agent_thought_chunk":
          break;

        case "tool_call":
        case "tool_call_update": {
          const tc = update as AcpToolCallUpdate;
          const toolId = tc.toolCallId ?? "unknown";
          const known = seenToolCalls.get(toolId);
          const title = tc.title ?? known?.title ?? "tool";
          const kind = tc.kind ?? known?.kind ?? "other";

          if (!known) {
            // A tool_call_update can arrive for a call we never saw start
            // (e.g. after a reconnect); synthesize the start so the UI pairs up.
            seenToolCalls.set(toolId, { title, kind });
            emit({
              kind: "tool_use_start",
              toolId,
              toolName: title,
              input: {
                kind,
                status: tc.status ?? "pending",
                ...(tc.locations ? { locations: tc.locations } : {}),
                ...(tc.rawInput ? { rawInput: tc.rawInput } : {}),
              },
            });
          } else {
            seenToolCalls.set(toolId, { title, kind });
          }

          const status = tc.status;
          if (status && TERMINAL_TOOL_STATUSES.has(status)) {
            const body = renderToolContent(tc.content);
            const header = `${title} [${kind}] ${status}`;
            emit({
              kind: "tool_result",
              toolUseId: toolId,
              content: body ? `${header}\n${body}` : header,
            });
          }
          break;
        }

        case "plan": {
          const entries = Array.isArray(update.entries) ? update.entries : [];
          const lines = entries.map((e: Record<string, any>) => {
            const mark =
              e.status === "completed" ? "x" : e.status === "in_progress" ? ">" : " ";
            return `[${mark}] ${e.content ?? ""}`;
          });
          emit({
            kind: "system",
            subtype: "info",
            text: `Plan update:\n${lines.join("\n")}`,
          });
          break;
        }

        // available_commands_update, current_mode_update, user_message_chunk:
        // nothing in Medusa's UI consumes these yet.
        default:
          break;
      }
    };

    // --- client-side callbacks the agent may invoke ----------------------

    /** Reject any path that resolves outside the session working directory. */
    const resolveInsideCwd = (raw: unknown): string => {
      if (typeof raw !== "string" || !raw) {
        throw new AcpRpcError(RPC_INTERNAL_ERROR, "path must be a non-empty string");
      }
      const base = path.resolve(cwd);
      const target = path.resolve(base, raw);
      if (target !== base && !target.startsWith(base + path.sep)) {
        throw new AcpRpcError(
          RPC_INTERNAL_ERROR,
          `path escapes the session working directory: ${raw}`
        );
      }
      return target;
    };

    const handleRequest = async (
      method: string,
      params: Record<string, unknown>
    ): Promise<unknown> => {
      switch (method) {
        case "session/request_permission": {
          // Medusa has no interactive permission plumbing yet (yoloMode is the
          // only knob the socket layer exposes), so this is deliberately
          // non-interactive: allow everything in yolo mode, reject everything
          // otherwise and tell the user why via a tool_result. When a
          // permission event/response round trip is added to the socket layer,
          // this is the single place to hook it in.
          const options = (params.options ?? []) as Array<{
            optionId?: string;
            kind?: string;
            name?: string;
          }>;
          const wanted = yoloMode
            ? ["allow_always", "allow_once"]
            : ["reject_once", "reject_always"];
          const pick =
            options.find((o) => wanted.includes(o.kind ?? "")) ?? options[0];

          const tc = (params.toolCall ?? {}) as AcpToolCallUpdate;
          const toolId = tc.toolCallId ?? "unknown";
          const title = tc.title ?? seenToolCalls.get(toolId)?.title ?? "tool";

          if (!pick?.optionId) {
            return { outcome: { outcome: "cancelled" } };
          }

          if (!yoloMode) {
            emit({
              kind: "tool_result",
              toolUseId: toolId,
              content:
                `Permission denied: "${title}" requires approval and this ` +
                `session is not in YOLO mode. Enable YOLO mode for this bot to ` +
                `let it run tools that need approval.`,
            });
          }

          return { outcome: { outcome: "selected", optionId: pick.optionId } };
        }

        case "fs/read_text_file": {
          const target = resolveInsideCwd(params.path);
          let content: string;
          try {
            content = fs.readFileSync(target, "utf-8");
          } catch (err) {
            throw new AcpRpcError(
              RPC_INTERNAL_ERROR,
              `read failed: ${(err as Error).message}`
            );
          }
          // Optional line/limit windowing, per the ACP fs schema.
          const line = typeof params.line === "number" ? params.line : undefined;
          const limit = typeof params.limit === "number" ? params.limit : undefined;
          if (line !== undefined || limit !== undefined) {
            const all = content.split("\n");
            const start = Math.max(0, (line ?? 1) - 1);
            const end = limit !== undefined ? start + limit : all.length;
            content = all.slice(start, end).join("\n");
          }
          return { content };
        }

        case "fs/write_text_file": {
          const target = resolveInsideCwd(params.path);
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, String(params.content ?? ""), "utf-8");
          } catch (err) {
            throw new AcpRpcError(
              RPC_INTERNAL_ERROR,
              `write failed: ${(err as Error).message}`
            );
          }
          return {};
        }

        default:
          // terminal/create, terminal/output, terminal/kill, ... Medusa does not
          // host terminals for the agent; method-not-found makes well-behaved
          // agents fall back to running commands in their own process.
          throw new AcpRpcError(
            RPC_METHOD_NOT_FOUND,
            `${method} is not supported by this client`
          );
      }
    };

    const conn = new AcpConnection(
      child,
      {
        onNotification: (method, params) => {
          if (method === "session/update") handleSessionUpdate(params);
        },
        onRequest: handleRequest,
      },
      logPrefix
    );
    this.live.set(sessionId, { conn, acpSessionId: null });

    // Resolves with the child's exit code once it is gone.
    const exited = new Promise<number | null>((resolve) => {
      child.on("close", (code) => {
        state.process = null;
        conn.close(
          `${this.displayName} exited (code ${code})` +
            (stderrText.trim() ? `: ${stderrText.trim().slice(-500)}` : "")
        );
        resolve(code);
      });
      child.on("error", (err) => {
        state.process = null;
        conn.close(`${this.displayName} failed to start: ${err.message}`);
        resolve(null);
      });
    });

    let resultEmitted = false;
    const emitResult = (success: boolean, error?: string) => {
      if (resultEmitted) return;
      resultEmitted = true;
      emit({ kind: "result", success, sessionId, ...(error ? { error } : {}) });
    };

    try {
      // 1. initialize
      const init = await this.race<AcpInitializeResult>(
        conn.request<AcpInitializeResult>("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: false,
          },
          clientInfo: { name: "medusa", title: "Medusa", version: "1.0.0" },
        }),
        exited
      );

      const canLoad = init?.agentCapabilities?.loadSession === true;
      const canImage = init?.agentCapabilities?.promptCapabilities?.image === true;

      // 2. session/new or session/load
      const previous = forceNew ? undefined : this.acpSessions.get(sessionId);
      if (previous && canLoad) {
        replaying = true;
        try {
          await this.race(
            conn.request("session/load", {
              sessionId: previous,
              cwd,
              mcpServers: [],
            }),
            exited
          );
          acpSessionId = previous;
        } catch (err) {
          console.warn(
            `${logPrefix} session/load failed for ${previous}, starting fresh:`,
            err
          );
          acpSessionId = null;
        } finally {
          replaying = false;
        }
      }

      if (!acpSessionId) {
        const created = await this.race<{ sessionId?: string }>(
          conn.request<{ sessionId?: string }>("session/new", {
            cwd,
            mcpServers: [],
          }),
          exited
        );
        acpSessionId = created?.sessionId ?? null;
        if (!acpSessionId) {
          throw new Error("session/new returned no sessionId");
        }
      }

      this.acpSessions.set(sessionId, acpSessionId);
      const liveEntry = this.live.get(sessionId);
      if (liveEntry) liveEntry.acpSessionId = acpSessionId;

      // 3. Synthetic init event so the client's session-header logic works.
      // ACP splits this information across initialize + session/new and never
      // echoes cwd or the model back, so we assemble it ourselves.
      emit({
        kind: "init",
        sessionId: acpSessionId,
        model: model ?? init?.agentInfo?.name ?? this.id,
        tools: [],
        cwd,
      });

      // 4. session/prompt
      const promptBlocks = this.buildPromptBlocks({
        text,
        images,
        files,
        systemPrompt,
        canImage,
        logPrefix,
      });

      const promptResult = await this.race<{ stopReason?: string }>(
        conn.request<{ stopReason?: string }>("session/prompt", {
          sessionId: acpSessionId,
          prompt: promptBlocks,
        }),
        exited
      );

      const stopReason = promptResult?.stopReason ?? "end_turn";
      const success = stopReason === "end_turn" || stopReason === "max_turn_requests";
      emitResult(
        success,
        success ? undefined : `Agent stopped with reason: ${stopReason}`
      );
      state.isFirstMessage = false;
    } catch (err) {
      // Covers a dead child mid-prompt, a protocol error, or a timeout.
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: "error", message });
      emitResult(false, message);
    } finally {
      this.live.delete(sessionId);
      // One process per turn: shut the agent down now that the turn is over.
      if (state.process) {
        abortChildProcess(state, sessionId);
      }
    }

    return exited;
  }

  /**
   * Rejects as soon as the child exits, so an agent that dies mid-request
   * never leaves the turn hanging forever.
   */
  private race<T>(p: Promise<T>, exited: Promise<number | null>): Promise<T> {
    return Promise.race([
      p,
      exited.then((code) => {
        throw new Error(
          `${this.displayName} exited before responding (code ${code})`
        );
      }),
    ]);
  }

  /** Build the ACP ContentBlock[] for session/prompt. */
  private buildPromptBlocks(args: {
    text: string;
    images?: string[];
    files?: string[];
    systemPrompt?: string;
    canImage: boolean;
    logPrefix: string;
  }): Array<Record<string, unknown>> {
    const { text, images, files, systemPrompt, canImage, logPrefix } = args;
    const blocks: Array<Record<string, unknown>> = [];
    let prompt = text;

    // ACP has no system-prompt parameter, so it is inlined the way the kimi
    // engine does it.
    if (systemPrompt) {
      prompt = `--- SYSTEM INSTRUCTIONS ---\n${systemPrompt}\n--- END SYSTEM INSTRUCTIONS ---\n\n${prompt}`;
    }

    const textRefs: string[] = [];
    for (const p of files ?? []) {
      textRefs.push(`Please read this file: ${p}`);
    }

    for (const p of images ?? []) {
      if (canImage) {
        try {
          const data = fs.readFileSync(p).toString("base64");
          blocks.push({ type: "image", data, mimeType: mimeTypeForPath(p) });
          continue;
        } catch (err) {
          console.warn(`${logPrefix} Could not inline image ${p}:`, err);
        }
      }
      textRefs.push(`Please read this image: ${p}`);
    }

    if (textRefs.length > 0) {
      prompt = `${textRefs.join("\n")}\n\n${prompt}`;
    }

    blocks.unshift({ type: "text", text: prompt });
    return blocks;
  }
}

function mimeTypeForPath(p: string): string {
  switch (path.extname(p).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}
