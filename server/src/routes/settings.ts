import { Router, Request, Response } from "express";
import type { Server as IOServer } from "socket.io";
import {
  getActiveProvider,
  setActiveProvider,
  buildSettingsResponse,
  loginClaude,
  logoutClaude,
  loginKimi,
  logoutKimi,
} from "../settings/store.js";
import type { ProcessManager } from "../claude/process-manager.js";
import { getProvider, getProviderApiKey } from "../settings/providers.js";

export function createSettingsRouter(processManager: ProcessManager, io: IOServer): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json(buildSettingsResponse());
  });

  // POST /api/settings/provider — switch provider and log in
  router.post("/provider", async (req: Request, res: Response) => {
    const { provider } = req.body as { provider: unknown };
    if (typeof provider !== "string" || !getProvider(provider)) {
      return res.status(400).json({ error: "provider must be a registered provider id" });
    }

    // Anthropic-compatible custom providers (OpenRouter, etc.) authenticate via
    // an API key from settings/env, not the claude/kimi browser OAuth flow;
    // just require the key to be present and skip straight to activation.
    if (provider !== "claude" && provider !== "kimi") {
      if (!getProviderApiKey(provider)) {
        return res.status(400).json({
          error: `No API key configured for '${provider}'. Set it in ~/.claude-chat/settings.json under providers.${provider}.apiKey, or via its env var.`,
        });
      }
      const busy = processManager.getBusySessions();
      if (busy.length > 0) {
        for (const sessionId of busy) processManager.abort(sessionId);
        io.emit("provider:switched", { from: getActiveProvider(), to: provider, abortedSessions: busy });
      }
      setActiveProvider(provider);
      return res.json(buildSettingsResponse());
    }

    const previousProvider = getActiveProvider();
    if (provider === previousProvider) {
      return res.json(buildSettingsResponse());
    }

    // Kill active sessions before switching
    const busySessions = processManager.getBusySessions();
    if (busySessions.length > 0) {
      for (const sessionId of busySessions) {
        processManager.abort(sessionId);
      }
      io.emit("provider:switched", {
        from: previousProvider,
        to: provider,
        abortedSessions: busySessions,
      });
    }

    setActiveProvider(provider);

    // Launch provider login flow (opens browser)
    const loginResult =
      provider === "claude" ? await loginClaude() : await loginKimi();

    if (!loginResult.success) {
      // Revert on failure
      setActiveProvider(previousProvider);
      return res.status(500).json({ error: loginResult.error || "Login failed" });
    }

    res.json(buildSettingsResponse());
  });

  // POST /api/settings/logout — log out of current provider
  router.post("/logout", async (_req: Request, res: Response) => {
    const provider = getActiveProvider();
    if (!provider) {
      return res.json({ success: true });
    }

    const logoutResult =
      provider === "claude" ? await logoutClaude() : await logoutKimi();

    if (!logoutResult.success) {
      return res.status(500).json({ error: logoutResult.error || "Logout failed" });
    }

    setActiveProvider(null);
    res.json({ success: true, settings: buildSettingsResponse() });
  });

  return router;
}
