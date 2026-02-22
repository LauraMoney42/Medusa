/**
 * TC-2B: Token usage metrics API routes.
 *
 * Exposes token usage data logged by TokenLogger for dashboards and analysis.
 * Read-only — no mutations. JSONL log file is the source of truth.
 */

import { Router, Request, Response } from "express";
import { TokenLogger } from "../metrics/token-logger.js";

export function createMetricsRouter(tokenLogger: TokenLogger): Router {
  const router = Router();

  // GET /api/metrics/usage — today's aggregated usage summary
  router.get("/usage", (_req: Request, res: Response) => {
    const summary = tokenLogger.todaySummary();
    res.json(summary);
  });

  // GET /api/metrics/usage/range?from=ISO&to=ISO — usage within a time range
  router.get("/usage/range", (req: Request, res: Response) => {
    const { from, to } = req.query as { from?: string; to?: string };
    if (!from || !to) {
      res.status(400).json({ error: "Both 'from' and 'to' query params required (ISO date strings)" });
      return;
    }
    const entries = tokenLogger.readRange(from, to);
    const summary = tokenLogger.summarize(entries);
    res.json({ summary, entryCount: entries.length });
  });

  // GET /api/metrics/usage/raw?limit=N — raw log entries (newest first)
  router.get("/usage/raw", (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string || "100", 10);
    const all = tokenLogger.readAll();
    // Return newest first, capped at limit
    const entries = all.slice(-Math.min(limit, 1000)).reverse();
    res.json({ entries, total: all.length });
  });

  return router;
}
