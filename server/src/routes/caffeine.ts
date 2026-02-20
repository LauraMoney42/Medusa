import { Router } from "express";
import { spawn, type ChildProcess } from "child_process";

/**
 * Caffeine mode: prevents macOS from sleeping while bots are running.
 * Uses the built-in `caffeinate` CLI tool (ships with every Mac since 10.8).
 *
 * `-d` — prevent display sleep
 * `-i` — prevent system idle sleep
 *
 * The process lives as long as Caffeine is enabled; killing it lets the
 * OS resume its normal sleep policy immediately.
 */

let caffeinate: ChildProcess | null = null;
let enabled = false;

function enable(): void {
  if (enabled) return;
  caffeinate = spawn("caffeinate", ["-d", "-i"], {
    detached: false,
    stdio: "ignore",
  });
  caffeinate.on("exit", () => {
    // If caffeinate exits unexpectedly, reset state so the UI stays in sync
    caffeinate = null;
    enabled = false;
  });
  enabled = true;
  console.log("[caffeine] Enabled — system will not sleep");
}

function disable(): void {
  if (!enabled) return;
  if (caffeinate) {
    caffeinate.kill("SIGTERM");
    caffeinate = null;
  }
  enabled = false;
  console.log("[caffeine] Disabled — normal sleep policy restored");
}

export function createCaffeineRouter(): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({ enabled });
  });

  router.post("/enable", (_req, res) => {
    enable();
    res.json({ enabled });
  });

  router.post("/disable", (_req, res) => {
    disable();
    res.json({ enabled });
  });

  return router;
}

/** Called on graceful shutdown so caffeinate doesn't outlive the server. */
export function shutdownCaffeine(): void {
  disable();
}
