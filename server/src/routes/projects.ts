import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { ProjectStore } from "../projects/store.js";

export function createProjectsRouter(projectStore: ProjectStore): Router {
  const router = Router();

  // GET / — list all projects (summary view)
  router.get("/", (_req: Request, res: Response) => {
    const projects = projectStore.getAll().map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary,
      status: p.status,
      priority: p.priority,
      assignments: p.assignments,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
    res.json(projects);
  });

  // GET /:id — full project with content
  router.get("/:id", (req: Request, res: Response) => {
    const project = projectStore.getById(req.params.id as string);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project);
  });

  // POST / — create a new project
  router.post("/", (req: Request, res: Response) => {
    const { title, summary, content, assignments } = req.body as {
      title?: string;
      summary?: string;
      content?: string;
      assignments?: Array<{ id?: string; owner: string; task: string; status?: string }>;
    };

    if (!title || typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (!content || typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const project = projectStore.create({
      title: title.trim(),
      summary: (summary || "").trim(),
      content: content.trim(),
      assignments: (assignments || []).map((a) => ({
        id: a.id || uuidv4(),
        owner: a.owner || "",
        task: a.task || "",
        status: (a.status as "pending" | "in_progress" | "done") || "pending",
      })),
    });

    res.status(201).json(project);
  });

  // PATCH /:id — update a project
  router.patch("/:id", (req: Request, res: Response) => {
    const updated = projectStore.update(req.params.id as string, req.body);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(updated);
  });

  // DELETE /:id — delete a project
  router.delete("/:id", (req: Request, res: Response) => {
    const deleted = projectStore.delete(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
