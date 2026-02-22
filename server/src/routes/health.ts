import { Router, Request, Response } from "express";
import type { ProcessManager } from "../claude/process-manager.js";
import type { HubPollScheduler } from "../hub/poll-scheduler.js";
import type { Server as IOServer } from "socket.io";
import config from "../config.js";

export function createHealthRouter(
  processManager: ProcessManager,
  pollScheduler: HubPollScheduler | null,
  io: IOServer
): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
    });
  });

  /**
   * POST /api/health/shutdown
   * Trigger graceful shutdown sequence.
   * Requires Bearer token auth to prevent unauthorized DoS.
   * Returns immediately; actual shutdown happens asynchronously.
   */
  router.post("/shutdown", (req: Request, res: Response) => {
    // Extract and verify auth token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!token || token !== config.authToken) {
      console.warn("[shutdown] Unauthorized shutdown attempt rejected");
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("[shutdown] Graceful shutdown requested via HTTP (authenticated)");

    // Send 202 Accepted immediately so client knows request was received
    res.status(202).json({ ok: true, message: "Shutdown initiated" });

    // Trigger the graceful shutdown asynchronously (don't wait)
    setImmediate(() => {
      gracefulShutdown(processManager, pollScheduler, io);
    });
  });

  /**
   * POST /api/health/restart
   * Triggers a server restart by exiting with code 75.
   * The macOS app detects this exit code and auto-relaunches the server.
   * Uses cookie-based auth (same as other API endpoints).
   */
  router.post("/restart", (_req: Request, res: Response) => {
    console.log("[restart] Restart requested via HTTP");
    res.status(202).json({ ok: true, message: "Restarting" });

    // Exit with code 75 so the macOS app knows to restart (not crash)
    setImmediate(() => {
      console.log("[restart] Exiting with code 75 for auto-restart...");
      process.exit(75);
    });
  });

  return router;
}

/**
 * Graceful shutdown sequence:
 * 1. Stop accepting new connections (if we had a server ref, would call server.close())
 * 2. Stop the Hub poll scheduler
 * 3. Wait for active Claude sessions to finish (up to timeout)
 * 4. Notify clients
 * 5. Exit process
 */
async function gracefulShutdown(
  processManager: ProcessManager,
  pollScheduler: HubPollScheduler | null,
  io: IOServer
): Promise<void> {
  const config = (await import("../config.js")).default;
  const timeout = config.gracefulTimeoutMs || 30000;
  const startTime = Date.now();

  console.log("[shutdown] Starting graceful shutdown...");

  // Stop polling
  if (pollScheduler) {
    pollScheduler.stop();
    console.log("[shutdown] Stopped Hub poll scheduler");
  }

  // Get currently busy sessions
  const busySessions = processManager.getBusySessions();
  console.log(
    `[shutdown] Waiting for ${busySessions.length} active session(s) to finish (timeout: ${timeout}ms)`
  );

  // Load session names for the notification
  const sessionStore = (await import("../sessions/store.js")).SessionStore;
  const sessionsPath = require("path").join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".claude-chat",
    "sessions.json"
  );
  let busyInfo: { id: string; name: string }[] = [];
  try {
    const raw = require("fs").readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw);
    busyInfo = busySessions
      .map((id) => {
        const session = sessions.find((s: { id: string }) => s.id === id);
        return { id, name: session?.name || "Unknown" };
      });
  } catch {
    busyInfo = busySessions.map((id) => ({ id, name: "Unknown" }));
  }

  // Notify clients that shutdown is happening
  io.emit("server:shutting-down", { busySessions: busyInfo });

  // Poll for active sessions to finish
  const pollInterval = 500; // ms
  while (Date.now() - startTime < timeout) {
    const remaining = processManager.getBusySessions();
    if (remaining.length === 0) {
      console.log("[shutdown] All sessions completed gracefully");
      break;
    }
    console.log(
      `[shutdown] Waiting for ${remaining.length} session(s)... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`
    );
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // If timeout reached, log a warning
  const elapsed = Date.now() - startTime;
  if (elapsed >= timeout) {
    const stillBusy = processManager.getBusySessions();
    console.warn(
      `[shutdown] Timeout reached after ${elapsed}ms with ${stillBusy.length} session(s) still active. Force exiting.`
    );
  }

  console.log("[shutdown] Graceful shutdown complete. Exiting.");
  process.exit(0);
}

export default createHealthRouter;
