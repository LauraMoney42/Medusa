import { Router, Request, Response } from "express";

/**
 * Creates a shutdown router with a single POST /api/shutdown endpoint.
 * The endpoint triggers graceful shutdown (same as SIGTERM/SIGINT).
 *
 * @param gracefulShutdown - The graceful shutdown function from index.ts
 * @returns Express router
 */
export function createShutdownRouter(
  gracefulShutdown: (signal: string) => Promise<void>
): Router {
  const router = Router();

  /**
   * POST /api/shutdown — Trigger graceful shutdown.
   * Returns 202 Accepted immediately (shutdown is async).
   * Shutdown happens in the background.
   */
  router.post("/", (_req: Request, res: Response) => {
    res.status(202).json({ ok: true, message: "Shutdown initiated" });
    // Fire-and-forget: shutdown runs in the background
    gracefulShutdown("HTTP /api/shutdown").catch((err) => {
      console.error("[shutdown] Error during graceful shutdown:", err);
    });
  });

  return router;
}
