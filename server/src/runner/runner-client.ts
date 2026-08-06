import { exec } from "child_process";
import { io as ioClient, Socket } from "socket.io-client";

/**
 * Runner daemon — the "hands" half of the "one brain, many hands" multi-machine
 * architecture (see runner-manager.ts for the brain-side "one brain" half).
 *
 * This script runs on any machine you want the Medusa brain to be able to run
 * shell commands on (a laptop, a Mac mini, ...). It always dials OUT to the
 * brain's `/runner` Socket.IO namespace — the brain never dials in — so there
 * is no port-forwarding or inbound firewall rule needed on the machine running
 * this script.
 *
 * Usage (after `tsc` compiles this to dist/):
 *   node dist/runner/runner-client.js --name mac-mini --brain http://localhost:3456 --token <TOKEN>
 *
 * Unlike runner-manager.ts, socket.io-client's own type exports (`io`, `Socket`)
 * resolve cleanly under this project's TS config — the `Namespace`/`Socket`
 * resolution quirk documented there is specific to the server-side `socket.io`
 * package and does not reproduce here, so no structural-interface workaround
 * is needed for this file.
 */

const EXEC_TIMEOUT_MS = 25_000; // slightly under the brain's 30s response-wait timeout,
// so this side reports a timeout result rather than the brain giving up first with no signal.

interface ExecRequest {
  requestId: string;
  command: string;
  cwd?: string;
}

interface ExecResultEvent {
  requestId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function parseArgs(argv: string[]): { name?: string; brain: string; token?: string } {
  let name: string | undefined;
  let brain = "http://localhost:3456";
  let token: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--name") {
      name = argv[++i];
    } else if (arg === "--brain") {
      brain = argv[++i] ?? brain;
    } else if (arg === "--token") {
      token = argv[++i];
    }
  }

  return { name, brain, token };
}

function printUsageAndExit(): never {
  console.error(
    "Usage: node runner-client.js --name <machine-name> --token <auth-token> [--brain <http://host:port>]"
  );
  process.exit(1);
}

const { name, brain, token } = parseArgs(process.argv.slice(2));

if (!name || !token) {
  printUsageAndExit();
}

const runnerName: string = name;
const brainUrl: string = brain;
const authToken: string = token;

console.log(`[runner] Connecting to ${brainUrl}/runner as "${runnerName}"...`);

const socket: Socket = ioClient(`${brainUrl}/runner`, {
  auth: { token: authToken },
});

socket.on("connect", () => {
  console.log(`[runner] Connected (${socket.id}). Registering as "${runnerName}"...`);
  socket.emit("runner:register", { name: runnerName });
  console.log(`[runner] ✅ Registered as "${runnerName}" — ready to receive commands.`);
});

socket.on("connect_error", (err: Error) => {
  console.error(
    `[runner] Connection error: ${err.message} — Auth failed? Check --token matches the brain's AUTH_TOKEN. Retrying...`
  );
});

socket.on("disconnect", (reason: string) => {
  console.log(`[runner] Disconnected: ${reason}`);
});

socket.io.on("reconnect_attempt", (attempt: number) => {
  console.log(`[runner] Reconnect attempt #${attempt}...`);
});

socket.io.on("reconnect", (attempt: number) => {
  console.log(`[runner] Reconnected after ${attempt} attempt(s).`);
});

socket.io.on("reconnect_failed", () => {
  console.error("[runner] Reconnect failed — giving up (socket.io-client exhausted its retries).");
});

socket.on("runner:exec", (req: ExecRequest) => {
  handleExec(req).catch((err: unknown) => {
    // Should be unreachable since handleExec catches internally, but guard
    // against a thrown error here still resulting in SOME result being sent
    // rather than leaving the brain waiting on this requestId forever.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[runner] Unexpected error handling exec ${req?.requestId}: ${message}`);
    emitResult({
      requestId: req?.requestId,
      stdout: "",
      stderr: message,
      exitCode: null,
    });
  });
});

function emitResult(result: ExecResultEvent): void {
  socket.emit("runner:exec:result", result);
}

async function handleExec(req: ExecRequest): Promise<void> {
  const { requestId, command } = req;
  const cwd = req.cwd ?? process.cwd();

  try {
    console.log(`[runner] Executing [${requestId}]: ${command} (cwd: ${cwd})`);

    const result = await new Promise<ExecResultEvent>((resolve) => {
      exec(
        command,
        { cwd, timeout: EXEC_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ requestId, stdout, stderr, exitCode: 0 });
            return;
          }

          const timedOut = error.killed === true || error.signal === "SIGTERM";
          if (timedOut) {
            resolve({
              requestId,
              stdout,
              stderr: stderr || `Command timed out after ${EXEC_TIMEOUT_MS}ms`,
              exitCode: null,
            });
            return;
          }

          // Genuine non-zero exit — error.code holds the process exit code.
          const exitCode = typeof error.code === "number" ? error.code : null;
          resolve({ requestId, stdout, stderr, exitCode });
        }
      );
    });

    console.log(`[runner] Completed [${requestId}] exitCode=${result.exitCode}`);
    emitResult(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[runner] Error executing [${requestId}]: ${message}`);
    emitResult({ requestId, stdout: "", stderr: message, exitCode: null });
  }
}
