import { Router } from "express";
import { timingSafeEqual, createHash } from "crypto";
import rateLimit from "express-rate-limit";
import config from "../config.js";
import { setAuthCookie, clearAuthCookie } from "../auth.js";

/**
 * Rate limiter for the login endpoint.
 * Max 5 attempts per 15 minutes per IP — prevents brute-force of the auth token.
 * Only failed attempts (4xx/5xx) are counted by skipSuccessfulRequests.
 */
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  skipSuccessfulRequests: true, // Only failed logins count toward the limit
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts — try again in 15 minutes" },
});

/**
 * Constant-time token comparison to prevent timing side-channel attacks.
 * Falls back to false if either input is empty.
 */
function safeTokenCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  // Hash both inputs to equal-length buffers before timingSafeEqual
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * POST /api/auth/login  { token: string }
 *   Validates the token and sets an httpOnly session cookie.
 *   Returns 200 on success, 401 on bad token.
 *
 * POST /api/auth/logout
 *   Clears the auth cookie.
 *
 * GET  /api/auth/me
 *   Returns { ok: true } if the request is authenticated (cookie or Bearer).
 *   Used by the client to check auth state without reading localStorage.
 */
export function createAuthRouter(): Router {
  const router = Router();

  // Apply brute-force rate limiter before the login handler
  router.post("/login", loginRateLimiter, (req, res) => {
    if (!config.authToken) {
      // Auth disabled — always succeed
      setAuthCookie(res);
      res.json({ ok: true });
      return;
    }

    const { token } = req.body as { token?: string };
    // Use constant-time comparison to prevent timing side-channel attacks
    if (!token || typeof token !== "string" || !safeTokenCompare(token.trim(), config.authToken)) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    setAuthCookie(res);
    res.json({ ok: true });
  });

  router.post("/logout", (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  // Auth-protected by the global authMiddleware (cookie or Bearer)
  router.get("/me", (_req, res) => {
    res.json({ ok: true });
  });

  return router;
}
