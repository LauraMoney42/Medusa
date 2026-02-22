import { Router, Request, Response } from "express";
import type { QuickTaskStore } from "../projects/quick-task-store.js";

export function createQuickTasksRouter(store: QuickTaskStore): Router {
  const router = Router();

  // GET / — list all quick tasks
  router.get("/", (_req: Request, res: Response) => {
    res.json(store.getAll());
  });

  // POST / — create a quick task
  router.post("/", (req: Request, res: Response) => {
    const { title, assignedTo } = req.body as {
      title?: string;
      assignedTo?: string;
    };

    if (!title || typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "title is required" });
      return;
    }

    const task = store.create({
      title: title.trim(),
      assignedTo: (assignedTo || "").trim(),
    });

    res.status(201).json(task);
  });

  // PATCH /:id — update a quick task
  router.patch("/:id", (req: Request, res: Response) => {
    const { title, assignedTo, status } = req.body as {
      title?: string;
      assignedTo?: string;
      status?: string;
    };

    const updated = store.update(req.params.id as string, {
      ...(title !== undefined && { title }),
      ...(assignedTo !== undefined && { assignedTo }),
      ...(status !== undefined && { status: status as "pending" | "in_progress" | "done" }),
    });

    if (!updated) {
      res.status(404).json({ error: "Quick task not found" });
      return;
    }
    res.json(updated);
  });

  // DELETE /:id — delete a quick task
  router.delete("/:id", (req: Request, res: Response) => {
    const deleted = store.delete(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: "Quick task not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
