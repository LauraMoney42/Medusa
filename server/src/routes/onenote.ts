/**
 * OneNote integration routes for the Medusa Mac desktop app.
 *
 * POST /api/onenote/auth/start   — begin device code flow
 * GET  /api/onenote/auth/status  — check connection status
 * DELETE /api/onenote/auth       — disconnect (clears tokens)
 * POST /api/onenote/send         — write a page to OneNote
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { OneNoteService } from "../onenote/service.js";
import { getSettings, updateOneNoteTokens, clearOneNoteTokens } from "../settings/store.js";

// Singleton service — created lazily when a client ID is configured
let _service: OneNoteService | null = null;

function getService(): OneNoteService | null {
  const settings = getSettings();
  const clientId = settings.microsoftClientId;
  if (!clientId) return null;

  // Re-create if client ID changed
  if (!_service || _service.getClientId() !== clientId) {
    _service = new OneNoteService(clientId);
    _service.setTokenUpdateCallback(({ accessToken, refreshToken, expiry }) => {
      updateOneNoteTokens(accessToken, refreshToken, expiry);
    });

    // Restore persisted tokens
    if (settings.microsoftAccessToken && settings.microsoftRefreshToken) {
      _service.restoreTokens(
        settings.microsoftAccessToken,
        settings.microsoftRefreshToken,
        settings.microsoftTokenExpiry ?? 0
      );
    }
  }
  return _service;
}

const SendSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  notebook: z.string().optional(),
  section: z.string().optional(),
});

const SetClientIdSchema = z.object({
  clientId: z.string().min(8),
});

export function createOneNoteRouter(): Router {
  const router = Router();

  // PUT /api/onenote/client-id — save Azure App Client ID
  router.put("/client-id", (req: Request, res: Response) => {
    const parsed = SetClientIdSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: "Invalid clientId" });
    }
    // Reset service so it picks up the new client ID
    _service = null;
    updateOneNoteTokens("", "", 0, parsed.data.clientId);
    return res.json({ ok: true });
  });

  // POST /api/onenote/auth/start — initiate device code flow
  router.post("/auth/start", async (_req: Request, res: Response) => {
    const svc = getService();
    if (!svc) {
      return res.status(400).json({
        error: "Microsoft Client ID not configured. Set it in Settings → OneNote.",
      });
    }
    try {
      const result = await svc.startDeviceCodeFlow();
      return res.json({
        userCode: result.userCode,
        verificationUrl: result.verificationUrl,
        expiresIn: result.expiresIn,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[onenote] Device code flow start failed:", msg);
      return res.status(500).json({ error: msg });
    }
  });

  // GET /api/onenote/auth/status — returns current connection status
  router.get("/auth/status", (_req: Request, res: Response) => {
    const svc = getService();
    if (!svc) {
      const settings = getSettings();
      return res.json({
        status: "disconnected",
        hasClientId: !!settings.microsoftClientId,
      });
    }
    const settings = getSettings();
    return res.json({
      status: svc.getStatus(),
      hasClientId: !!settings.microsoftClientId,
    });
  });

  // DELETE /api/onenote/auth — disconnect and clear tokens
  router.delete("/auth", (_req: Request, res: Response) => {
    if (_service) {
      _service.disconnect();
      _service = null;
    }
    clearOneNoteTokens();
    return res.json({ ok: true, status: "disconnected" });
  });

  // POST /api/onenote/send — write content to OneNote
  router.post("/send", async (req: Request, res: Response) => {
    const parsed = SendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
    }

    const svc = getService();
    if (!svc) {
      return res.status(400).json({ error: "OneNote not configured" });
    }
    if (svc.getStatus() !== "connected") {
      return res.status(401).json({ error: "OneNote not connected — authenticate first" });
    }

    try {
      const { title, content, notebook, section } = parsed.data;
      const page = await svc.writePage(title, content, notebook, section);
      console.log(`[onenote] Page created: ${page.id} — "${title}"`);
      return res.json({ ok: true, pageId: page.id, webUrl: page.webUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[onenote] Write page failed:", msg);
      return res.status(500).json({ error: msg });
    }
  });

  return router;
}
