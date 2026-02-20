import { Router, Request, Response } from "express";
import { SkillCatalog } from "../skills/catalog.js";

export function createSkillsRouter(catalog: SkillCatalog): Router {
  const router = Router();

  // GET / — return the full skill catalog (name + description, no content)
  router.get("/", (_req: Request, res: Response) => {
    const { skills, ready } = catalog.getCatalog();
    res.json({ skills, ready });
  });

  return router;
}
