import { Router, Request, Response } from "express";
import config from "../config.js";
import { isHeadroomReady, getHeadroomStats } from "../headroom/proxy-manager.js";

/**
 * Headroom status/stats router. Backs the Settings modal's compression panel.
 * GET /api/headroom/stats → { enabled, ready, port, stats }
 */
export function createHeadroomRouter(): Router {
  const router = Router();

  router.get("/stats", async (_req: Request, res: Response) => {
    const ready = isHeadroomReady();
    const stats = ready ? await getHeadroomStats() : null;
    res.json({
      enabled: config.headroomEnabled,
      ready,
      port: config.headroomPort,
      stats,
    });
  });

  return router;
}
