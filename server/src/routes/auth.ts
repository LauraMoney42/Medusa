import { Router } from "express";
import { timingSafeEqual, createHash } from "crypto";
import rateLimit from "express-rate-limit";
import config from "../config.js";
import { setAuthCookie, clearAuthCookie } from "../auth.js";

/**
 * True for requests arriving over the loopback interface (127.0.0.1 / ::1 /
 * ::ffff:127.0.0.1), i.e. the desktop shell's own sidecar traffic rather
 * than a remote caller.
 */
function isLoopback(ip: string | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Rate limiter for the login endpoint.
 * Max 5 attempts per 15 minutes per IP -- prevents brute-force of the auth token.
 *
 * Two ways a request avoids counting against that budget:
 *  - skipSuccessfulRequests: any successful login (right token, any origin)
 *    is not counted, so a legitimate user reconnecting repeatedly never
 *    burns down their own budget.
 *  - skip(): a loopback request presenting the correct token is skipped
 *    entirely, before the handler even runs. This matters for the desktop
 *    shell's own handoff -- if a stale token or a prior bad attempt already
 *    ate into the window, the shell's own correct-token login must still
 *    get through rather than tripping over its own rate limit. Wrong-token
 *    attempts from loopback are still counted and can still be throttled.
 */
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  skipSuccessfulRequests: true, // Only failed logins count toward the limit
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts — try again in 15 minutes" },
  skip: (req) => {
    if (!isLoopback(req.ip)) return false;
    if (!config.authToken) return false;
    const { token } = (req.body ?? {}) as { token?: string };
    return typeof token === "string" && safeTokenCompare(token.trim(), config.authToken);
  },
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
    console.log(`[auth] successful login from ${req.ip}`);
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
