/**
 * Provider + model listing routes, backing the client's dynamic model picker.
 * Read-only. Never returns API keys.
 */

import { Router, Request, Response } from "express";
import { listProviders, listModels, getProvider, getProviderApiKey } from "../settings/providers.js";

export function createProvidersRouter(): Router {
  const router = Router();

  // GET /api/providers: list registered providers (no secrets)
  router.get("/", (_req: Request, res: Response) => {
    const providers = listProviders().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      anthropicCompatible: p.anthropicCompatible === true,
      hasApiKey: p.apiKeyEnv || p.anthropicCompatible ? Boolean(getProviderApiKey(p.id)) : true,
    }));
    res.json({ providers });
  });

  // GET /api/providers/:id/models: live (cached) or static model list
  router.get("/:id/models", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!getProvider(id)) {
      return res.status(404).json({ error: `Unknown provider '${id}'` });
    }
    const models = await listModels(id);
    res.json({ providerId: id, models });
  });

  return router;
}
