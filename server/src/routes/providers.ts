/**
 * Provider + model listing routes, backing the client's dynamic model picker,
 * plus the Providers settings tab (W8): storing, removing and verifying API
 * keys for OpenRouter and the external voice services (Gemini, OpenAI,
 * Deepgram) without hand-editing ~/.claude-chat/settings.json.
 *
 * GET routes here never return a full key, only whether one is set, where it
 * came from, and its last 4 characters.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  listProviders,
  listModels,
  getProvider,
  getProviderApiKey,
  listManagedKeyProviders,
  getKeyStatus,
  setProviderApiKey,
  removeProviderApiKey,
  verifyProviderKey,
  resolveManagedProviderKey,
} from "../settings/providers.js";

const apiKeyBodySchema = z.object({
  apiKey: z.string().trim().min(1, "apiKey must not be empty"),
});

/**
 * Small in-memory limiter for POST /:id/verify: 10 calls per minute per
 * caller IP. Deliberately not express-rate-limit here, so tests can drive it
 * directly through the exported handler without a real HTTP stack.
 */
const VERIFY_WINDOW_MS = 60_000;
const VERIFY_MAX = 10;
const verifyHits = new Map<string, number[]>();

function isVerifyRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (verifyHits.get(key) ?? []).filter((t) => now - t < VERIFY_WINDOW_MS);
  hits.push(now);
  verifyHits.set(key, hits);
  return hits.length > VERIFY_MAX;
}

/** Test-only escape hatch, mirroring _clearModelCache. */
export function _clearVerifyRateLimit(): void {
  verifyHits.clear();
}

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

  // GET /api/providers/keys: managed-key inventory for Settings > Providers.
  router.get("/keys", (_req: Request, res: Response) => {
    const providers = listManagedKeyProviders().map((p) => {
      const status = getKeyStatus(p.id, p.apiKeyEnv);
      return {
        id: p.id,
        displayName: p.displayName,
        hasKey: status.hasKey,
        source: status.source,
        keyUrl: p.keyUrl,
        last4: status.last4,
      };
    });
    res.json({ providers });
  });

  // PUT /api/providers/:id/key: store a key in settings.json (600 perms).
  router.put("/:id/key", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!listManagedKeyProviders().some((p) => p.id === id)) {
      return res.status(404).json({ error: `Unknown provider '${id}'` });
    }
    const parsed = apiKeyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    }
    setProviderApiKey(id, parsed.data.apiKey);
    const entry = listManagedKeyProviders().find((p) => p.id === id)!;
    const status = getKeyStatus(id, entry.apiKeyEnv);
    res.json({
      id,
      displayName: entry.displayName,
      hasKey: status.hasKey,
      source: status.source,
      keyUrl: entry.keyUrl,
      last4: status.last4,
    });
  });

  // DELETE /api/providers/:id/key: remove a stored key.
  router.delete("/:id/key", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const entry = listManagedKeyProviders().find((p) => p.id === id);
    if (!entry) {
      return res.status(404).json({ error: `Unknown provider '${id}'` });
    }
    removeProviderApiKey(id);
    const status = getKeyStatus(id, entry.apiKeyEnv);
    res.json({
      id,
      displayName: entry.displayName,
      hasKey: status.hasKey,
      source: status.source,
      keyUrl: entry.keyUrl,
      last4: status.last4,
    });
  });

  // POST /api/providers/:id/verify: one cheap authenticated call. Rate
  // limited to 10/minute per caller so this can't be used to hammer the
  // upstream API.
  router.post("/:id/verify", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const entry = listManagedKeyProviders().find((p) => p.id === id);
    if (!entry) {
      return res.status(404).json({ error: `Unknown provider '${id}'` });
    }

    const limitKey = req.ip ?? "unknown";
    if (isVerifyRateLimited(limitKey)) {
      return res.status(429).json({ ok: false, message: "Too many verify attempts. Try again in a minute." });
    }

    // Verify whatever key would actually be used: settings first, env
    // second (getKeyStatus/getProviderApiKey precedence), or one supplied
    // in the body for a not-yet-saved key so "Verify" works before "Save".
    const bodyKey =
      typeof (req.body as { apiKey?: unknown })?.apiKey === "string"
        ? ((req.body as { apiKey: string }).apiKey.trim() || undefined)
        : undefined;
    const apiKey = bodyKey ?? resolveManagedProviderKey(id, entry.apiKeyEnv);
    if (!apiKey) {
      return res.status(400).json({ ok: false, message: "No key to verify. Save or paste a key first." });
    }

    const result = await verifyProviderKey(id, apiKey);
    res.json(result);
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
