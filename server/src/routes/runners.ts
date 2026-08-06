import { Router, Request, Response } from "express";
import type { RunnerManager } from "../runner/runner-manager.js";

/**
 * REST surface for the multi-machine runner protocol. See runner-manager.ts
 * for the security model — exec runs an arbitrary shell command on the target
 * machine, gated only by this app's normal AUTH_TOKEN (applied globally to
 * /api/* by authMiddleware, same as every other route here).
 */
export function createRunnersRouter(runnerManager: RunnerManager): Router {
  const router = Router();

  // GET / — list currently connected runners.
  router.get("/", (_req: Request, res: Response) => {
    res.json(runnerManager.list());
  });

  // POST /:name/exec — run a shell command on the named runner.
  router.post("/:name/exec", async (req: Request<{ name: string }>, res: Response) => {
    const { name } = req.params;
    const { command, cwd } = req.body as { command?: string; cwd?: string };

    if (!command || typeof command !== "string" || !command.trim()) {
      res.status(400).json({ error: "command is required" });
      return;
    }
    if (!runnerManager.isConnected(name)) {
      res.status(404).json({ error: `Runner "${name}" is not connected` });
      return;
    }

    try {
      const result = await runnerManager.exec(name, command, cwd);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Exec failed" });
    }
  });

  return router;
}
