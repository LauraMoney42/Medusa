import { Router, Request, Response } from "express";
import { SubagentError, type SubagentManager } from "../subagents/manager.js";
import { toResultView, toStatusView } from "../subagents/types.js";

/**
 * The HTTP surface the `medusa` MCP shim calls (spec A.3/A.4).
 *
 * Every route is scoped to one parent chat, taken from the
 * `x-medusa-parent-session-id` header the shim sets from the environment it
 * was spawned with. The model never supplies it, so one chat can neither see
 * nor cancel another chat's subagents.
 *
 * Mounted behind the global `authMiddleware`, so the shim's Bearer token is
 * already checked by the time a handler runs.
 */
export const PARENT_SESSION_HEADER = "x-medusa-parent-session-id";

function parentSessionOf(req: Request): string | null {
  const header = req.header(PARENT_SESSION_HEADER);
  if (header && header.trim()) return header.trim();
  const body = (req.body ?? {}) as { parentSessionId?: unknown };
  if (typeof body.parentSessionId === "string" && body.parentSessionId.trim()) {
    return body.parentSessionId.trim();
  }
  return null;
}

export function createSubagentsRouter(manager: SubagentManager): Router {
  const router = Router();

  const requireParent = (
    req: Request,
    res: Response
  ): string | null => {
    const parentSessionId = parentSessionOf(req);
    if (!parentSessionId) {
      res.status(400).json({ error: `${PARENT_SESSION_HEADER} is required` });
      return null;
    }
    return parentSessionId;
  };

  // POST / -- spawn_agent
  router.post("/", async (req: Request, res: Response) => {
    const parentSessionId = requireParent(req, res);
    if (!parentSessionId) return;

    const body = (req.body ?? {}) as {
      task?: unknown;
      name?: unknown;
      engine?: unknown;
      model?: unknown;
      cwd?: unknown;
      wait?: unknown;
      parentToolUseId?: unknown;
    };

    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;

    let record;
    try {
      record = manager.spawn({
        parentSessionId,
        task: typeof body.task === "string" ? body.task : "",
        name: str(body.name),
        engine: str(body.engine),
        model: str(body.model),
        cwd: str(body.cwd),
        parentToolUseId: str(body.parentToolUseId) ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(err instanceof SubagentError ? 400 : 500).json({ error: message });
      return;
    }

    // `wait` defaults to true: the tool call does not return until the
    // subagent finishes, so its final text lands as the parent's tool_result.
    const wait = body.wait !== false;
    if (!wait) {
      res.status(202).json({ agentId: record.id, status: record.status });
      return;
    }

    try {
      const finished = await manager.waitFor(record.id);
      res.json(toResultView(finished));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET / -- list_agents, for this parent only.
  // GET /?all=1 -- every chat's subagents (S15 Tasks panel hydration only;
  // the MCP shim never sets this, so a chat still cannot ask another chat's
  // question through the normal path).
  router.get("/", (req: Request, res: Response) => {
    if (req.query.all === "1") {
      res.json({ agents: manager.listAll() });
      return;
    }
    const parentSessionId = requireParent(req, res);
    if (!parentSessionId) return;
    res.json({ agents: manager.listForParent(parentSessionId) });
  });

  // GET /:id -- agent_status
  router.get("/:id", (req: Request, res: Response) => {
    const parentSessionId = requireParent(req, res);
    if (!parentSessionId) return;
    const view = manager.status(req.params.id as string, parentSessionId);
    if (!view) {
      res.status(404).json({ error: "Subagent not found" });
      return;
    }
    res.json(view);
  });

  // GET /:id/result -- agent_result. Blocks while the subagent is in flight.
  router.get("/:id/result", async (req: Request, res: Response) => {
    const parentSessionId = requireParent(req, res);
    if (!parentSessionId) return;
    const id = req.params.id as string;
    const record = manager.getForParent(id, parentSessionId);
    if (!record) {
      res.status(404).json({ error: "Subagent not found" });
      return;
    }
    if (!record.endedAt) {
      const finished = await manager.waitFor(id);
      res.json(toResultView(finished));
      return;
    }
    res.json(toResultView(record));
  });

  // POST /:id/cancel -- cancel_agent
  router.post("/:id/cancel", (req: Request, res: Response) => {
    const parentSessionId = requireParent(req, res);
    if (!parentSessionId) return;
    const id = req.params.id as string;
    const record = manager.getForParent(id, parentSessionId);
    if (!record) {
      res.status(404).json({ error: "Subagent not found" });
      return;
    }
    const accepted = manager.cancel(id);
    // A running subagent reaches `cancelled` only once its child exits, so
    // report the intent rather than the not-yet-updated record status.
    res.json({
      agentId: id,
      status: accepted ? "cancelled" : toStatusView(record).status,
    });
  });

  return router;
}
