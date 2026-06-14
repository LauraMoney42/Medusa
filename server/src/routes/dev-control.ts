import { Router, Request, Response } from "express";
import { DevControlController } from "../dev-control/controller.js";

export function createDevControlRouter(controller: DevControlController): Router {
  const router = Router();

  // GET /api/dev-control — list all session control states
  router.get("/", (_req: Request, res: Response) => {
    res.json(controller.snapshot());
  });

  // GET /api/dev-control/:id — single session control state
  router.get("/:id", (req: Request, res: Response) => {
    const result = controller.getSessionState(req.params.id as string);
    if ("error" in result) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // POST /api/dev-control/:id/pause
  router.post("/:id/pause", (req: Request, res: Response) => {
    const result = controller.pause(req.params.id as string);
    if (!result.ok) {
      res.status(result.error === "Session not found" ? 404 : 500).json({ error: result.error });
      return;
    }
    res.json({ ok: true, wasBusy: result.wasBusy });
  });

  // POST /api/dev-control/:id/resume
  router.post("/:id/resume", (req: Request, res: Response) => {
    const result = controller.resume(req.params.id as string);
    if (!result.ok) {
      res.status(result.error === "Session not found" ? 404 : 500).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  // POST /api/dev-control/:id/status
  router.post("/:id/status", async (req: Request, res: Response) => {
    try {
      const result = await controller.requestStatus(req.params.id as string);
      if (!result.ok) {
        res.status(result.error === "Session not found" ? 404 : 500).json({ error: result.error });
        return;
      }
      res.json({ ok: true, sent: result.sent });
    } catch (err: any) {
      console.error(`[dev-control] status route error:`, err);
      res.status(500).json({ error: err.message || "Failed to request status" });
    }
  });

  return router;
}
