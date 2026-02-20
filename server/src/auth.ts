import { Request, Response, NextFunction } from "express";
import { parse as parseCookies } from "cookie";
import config from "./config.js";

export const COOKIE_NAME = "medusa-auth";

const COOKIE_OPTIONS = {
  httpOnly: true,   // Not accessible via JS — prevents XSS token theft
  sameSite: "strict" as const,
  path: "/",
  maxAge: 24 * 60 * 60 * 1000, // 24 hours in ms — cookie expires; user must re-auth after expiry
  // Omit `secure` — this app runs on localhost over HTTP.
  // In a production HTTPS deployment, set secure: true.
};

/**
 * Express middleware that validates auth via httpOnly cookie OR Bearer header.
 * Cookie takes precedence. Bearer header is accepted for backward-compat and
 * for clients that cannot use cookies (e.g., CLI tools).
 *
 * Skips auth for the health check endpoint and non-API routes.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Skip auth for non-API routes (static files, SPA fallback)
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }

  // Skip auth for health check and the login endpoint itself
  if (req.method === "GET" && req.path === "/api/health") {
    next();
    return;
  }
  if (req.path === "/api/auth/login" || req.path === "/api/auth/logout") {
    next();
    return;
  }

  // If no auth token is configured, skip auth entirely
  if (!config.authToken) {
    next();
    return;
  }

  // 1. Try httpOnly cookie first
  const cookies = parseCookies(req.headers.cookie ?? "");
  if (cookies[COOKIE_NAME] === config.authToken) {
    next();
    return;
  }

  // 2. Fall back to Bearer header (backward-compat for CLI / direct API use)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token === config.authToken) {
      next();
      return;
    }
  }

  res.status(401).json({ error: "Unauthorized" });
}

/**
 * Sets the httpOnly auth cookie on the response.
 * Called by the /api/auth/login route on successful token validation.
 */
export function setAuthCookie(res: Response): void {
  res.cookie(COOKIE_NAME, config.authToken, COOKIE_OPTIONS);
}

/**
 * Clears the auth cookie on the response.
 * Called by the /api/auth/logout route.
 */
export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTIONS });
}
