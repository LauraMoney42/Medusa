import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  getActiveAccount,
  setActiveAccount,
  buildSettingsResponse,
  updateSettings,
  checkAllAccountsLoginStatus,
  checkAccountLoginStatus,
  loginAccount,
  logoutAccount,
  getConfigDirForAccount,
} from "../settings/store.js";

// Schema for PATCH /api/settings body — partial update, both fields optional
const PatchSettingsSchema = z.object({
  llmProvider: z.enum(["claude", "openai"]).optional(),
  // Min length 10 catches clearly bogus values; format varies by provider
  llmApiKey: z.string().min(10, "API key must be at least 10 characters").optional(),
});

export function createSettingsRouter(): Router {
  const router = Router();

  // GET /api/settings — returns current settings with masked API key
  router.get("/", (_req: Request, res: Response) => {
    res.json(buildSettingsResponse());
  });

  // PATCH /api/settings — partial update for llmProvider and/or llmApiKey
  // Auth is enforced by global authMiddleware — can't change token without being authenticated
  router.patch("/", (req: Request, res: Response) => {
    const parsed = PatchSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        error: "Invalid settings",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      return res.status(422).json({ error: "No valid fields to update" });
    }

    try {
      updateSettings(patch);
      // Log the update without leaking the key value
      const updated = Object.keys(patch).join(", ");
      console.log(`[settings] Updated: ${updated}`);
      return res.json(buildSettingsResponse());
    } catch (err) {
      console.error("[settings] PATCH failed:", err);
      return res.status(500).json({ error: "Failed to save settings" });
    }
  });

  // POST /api/settings/account — switch active Claude account (preserved for compat)
  router.post("/account", (req: Request, res: Response) => {
    const { account } = req.body as { account: unknown };
    if (account !== 1 && account !== 2) {
      return res.status(400).json({ error: "account must be 1 or 2" });
    }
    setActiveAccount(account);
    return res.json(buildSettingsResponse());
  });

  // GET /api/settings/login-status — async check of Claude CLI login status per account
  router.get("/login-status", async (_req: Request, res: Response) => {
    try {
      const statuses = await checkAllAccountsLoginStatus();
      res.json({ ...buildSettingsResponse(), loginStatuses: statuses });
    } catch (err) {
      console.error("[settings] Login status check failed:", err);
      res.status(500).json({ error: "Failed to check login status" });
    }
  });

  // POST /api/settings/account/:id/login — trigger `claude login` for an account
  router.post("/account/:id/login", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (id !== 1 && id !== 2) {
      return res.status(400).json({ error: "account must be 1 or 2" });
    }
    try {
      const configDir = getConfigDirForAccount(id as 1 | 2);
      const result = await loginAccount(configDir);
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Login failed" });
      }
      // Return fresh status after login
      const status = await checkAccountLoginStatus(configDir);
      return res.json({ success: true, loginStatus: status });
    } catch (err) {
      console.error(`[settings] Login for account ${id} failed:`, err);
      return res.status(500).json({ error: "Login failed" });
    }
  });

  // POST /api/settings/account/:id/logout — trigger `claude logout` for an account
  router.post("/account/:id/logout", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (id !== 1 && id !== 2) {
      return res.status(400).json({ error: "account must be 1 or 2" });
    }
    try {
      const configDir = getConfigDirForAccount(id as 1 | 2);
      const result = await logoutAccount(configDir);
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Logout failed" });
      }
      return res.json({ success: true, loginStatus: { loggedIn: false } });
    } catch (err) {
      console.error(`[settings] Logout for account ${id} failed:`, err);
      return res.status(500).json({ error: "Logout failed" });
    }
  });

  return router;
}
