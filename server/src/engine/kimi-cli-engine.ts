import fs from "fs";
import os from "os";
import path from "path";
import { spawn, execSync } from "child_process";
import { buildMcpConfigJson } from "../mcp/config.js";
import {
  abortChildProcess,
  type Engine,
  type EngineSessionState,
  type EngineSpawnOptions,
  type ModelInfo,
} from "./types.js";

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

// ---------------------------------------------------------------------------
// Aborting a Kimi turn (investigated against kimi-cli 1.47.0, 2026-09-17)
//
// What is actually true, after reading the installed package:
//
// - There is no "Kimi Code" application. The `kimi` client renames its own
//   process title to "Kimi Code" (kimi_cli/utils/proctitle.py, called from
//   kimi_cli/cli/__init__.py), which is what makes it look like a separate app
//   in `ps` and Activity Monitor.
// - The agent turn itself runs IN-PROCESS in the `kimi` client, so killing the
//   client does end the turn. `kimi-code-bg-worker` is not the agent: it is a
//   one-shot runner for backgrounded Shell tool calls
//   (`python -m kimi_cli.cli __background-task-worker --task-dir <dir>`), one
//   process per backgrounded command.
// - Those workers are what survives a SIGTERM'd client. The client only reaps
//   them in `KimiApp.shutdown_background_tasks()`, which runs on its own clean
//   exit path; it installs NO SIGTERM and NO SIGINT handler, so a signal kills
//   it before that cleanup runs. (`keep_alive_on_exit = false` in
//   ~/.kimi/config.toml is already the default and does not help here, because
//   the cleanup never executes.)
// - The worker calls set_process_title("kimi-code-bg-worker"), which OVERWRITES
//   argv. In `ps` the command line is the bare string "kimi-code-bg-worker"
//   with no --task-dir, no session key and no task id, so a session cannot be
//   matched from a process listing. A blanket `pkill -f kimi-code-bg-worker`
//   would kill other chats' workers too.
// - There is no CLI flag and no config key that disables the background worker,
//   and no `kimi cancel` / `kimi stop` subcommand. The only supported external
//   turn cancel is ACP's `session/cancel`, which `kimi acp` exposes but
//   `--print` mode (what this engine uses) does not.
//
// So the reliable scoped handle is the CLI's own on-disk task state:
//   ~/.kimi/sessions/<workdir hash>/<session key>/tasks/<task id>/
//     runtime.json  {status, worker_pid, child_pid, child_pgid, ...}
//     control.json  {kill_requested_at, kill_reason, force}
// The worker polls control.json every 500ms and kills its own process group,
// so writing that file is the graceful path; the pids are the fallback.
// ---------------------------------------------------------------------------

const KIMI_TERMINAL_TASK_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "killed",
  "timeout",
  "timed_out",
]);

interface KimiTaskRuntime {
  status?: string;
  worker_pid?: number | null;
  child_pid?: number | null;
  child_pgid?: number | null;
}

function kimiSessionsRoot(): string {
  const home = process.env.KIMI_HOME || path.join(os.homedir(), ".kimi");
  return path.join(home, "sessions");
}

/** Task directories belonging to one Kimi session key, across all work dirs. */
function findKimiTaskDirs(sessionKey: string): string[] {
  const out: string[] = [];
  const root = kimiSessionsRoot();
  let workdirHashes: string[];
  try {
    workdirHashes = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const hash of workdirHashes) {
    let sessionDirs: string[];
    try {
      sessionDirs = fs.readdirSync(path.join(root, hash));
    } catch {
      continue;
    }
    for (const dir of sessionDirs) {
      // Kimi may suffix the directory it derives from the --session value.
      if (dir !== sessionKey && !dir.startsWith(`${sessionKey}-`)) continue;
      const tasks = path.join(root, hash, dir, "tasks");
      let taskIds: string[];
      try {
        taskIds = fs.readdirSync(tasks);
      } catch {
        continue;
      }
      for (const taskId of taskIds) out.push(path.join(tasks, taskId));
    }
  }
  return out;
}

function killPid(pid: number | null | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 1) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours.
  }
}

/**
 * Terminate the background workers belonging to one Kimi session.
 *
 * Scoped by the session key via the CLI's own task state on disk, because the
 * worker's argv is overwritten and carries no session marker. Best effort
 * throughout: an abort must never throw.
 */
export function reapKimiBackgroundWorkers(sessionKey: string): number {
  let reaped = 0;
  for (const taskDir of findKimiTaskDirs(sessionKey)) {
    let runtime: KimiTaskRuntime;
    try {
      runtime = JSON.parse(
        fs.readFileSync(path.join(taskDir, "runtime.json"), "utf-8")
      ) as KimiTaskRuntime;
    } catch {
      continue;
    }
    if (runtime.status && KIMI_TERMINAL_TASK_STATUSES.has(runtime.status)) continue;

    // 1. Ask nicely: a live worker polls control.json and tears down its own
    //    process group, which also reaps the shell it started.
    try {
      fs.writeFileSync(
        path.join(taskDir, "control.json"),
        JSON.stringify({
          kill_requested_at: Date.now() / 1000,
          kill_reason: "medusa abort",
          force: true,
        }),
        "utf-8"
      );
    } catch {
      // Fall through to the signals below.
    }

    // 2. Signal directly, since the client that would normally supervise the
    //    worker has just been killed.
    if (runtime.child_pgid) {
      try {
        process.kill(-runtime.child_pgid, "SIGTERM");
      } catch {
        // No such group.
      }
    }
    killPid(runtime.child_pid, "SIGTERM");
    killPid(runtime.worker_pid, "SIGTERM");
    reaped++;

    const pids = [runtime.child_pid, runtime.worker_pid];
    const pgid = runtime.child_pgid;
    const escalate = setTimeout(() => {
      if (pgid) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Gone.
        }
      }
      for (const pid of pids) killPid(pid, "SIGKILL");
    }, 3_000);
    escalate.unref();
  }
  if (reaped > 0) {
    console.log(
      `[kimi] Reaped ${reaped} background task worker(s) for session key ${sessionKey}`
    );
  }
  return reaped;
}

export class KimiCliEngine implements Engine {
  readonly id = "kimi";
  readonly displayName = "Kimi CLI";

  async listModels(): Promise<ModelInfo[]> {
    // The kimi CLI takes no --model flag; the model is picked in its own config.
    return [];
  }

  /**
   * SIGTERM the client, then clean up after it.
   *
   * The client has no signal handler, so it dies before it can run its own
   * `shutdown_background_tasks()`; any `kimi-code-bg-worker` it started for a
   * backgrounded Shell tool call would otherwise keep running. See the long
   * comment at the top of this file for what was verified about kimi 1.47.
   */
  abort(state: EngineSessionState, sessionId: string): void {
    const sessionKey = state.kimiSessionKey;
    abortChildProcess(state, sessionId);
    try {
      reapKimiBackgroundWorkers(sessionKey);
    } catch (err) {
      console.warn(`[kimi] Background worker cleanup failed for ${sessionId}:`, err);
    }
  }

  spawn(opts: EngineSpawnOptions): Promise<number | null> {
    const { sessionId, state: entry, text, images, files, onEvent } = opts;
    const yoloMode = opts.yoloMode ?? false;
    const systemPrompt = opts.systemPrompt;

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
      entry.kimiSessionKey,
      "--work-dir",
      entry.workingDir,
    ];

    if (yoloMode) {
      args.push("--yolo");
    }

    // Verified against `kimi --help` (1.47.0): `--mcp-config TEXT` takes an
    // "MCP config JSON to load" and is repeatable, in the same
    // {"mcpServers": {...}} shape Claude Code uses. There is also a
    // `--mcp-config-file FILE` form; the string form is used so no temp file
    // has to be created or cleaned up.
    if (opts.mcpConfig) {
      args.push("--mcp-config", buildMcpConfigJson(opts.mcpConfig));
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

        // Detect token limit errors in full stdout (message may span lines)
        const tokenLimitHit =
          rawStdout.includes("exceeded model token limit") ||
          (rawStdout.includes("token limit") && rawStdout.includes("exceeded"));

        // Parse each JSON line from stdout
        const lines = rawStdout.split("\n").map((l) => l.trim()).filter(Boolean);
        let emittedText = false;
        let errorText = "";

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.role === "assistant") {
              // Kimi 1.47+ sends the final answer as a plain string; earlier
              // versions and tool-calling turns use a block array.
              if (typeof obj.content === "string" && obj.content) {
                onEvent({ kind: "delta", text: obj.content });
                emittedText = true;
              } else if (Array.isArray(obj.content)) {
                for (const block of obj.content) {
                  if (block.type === "text" && block.text) {
                    onEvent({ kind: "delta", text: block.text });
                    emittedText = true;
                  }
                  // thinking blocks are skipped to avoid cluttering output
                }
              }
              if (Array.isArray(obj.tool_calls)) {
                for (const call of obj.tool_calls) {
                  let input: Record<string, unknown> = {};
                  try {
                    input = JSON.parse(call.function?.arguments ?? "{}");
                  } catch {
                    input = { arguments: call.function?.arguments };
                  }
                  onEvent({
                    kind: "tool_use_start",
                    toolId: call.id,
                    toolName: call.function?.name ?? "tool",
                    input,
                  });
                }
              }
            } else if (obj.role === "tool" && obj.tool_call_id) {
              const content = Array.isArray(obj.content)
                ? obj.content
                    .map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text ?? "" : ""))
                    .join("\n")
                : String(obj.content ?? "");
              onEvent({ kind: "tool_result", toolUseId: obj.tool_call_id, content });
            }
          } catch {
            // Not valid JSON, could be an error message from the CLI
            errorText += line + "\n";
          }
        }

        // If token limit exceeded, retry with a fresh Kimi session.
        // Rotate the session key so Kimi starts with a clean context window.
        if (code !== 0 && tokenLimitHit) {
          const oldKey = entry.kimiSessionKey;
          entry.kimiSessionKey = `${sessionId}-fresh-${Date.now()}`;
          console.log(
            `[kimi] Token limit hit for session ${sessionId} (key=${oldKey}). ` +
            `Retrying with fresh key ${entry.kimiSessionKey}`
          );
          resolve(this.spawn(opts));
          return;
        }

        // If the process failed and we have non-JSON output, emit it as an error
        if (code !== 0 && errorText.trim() && !emittedText) {
          onEvent({ kind: "error", message: errorText.trim() });
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
}
