/**
 * The `claude` CLI kept warm across turns (S16).
 *
 * `claude -p "<prompt>"` starts a Node process, reads settings, discovers
 * CLAUDE.md and MCP servers and re-sends the whole conversation on every turn.
 * In a spoken conversation that start-up is the single largest chunk of the
 * time between "you stopped talking" and "she started talking".
 *
 * The CLI's own answer to this is `--input-format stream-json` paired with
 * `--output-format stream-json`: one long-lived process reads newline
 * delimited user messages on stdin and writes newline delimited events on
 * stdout, one `{"type":"result"}` line per turn. Verified against the
 * installed CLI (`claude --help`: "stream-json (realtime streaming input)")
 * and by a live probe on this machine, which fed three successive user
 * messages into one process and got three result lines back.
 *
 * Everything else about the engine is deliberately the same as
 * `claude-cli-engine.ts`: same argv construction, same provider/Headroom env,
 * same StreamParser. The differences are all lifecycle:
 *
 *  - one child per Medusa session instead of one per turn;
 *  - `state.process` is attached only for the duration of a turn, so
 *    ProcessManager sees the session as idle between turns;
 *  - flags that are fixed at process start (model, system prompt, yolo, MCP
 *    config, provider env) are hashed into a signature; when the signature
 *    changes the warm process is retired and a new one takes over, which is
 *    what makes a mid-chat model switch behave.
 *
 * Anything that goes wrong (the child dies, stdin is closed, the CLI rejects
 * the framing) retires the warm process and the turn is retried once on the
 * cold engine, so warm mode can never be worse than not having it.
 */

import fs from "fs";
import { spawn, execSync } from "child_process";
import type { ChildProcess } from "child_process";
import { StreamParser } from "../claude/stream-parser.js";
import type { ParsedEvent } from "../claude/types.js";
import { getActiveConfigDir, getActiveProvider } from "../settings/store.js";
import { getHeadroomEnv } from "../headroom/proxy-manager.js";
import { buildMcpConfigJson } from "../mcp/config.js";
import {
  getAnthropicCompatibleEnv,
  isAnthropicCompatibleProvider,
} from "../settings/providers.js";
import { ClaudeCliEngine } from "./claude-cli-engine.js";
import {
  abortChildProcess,
  type Engine,
  type EngineSessionState,
  type EngineSpawnOptions,
  type ModelInfo,
} from "./types.js";

export const CLAUDE_WARM_ENGINE_ID = "claude-warm";

function findClaudeBinary(): string {
  const candidates = [
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
      const real = fs.realpathSync(p);
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch {
      // continue
    }
  }
  return "claude";
}

/** One `{"type":"user"}` line, the shape the CLI's stream-json input expects. */
export function userMessageFrame(text: string): string {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

/**
 * The argv for a warm process. Exported so a test can assert the framing and
 * the flags without spawning anything.
 *
 * `-p` with `--input-format stream-json` is what puts the CLI in the
 * long-lived bidirectional mode; the prompt itself arrives on stdin, so no
 * prompt argument is passed.
 */
export function buildWarmArgs(opts: {
  sessionId: string;
  resume: boolean;
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  mcpConfigJson?: string;
}): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    // Without this the CLI emits one message per completed block and no
    // stream_event lines, which would undo the point of warm mode.
    "--include-partial-messages",
  ];
  if (opts.resume) args.push("--resume", opts.sessionId);
  else args.push("--session-id", opts.sessionId);
  if (opts.yoloMode) args.push("--dangerously-skip-permissions");
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  if (opts.model) args.push("--model", opts.model);
  if (opts.mcpConfigJson) args.push("--mcp-config", opts.mcpConfigJson);
  return args;
}

/** Flags that cannot change without restarting the process. */
export function warmSignature(opts: {
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  mcpConfigJson?: string;
  providerId?: string;
  cwd: string;
}): string {
  return JSON.stringify([
    opts.cwd,
    opts.model ?? "",
    opts.yoloMode ?? false,
    opts.providerId ?? "",
    opts.mcpConfigJson ?? "",
    // The orchestrator prompt is long; its length plus a cheap hash is enough
    // to notice a change without holding a second copy of it per session.
    opts.systemPrompt ? `${opts.systemPrompt.length}:${cheapHash(opts.systemPrompt)}` : "",
  ]);
}

function cheapHash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

interface WarmTurn {
  parser: StreamParser;
  onEvent: (event: ParsedEvent) => void;
  finish: (code: number | null) => void;
  done: boolean;
  /** Set by abort(): the user cancelled, so nothing should be retried. */
  aborted: boolean;
}

interface WarmProcess {
  child: ChildProcess;
  signature: string;
  alive: boolean;
  /** Incomplete stdout line carried between chunks. */
  buffer: string;
  turn: WarmTurn | null;
  stderr: string;
}

/** Spawn function seam, so tests can drive a fake child. */
export type SpawnFn = typeof spawn;

export class WarmClaudeEngine implements Engine {
  readonly id = CLAUDE_WARM_ENGINE_ID;
  readonly displayName = "Claude Code (warm)";

  private readonly processes = new Map<string, WarmProcess>();
  private readonly cold = new ClaudeCliEngine();
  private binary: string | null = null;

  constructor(private readonly spawnFn: SpawnFn = spawn) {}

  async listModels(): Promise<ModelInfo[]> {
    return this.cold.listModels();
  }

  /** True when this session currently holds a live warm process. */
  isWarm(sessionId: string): boolean {
    return this.processes.get(sessionId)?.alive === true;
  }

  /**
   * Abort one turn. The CLI has no "cancel this turn" control message on the
   * stream-json input channel, so the honest thing is to retire the process:
   * the conversation is on disk under the session id, and the next turn
   * resumes it. The turn's promise is settled here so the caller is not left
   * waiting on a process that is going away.
   */
  abort(state: EngineSessionState, sessionId: string): void {
    const warm = this.processes.get(sessionId);
    if (!warm) {
      abortChildProcess(state, sessionId);
      return;
    }
    const turn = warm.turn;
    if (turn) turn.aborted = true;
    this.retire(sessionId, "aborted");
    state.process = null;
    // Zero, not null: the turn ended because it was told to. A non-zero code
    // would send the socket layer's tier-escalation down a retry and answer a
    // question the user has just talked over.
    turn?.finish(0);
  }

  /** Retire a session's warm process (settings changed, error, shutdown). */
  retire(sessionId: string, reason: string): void {
    const warm = this.processes.get(sessionId);
    if (!warm) return;
    this.processes.delete(sessionId);
    warm.alive = false;
    console.log(`[claude-warm] Retiring warm process for ${sessionId}: ${reason}`);
    try {
      warm.child.stdin?.end();
    } catch {
      // Already closed.
    }
    try {
      warm.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  /** Retire everything (server shutdown). */
  retireAll(): void {
    for (const id of [...this.processes.keys()]) this.retire(id, "shutdown");
  }

  async spawn(opts: EngineSpawnOptions): Promise<number | null> {
    const { sessionId, state, text, images, files, onEvent } = opts;
    const mcpConfigJson = opts.mcpConfig ? buildMcpConfigJson(opts.mcpConfig) : undefined;
    const signature = warmSignature({
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      yoloMode: opts.yoloMode,
      mcpConfigJson,
      providerId: opts.providerId,
      cwd: state.workingDir,
    });

    let warm = this.processes.get(sessionId);
    if (warm && (!warm.alive || warm.signature !== signature || opts.forceNew)) {
      this.retire(sessionId, warm.alive ? "settings changed" : "process gone");
      warm = undefined;
    }

    if (!warm) {
      try {
        warm = this.start(sessionId, state, opts, signature, mcpConfigJson);
      } catch (err) {
        console.warn(`[claude-warm] Could not start warm process, using cold path:`, err);
        return this.cold.spawn(opts);
      }
    }

    // Prompt assembly is identical to the cold engine's, minus the system
    // prompt (that one is an argv flag on the long-lived process).
    let prompt = text;
    if (files && files.length > 0) {
      prompt = `${files.map((p) => `Please read this file: ${p}`).join("\n")}\n\n${prompt}`;
    }
    if (images && images.length > 0) {
      prompt = `${images.map((p) => `Please read this image: ${p}`).join("\n")}\n\n${prompt}`;
    }

    const parser = new StreamParser();
    parser.onEvent = onEvent;

    let turnRef: WarmTurn | null = null;
    const result = await new Promise<number | null>((resolve) => {
      const turn: WarmTurn = {
        parser,
        onEvent,
        done: false,
        aborted: false,
        finish: (code) => {
          if (turn.done) return;
          turn.done = true;
          if (warm && warm.turn === turn) warm.turn = null;
          state.process = null;
          resolve(code);
        },
      };
      turnRef = turn;
      warm!.turn = turn;
      state.process = warm!.child;
      try {
        warm!.child.stdin!.write(userMessageFrame(prompt));
      } catch (err) {
        console.warn(`[claude-warm] stdin write failed:`, err);
        this.retire(sessionId, "stdin write failed");
        turn.finish(null);
      }
    });

    // A warm turn that never produced a result (the child died mid-turn) falls
    // back to the cold path exactly once, so the user still gets an answer.
    // An aborted turn is excluded: barge-in cancels turns constantly and must
    // never resurrect the answer the user just talked over.
    const aborted = (turnRef as WarmTurn | null)?.aborted ?? false;
    if (result === null && !aborted && !this.processes.has(sessionId)) {
      console.log(`[claude-warm] Falling back to the cold path for ${sessionId}`);
      return this.cold.spawn({ ...opts, text });
    }

    state.isFirstMessage = false;
    return result;
  }

  // ---- internals -------------------------------------------------------

  private start(
    sessionId: string,
    state: EngineSessionState,
    opts: EngineSpawnOptions,
    signature: string,
    mcpConfigJson?: string
  ): WarmProcess {
    if (!this.binary) this.binary = findClaudeBinary();

    const args = buildWarmArgs({
      sessionId,
      resume: !state.isFirstMessage && !opts.forceNew,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      yoloMode: opts.yoloMode,
      mcpConfigJson,
    });

    const activeProvider = opts.providerId ?? getActiveProvider();
    const providerEnv = isAnthropicCompatibleProvider(activeProvider)
      ? getAnthropicCompatibleEnv(activeProvider as string, { model: opts.model || "" })
      : getHeadroomEnv();

    const child = this.spawnFn(this.binary, args, {
      cwd: state.workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        ...(getActiveConfigDir() ? { CLAUDE_CONFIG_DIR: getActiveConfigDir() } : {}),
        ...providerEnv,
      },
    });

    const warm: WarmProcess = {
      child,
      signature,
      alive: true,
      buffer: "",
      turn: null,
      stderr: "",
    };
    this.processes.set(sessionId, warm);

    child.stdout?.on("data", (chunk: Buffer) => this.consume(warm, chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      const errText = chunk.toString("utf-8").trim();
      if (!errText) return;
      warm.stderr += `${errText}\n`;
      warm.turn?.onEvent({ kind: "error", message: errText });
    });
    child.on("error", (err) => {
      warm.alive = false;
      this.processes.delete(sessionId);
      warm.turn?.onEvent({ kind: "error", message: err.message });
      warm.turn?.finish(null);
    });
    child.on("close", (code) => {
      warm.alive = false;
      if (this.processes.get(sessionId) === warm) this.processes.delete(sessionId);
      warm.turn?.parser.flush();
      warm.turn?.finish(warm.turn.done ? code : null);
    });

    return warm;
  }

  /**
   * Split the shared stdout into lines. Every line goes to the active turn's
   * parser; a `{"type":"result"}` line closes that turn without closing the
   * process. Lines that arrive with no turn open (a late result after an
   * abort) are dropped.
   */
  private consume(warm: WarmProcess, chunk: string): void {
    warm.buffer += chunk;
    for (;;) {
      const nl = warm.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = warm.buffer.slice(0, nl);
      warm.buffer = warm.buffer.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      const turn = warm.turn;
      if (!turn) continue;
      turn.parser.feed(`${trimmed}\n`);
      if (isResultLine(trimmed)) turn.finish(0);
    }
  }
}

/** True for the CLI's per-turn terminator line. */
export function isResultLine(line: string): boolean {
  if (!line.includes('"result"')) return false;
  try {
    return (JSON.parse(line) as { type?: string }).type === "result";
  } catch {
    return false;
  }
}
