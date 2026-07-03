/**
 * Headroom proxy supervisor.
 *
 * Headroom (https://github.com/headroomlabs-ai/headroom) is a local context-
 * compression proxy that sits between the `claude` CLI and api.anthropic.com and
 * compresses large tool outputs / logs / history before they reach the model —
 * cutting token usage (and cost) across every bot with zero changes to the bots
 * themselves.
 *
 * How it works with our Max-plan subscription auth (NO API key):
 *   - We run `headroom proxy --port <port>` as a supervised side-process.
 *   - We set ANTHROPIC_BASE_URL=http://127.0.0.1:<port> on each spawned `claude`.
 *   - Claude Code forwards its own OAuth bearer token; the proxy passes it through
 *     to Anthropic. Verified working with subscription auth (no ANTHROPIC_API_KEY).
 *
 * Fail-safe by design: if the binary is missing, the proxy won't start, or it
 * crashes, getHeadroomEnv() returns {} and bots talk to Anthropic directly —
 * they never break. The proxy is loopback-only.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import config from "../config.js";
import { getActiveProvider } from "../settings/store.js";

// ---- Module state ----
let child: ChildProcess | null = null;
let ready = false;
// owned === true means WE spawned the proxy (so we're responsible for killing it).
// owned === false means we're reusing a proxy the user started themselves.
let owned = false;
let starting = false;
let isShuttingDown = false;
let restartAttempts = 0;
const MAX_RESTARTS = 5;

/** Locate the `headroom` binary (installed via `pipx`/`pip install headroom-ai`). */
function findHeadroomBinary(): string | null {
  const candidates = [
    (() => {
      try {
        return execSync("which headroom", { encoding: "utf-8" }).trim();
      } catch {
        return null;
      }
    })(),
    `${process.env.HOME}/.local/bin/headroom`,
    "/opt/homebrew/bin/headroom",
    "/usr/local/bin/headroom",
  ];
  for (const p of candidates) {
    if (!p) continue;
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here — keep looking */
    }
  }
  return null;
}

/** Single liveness probe against the proxy's /livez endpoint. */
function healthCheck(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/livez", timeout: timeoutMs },
      (res) => {
        res.resume(); // drain
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

/** Poll until the proxy is ready (or give up). */
async function waitForReady(port: number, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await healthCheck(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Start (or adopt) the Headroom proxy. Safe to call once at server startup.
 * Never throws — logs and degrades to direct-Anthropic on any failure.
 */
export async function startHeadroomProxy(): Promise<void> {
  if (!config.headroomEnabled) {
    console.log("[headroom] Disabled (HEADROOM_ENABLED=false) — bots use direct Anthropic.");
    return;
  }
  if (ready || starting) return;
  starting = true;
  isShuttingDown = false;
  const port = config.headroomPort;

  // Reuse a proxy the user already has running (e.g. `headroom proxy` or `headroom wrap`).
  if (await healthCheck(port)) {
    ready = true;
    owned = false;
    starting = false;
    console.log(`[headroom] ✅ Reusing existing proxy on 127.0.0.1:${port} — bot traffic compressed.`);
    return;
  }

  const bin = findHeadroomBinary();
  if (!bin) {
    starting = false;
    console.log(
      "[headroom] Binary not found — install with: pipx install 'headroom-ai[all]'. Bots use direct Anthropic."
    );
    return;
  }

  console.log(`[headroom] Starting proxy: ${bin} proxy --port ${port}`);
  child = spawn(bin, ["proxy", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  owned = true;

  child.stdout?.on("data", () => {
    /* drain stdout (banner + periodic stats) — keep it out of our logs */
  });
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString("utf-8").trim();
    if (s) console.error(`[headroom] ${s}`);
  });
  child.on("exit", (code, signal) => {
    ready = false;
    child = null;
    if (isShuttingDown) return; // expected during shutdown
    console.warn(`[headroom] Proxy exited (code=${code}, signal=${signal ?? "none"}).`);
    if (restartAttempts < MAX_RESTARTS) {
      restartAttempts++;
      const delay = Math.min(30_000, 1000 * 2 ** restartAttempts);
      console.log(
        `[headroom] Restarting proxy in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTARTS})`
      );
      setTimeout(() => {
        starting = false;
        void startHeadroomProxy();
      }, delay);
    } else {
      console.error(
        "[headroom] Proxy failed too many times — bots will use direct Anthropic for the rest of this run."
      );
    }
  });

  const ok = await waitForReady(port);
  starting = false;
  if (ok) {
    ready = true;
    restartAttempts = 0;
    console.log(`[headroom] ✅ Proxy ready on 127.0.0.1:${port} — bot traffic compressed.`);
  } else {
    console.error("[headroom] Proxy did not become ready in time — bots use direct Anthropic.");
  }
}

/** Stop the proxy if we own it. Called during graceful shutdown. */
export function stopHeadroomProxy(): void {
  isShuttingDown = true;
  ready = false;
  if (child && owned) {
    console.log("[headroom] Stopping proxy...");
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    child = null;
  }
}

export function isHeadroomReady(): boolean {
  return ready;
}

/** Normalized live compression stats surfaced to the UI. */
export interface HeadroomStats {
  apiRequests: number;
  primaryModel: string;
  requestsCompressed: number;
  avgCompressionPct: number;
  totalTokensSaved: number;
  savedUsd: number;
  savingsPct: number;
}

/**
 * Fetch live stats from the running proxy's /stats endpoint.
 * Resolves null if the proxy isn't ready or the request fails.
 */
export function getHeadroomStats(): Promise<HeadroomStats | null> {
  return new Promise((resolve) => {
    if (!ready) {
      resolve(null);
      return;
    }
    const req = http.get(
      { host: "127.0.0.1", port: config.headroomPort, path: "/stats", timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const d = JSON.parse(body) as Record<string, any>;
            const s = (d.summary ?? d) as Record<string, any>;
            const c = (s.compression ?? {}) as Record<string, any>;
            const co = (s.cost ?? {}) as Record<string, any>;
            resolve({
              apiRequests: s.api_requests ?? 0,
              primaryModel: s.primary_model ?? "unknown",
              requestsCompressed: c.requests_compressed ?? 0,
              avgCompressionPct: c.avg_compression_pct ?? 0,
              // Prefer the CLI-filtering-inclusive token savings; fall back to raw removed.
              totalTokensSaved: c.total_tokens_saved_with_cli_filtering ?? c.total_tokens_removed ?? 0,
              savedUsd: co.total_saved_usd ?? 0,
              savingsPct: co.savings_pct ?? 0,
            });
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Env overrides that route a spawned `claude` process through the Headroom proxy.
 * Returns {} when the proxy isn't ready or the active provider isn't Claude, so
 * bots fall back to direct Anthropic and never break.
 *
 * Spread this AFTER ...process.env when building the child env.
 */
export function getHeadroomEnv(): Record<string, string> {
  if (!ready) return {};
  // Only route Anthropic/Claude traffic. Leave Kimi (or any non-Claude provider) alone.
  if (getActiveProvider() === "kimi") return {};
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.headroomPort}`,
    // Keep Claude Code's on-demand tool loading (deferral) active through a custom
    // base URL; otherwise the local context window inflates by tens of K tokens
    // (Headroom issue #746).
    ENABLE_TOOL_SEARCH: "true",
  };
}
