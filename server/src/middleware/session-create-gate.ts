import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps a rate limiter so it only runs for POST / (creating a new chat).
 *
 * The /api/sessions router also serves GET / (list), PATCH /:id (rename,
 * provider/model change), and DELETE /:id — mounting the session-creation
 * limiter on the whole router throttles those too, so a few minutes of
 * normal chat-list use (switching chats, renaming, changing the model
 * dropdown) can burn through the limiter's bucket and lock the app out of
 * its own session list for the rest of the window.
 */
export function onlySessionCreate(limiter: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "POST" && req.path === "/") {
      return limiter(req, res, next);
    }
    next();
  };
}
