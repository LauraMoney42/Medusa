import { randomUUID } from "crypto";

// Minimal structural types for the slice of the Socket.IO API this module
// needs. Socket.IO's own `Namespace`/`Socket` exports don't resolve cleanly
// under this project's TS config (a pre-existing quirk elsewhere in the
// codebase too), so this decouples from that rather than fighting it.
interface RunnerSocket {
  id: string;
  on(event: string, handler: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
  disconnect(close?: boolean): void;
}
interface RunnerNamespace {
  on(event: "connection", handler: (socket: RunnerSocket) => void): void;
}

/**
 * Multi-machine runner protocol — "one brain, many hands".
 *
 * A lightweight runner daemon (see runner-client.ts) runs on each machine you
 * want Medusa to reach (the Mac mini, a laptop, ...) and dials OUT to this
 * brain's `/runner` Socket.IO namespace — the brain never dials in, so there's
 * no port-forwarding or inbound firewall rule needed on any runner machine.
 *
 * This is the exec-primitive layer only: it lets the brain run a shell command
 * on a named, connected runner and get stdout/stderr/exitCode back. It does
 * NOT yet dispatch bot sessions to a chosen runner — ProcessManager still
 * always spawns `claude`/`kimi` locally. Routing an actual bot session to a
 * remote runner is a larger follow-up once this primitive is proven out.
 *
 * SECURITY: `exec` runs an arbitrary shell command on the target machine.
 * The `/runner` namespace requires the same AUTH_TOKEN as the rest of the app
 * (see index.ts) — treat that token with the same care as full remote-shell
 * access to every machine running a runner, because that is exactly what it is.
 */

interface ConnectedRunner {
  socket: RunnerSocket;
  name: string;
  connectedAt: number;
}

export interface RunnerInfo {
  name: string;
  connectedAt: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

interface ExecResultEvent {
  requestId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const EXEC_TIMEOUT_MS = 30_000;

export class RunnerManager {
  private runners = new Map<string, ConnectedRunner>(); // keyed by runner name
  private pending = new Map<string, { resolve: (r: ExecResult) => void; timer: NodeJS.Timeout }>();

  /** Wire this manager up to a Socket.IO namespace (e.g. `io.of("/runner")`). */
  attach(namespace: RunnerNamespace): void {
    namespace.on("connection", (socket: RunnerSocket) => {
      let registeredName: string | null = null;

      socket.on("runner:register", (data: { name?: string }) => {
        const name = (data?.name ?? "").trim();
        if (!name) {
          console.warn("[runner] Rejected registration with empty name");
          socket.disconnect(true);
          return;
        }

        // A reconnect from the same logical runner replaces the stale socket.
        const existing = this.runners.get(name);
        if (existing && existing.socket.id !== socket.id) {
          existing.socket.disconnect(true);
        }

        registeredName = name;
        this.runners.set(name, { socket, name, connectedAt: Date.now() });
        console.log(`[runner] Registered: "${name}" (${socket.id})`);
      });

      socket.on("runner:exec:result", (data: ExecResultEvent) => {
        const p = this.pending.get(data.requestId);
        if (!p) return; // late/duplicate result after our timeout already fired
        clearTimeout(p.timer);
        this.pending.delete(data.requestId);
        p.resolve({
          stdout: data.stdout ?? "",
          stderr: data.stderr ?? "",
          exitCode: data.exitCode ?? null,
          timedOut: false,
        });
      });

      socket.on("disconnect", () => {
        if (registeredName && this.runners.get(registeredName)?.socket.id === socket.id) {
          this.runners.delete(registeredName);
          console.log(`[runner] Disconnected: "${registeredName}"`);
        }
      });
    });
  }

  /** Currently connected runners. */
  list(): RunnerInfo[] {
    return [...this.runners.values()]
      .map((r) => ({ name: r.name, connectedAt: r.connectedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  isConnected(name: string): boolean {
    return this.runners.has(name);
  }

  /**
   * Run a shell command on the named runner. Resolves with stdout/stderr/exitCode,
   * or `{ timedOut: true }` if no result arrives within EXEC_TIMEOUT_MS (the runner
   * may be offline, hung, or the command itself may still be running remotely —
   * this is a client-side timeout on the RESPONSE, not a kill signal to the runner).
   * Throws only if the named runner isn't currently connected.
   */
  async exec(name: string, command: string, cwd?: string): Promise<ExecResult> {
    const runner = this.runners.get(name);
    if (!runner) {
      throw new Error(`Runner "${name}" is not connected`);
    }

    const requestId = randomUUID();
    return new Promise<ExecResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ stdout: "", stderr: "", exitCode: null, timedOut: true });
      }, EXEC_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, timer });
      runner.socket.emit("runner:exec", { requestId, command, cwd });
    });
  }
}
