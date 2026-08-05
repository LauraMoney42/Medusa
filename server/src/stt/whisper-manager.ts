/**
 * Local Whisper (speech-to-text) server supervisor.
 *
 * Mirrors the Headroom proxy supervisor: when Medusa boots it starts (or adopts)
 * the local faster-whisper server that backs the mic button, health-checks it,
 * auto-restarts on crash, and kills it on graceful shutdown.
 *
 * Only runs when STT is enabled AND STT_API_BASE_URL points at a loopback host
 * (i.e. we're using the local server, not a cloud endpoint like OpenAI/Groq).
 * Fail-safe: any problem just means the mic button stays hidden — nothing breaks.
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import config from "../config.js";

let child: ChildProcess | null = null;
let ready = false;
// owned === true means WE spawned it (so we kill it on shutdown).
// owned === false means we adopted a server the user already had running.
let owned = false;
let starting = false;
let isShuttingDown = false;
let restartAttempts = 0;
const MAX_RESTARTS = 5;

/** Parse the STT base URL; return the loopback port, or null if it's remote. */
function localPort(): number | null {
  try {
    const u = new URL(config.sttApiBaseUrl);
    if (!["localhost", "127.0.0.1", "::1"].includes(u.hostname)) return null;
    return u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/** Single liveness probe against the STT server's /v1/models endpoint. */
function healthCheck(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/v1/models", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Poll until ready — the model can take a while to load on first start. */
async function waitForReady(port: number, attempts = 90): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await healthCheck(port)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Start (or adopt) the local Whisper STT server. Safe to call once at startup.
 * Never throws — logs and leaves the mic disabled on any failure.
 */
export async function startWhisperServer(): Promise<void> {
  if (!config.sttEnabled || !config.sttAutostart) return;
  const port = localPort();
  if (port === null) return; // STT points at a remote endpoint — nothing local to run
  if (ready || starting) return;
  starting = true;
  isShuttingDown = false;

  // Adopt an already-running server (e.g. the user started run.sh manually).
  if (await healthCheck(port)) {
    ready = true;
    owned = false;
    starting = false;
    console.log(`[whisper] ✅ Reusing existing STT server on 127.0.0.1:${port}.`);
    return;
  }

  const script = config.sttRunScript;
  try {
    fs.accessSync(script, fs.constants.X_OK);
  } catch {
    starting = false;
    console.log(
      `[whisper] Run script not found/executable at ${script} — mic STT disabled until it's set up.`
    );
    return;
  }

  console.log(`[whisper] Starting local STT server: ${script}`);
  // run.sh `exec`s uvicorn, so this child's SIGTERM stops the server directly.
  child = spawn("/bin/bash", [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  owned = true;

  child.stdout?.on("data", () => {
    /* drain uvicorn banner */
  });
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString("utf-8").trim();
    if (s) console.error(`[whisper] ${s}`);
  });
  child.on("exit", (code, signal) => {
    ready = false;
    child = null;
    if (isShuttingDown) return;
    console.warn(`[whisper] STT server exited (code=${code}, signal=${signal ?? "none"}).`);
    if (restartAttempts < MAX_RESTARTS) {
      restartAttempts++;
      const delay = Math.min(30_000, 1000 * 2 ** restartAttempts);
      console.log(`[whisper] Restarting in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTARTS})`);
      setTimeout(() => {
        starting = false;
        void startWhisperServer();
      }, delay);
    } else {
      console.error("[whisper] STT server failed too many times — mic disabled for this run.");
    }
  });

  const ok = await waitForReady(port);
  starting = false;
  if (ok) {
    ready = true;
    restartAttempts = 0;
    console.log(`[whisper] ✅ STT server ready on 127.0.0.1:${port}.`);
  } else {
    console.error("[whisper] STT server did not become ready in time — mic may be unavailable.");
  }
}

/** Stop the STT server if we own it. Called during graceful shutdown. */
export function stopWhisperServer(): void {
  isShuttingDown = true;
  ready = false;
  if (child && owned) {
    console.log("[whisper] Stopping local STT server...");
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    child = null;
  }
}

export function isWhisperReady(): boolean {
  return ready;
}
