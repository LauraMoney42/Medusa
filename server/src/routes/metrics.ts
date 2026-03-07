/**
 * TC-2B: Token usage metrics API routes.
 *
 * Exposes token usage data logged by TokenLogger for dashboards and analysis.
 * Read-only — no mutations. JSONL log file is the source of truth.
 */

import { Router, Request, Response, RequestHandler } from "express";
import { TokenLogger } from "../metrics/token-logger.js";

/**
 * Build the token-usage handler (shared between /api/metrics/token-usage and /api/token-usage).
 * Extracted so it can be mounted at multiple paths without duplicating logic.
 */
export function createTokenUsageHandler(tokenLogger: TokenLogger): RequestHandler {
  return (req: Request, res: Response) => {
    const period = (req.query.period as string) || "day";

    const now = new Date();
    let from: Date;

    if (period === "week") {
      from = new Date(now);
      from.setDate(from.getDate() - 7);
      from.setHours(0, 0, 0, 0);
    } else if (period === "month") {
      from = new Date(now);
      from.setDate(from.getDate() - 30);
      from.setHours(0, 0, 0, 0);
    } else {
      // Default: day — midnight today to now
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
    }

    const entries = tokenLogger.readRange(from.toISOString(), now.toISOString());
    const summary = tokenLogger.summarize(entries);

    res.json({
      period,
      from: from.toISOString(),
      to: now.toISOString(),
      totalCostUsd: summary.totalCostUsd,
      totalMessages: summary.totalMessages,
      totalDurationMs: summary.totalDurationMs,
      byBot: summary.byBot,
      bySource: summary.bySource,
    });
  };
}

/**
 * Resolve a named period to { from, to } Date objects.
 * Supported: today, yesterday, this_week, last_week, this_month, last_month
 */
function resolvePeriod(name: string): { from: Date; to: Date } | null {
  const now = new Date();

  if (name === "today") {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    return { from, to: new Date(now) };
  }
  if (name === "yesterday") {
    const from = new Date(now); from.setDate(from.getDate() - 1); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  if (name === "this_week") {
    const from = new Date(now); from.setDate(from.getDate() - 7); from.setHours(0, 0, 0, 0);
    return { from, to: new Date(now) };
  }
  if (name === "last_week") {
    const from = new Date(now); from.setDate(from.getDate() - 14); from.setHours(0, 0, 0, 0);
    const to = new Date(now); to.setDate(to.getDate() - 7); to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  if (name === "this_month") {
    const from = new Date(now); from.setDate(from.getDate() - 30); from.setHours(0, 0, 0, 0);
    return { from, to: new Date(now) };
  }
  if (name === "last_month") {
    const from = new Date(now); from.setDate(from.getDate() - 60); from.setHours(0, 0, 0, 0);
    const to = new Date(now); to.setDate(to.getDate() - 30); to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  return null;
}

export function createMetricsRouter(tokenLogger: TokenLogger): { metricsRouter: Router; tokenUsageHandler: RequestHandler } {
  const router = Router();
  const tokenUsageHandler = createTokenUsageHandler(tokenLogger);

  // GET /api/metrics/usage — today's aggregated usage summary
  router.get("/usage", (_req: Request, res: Response) => {
    const summary = tokenLogger.todaySummary();
    res.json(summary);
  });

  // GET /api/metrics/token-usage?period=day|week|month (also aliased at /api/token-usage)
  router.get("/token-usage", tokenUsageHandler);

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

  /**
   * GET /api/metrics/compare?a=today&b=yesterday
   *
   * Returns two period summaries side-by-side for comparison charts.
   * Supported period names: today, yesterday, this_week, last_week, this_month, last_month
   *
   * Response: { a: PeriodSummary, b: PeriodSummary }
   * PeriodSummary: { label, from, to, totalCostUsd, totalMessages, byBot }
   */
  router.get("/compare", (req: Request, res: Response) => {
    const aName = (req.query.a as string) || "today";
    const bName = (req.query.b as string) || "yesterday";

    const aRange = resolvePeriod(aName);
    const bRange = resolvePeriod(bName);

    if (!aRange) {
      res.status(400).json({ error: `Unknown period '${aName}'` });
      return;
    }
    if (!bRange) {
      res.status(400).json({ error: `Unknown period '${bName}'` });
      return;
    }

    const aEntries = tokenLogger.readRange(aRange.from.toISOString(), aRange.to.toISOString());
    const bEntries = tokenLogger.readRange(bRange.from.toISOString(), bRange.to.toISOString());

    const aSummary = tokenLogger.summarize(aEntries);
    const bSummary = tokenLogger.summarize(bEntries);

    const LABELS: Record<string, string> = {
      today: "Today", yesterday: "Yesterday",
      this_week: "This Week", last_week: "Last Week",
      this_month: "This Month", last_month: "Last Month",
    };

    res.json({
      a: {
        label: LABELS[aName] ?? aName,
        from: aRange.from.toISOString(),
        to: aRange.to.toISOString(),
        totalCostUsd: aSummary.totalCostUsd,
        totalMessages: aSummary.totalMessages,
        byBot: aSummary.byBot,
      },
      b: {
        label: LABELS[bName] ?? bName,
        from: bRange.from.toISOString(),
        to: bRange.to.toISOString(),
        totalCostUsd: bSummary.totalCostUsd,
        totalMessages: bSummary.totalMessages,
        byBot: bSummary.byBot,
      },
    });
  });

  return { metricsRouter: router, tokenUsageHandler };
}
