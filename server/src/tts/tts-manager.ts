/**
 * Local text-to-speech server supervisor.
 *
 * Mirrors the Whisper STT supervisor: when Medusa boots it starts (or adopts)
 * the local Kokoro TTS server that voices Medusa's replies, health-checks it,
 * auto-restarts on crash, and kills it on graceful shutdown.
 *
 * Only runs when TTS is enabled AND TTS_API_BASE_URL points at a loopback host.
 * Fail-safe: any problem just means voice-out is unavailable — nothing breaks.
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import config from "../config.js";

let child: ChildProcess | null = null;
let ready = false;
let owned = false;
let starting = false;
let isShuttingDown = false;
let restartAttempts = 0;
const MAX_RESTARTS = 5;

/** Parse the TTS base URL; return the loopback port, or null if it's remote. */
function localPort(): number | null {
  try {
    const u = new URL(config.ttsApiBaseUrl);
    if (!["localhost", "127.0.0.1", "::1"].includes(u.hostname)) return null;
    return u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

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
 * Start (or adopt) the local Kokoro TTS server. Safe to call once at startup.
 * Never throws — logs and leaves voice-out disabled on any failure.
 */
export async function startTtsServer(): Promise<void> {
  if (!config.ttsEnabled || !config.ttsAutostart) return;
  const port = localPort();
  if (port === null) return; // TTS points at a remote endpoint — nothing local to run
  if (ready || starting) return;
  starting = true;
  isShuttingDown = false;

  if (await healthCheck(port)) {
    ready = true;
    owned = false;
    starting = false;
    console.log(`[tts] ✅ Reusing existing TTS server on 127.0.0.1:${port}.`);
    return;
  }

  const script = config.ttsRunScript;
  try {
    fs.accessSync(script, fs.constants.X_OK);
  } catch {
    starting = false;
    console.log(
      `[tts] Run script not found/executable at ${script} — voice-out disabled until it's set up.`
    );
    return;
  }

  console.log(`[tts] Starting local TTS server: ${script}`);
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
    if (s) console.error(`[tts] ${s}`);
  });
  child.on("exit", (code, signal) => {
    ready = false;
    child = null;
    if (isShuttingDown) return;
    console.warn(`[tts] TTS server exited (code=${code}, signal=${signal ?? "none"}).`);
    if (restartAttempts < MAX_RESTARTS) {
      restartAttempts++;
      const delay = Math.min(30_000, 1000 * 2 ** restartAttempts);
      console.log(`[tts] Restarting in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTARTS})`);
      setTimeout(() => {
        starting = false;
        void startTtsServer();
      }, delay);
    } else {
      console.error("[tts] TTS server failed too many times — voice-out disabled for this run.");
    }
  });

  const ok = await waitForReady(port);
  starting = false;
  if (ok) {
    ready = true;
    restartAttempts = 0;
    console.log(`[tts] ✅ TTS server ready on 127.0.0.1:${port}.`);
  } else {
    console.error("[tts] TTS server did not become ready in time — voice-out may be unavailable.");
  }
}

/** Stop the TTS server if we own it. Called during graceful shutdown. */
export function stopTtsServer(): void {
  isShuttingDown = true;
  ready = false;
  if (child && owned) {
    console.log("[tts] Stopping local TTS server...");
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    child = null;
  }
}

export function isTtsReady(): boolean {
  return ready;
}
