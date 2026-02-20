import { Router, Request, Response } from "express";
import type { Server as IOServer } from "socket.io";
import type { HubStore } from "../hub/store.js";
import type { MentionRouter } from "../hub/mention-router.js";
import type { SessionStore } from "../sessions/store.js";

export function createHubRouter(
  hubStore: HubStore,
  io: IOServer,
  mentionRouter: MentionRouter,
  sessionStore: SessionStore
): Router {
  const router = Router();

  // GET / — return all hub messages (for initial client load)
  router.get("/", (_req: Request, res: Response) => {
    const messages = hubStore.getAll();
    res.json(messages);
  });

  // POST / — external tools (PM bot, CLI scripts) can post to the Hub
  router.post("/", (req: Request, res: Response) => {
    const { from, text, sessionId } = req.body as {
      from?: string;
      text?: string;
      sessionId?: string;
    };

    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    // P2-8: Reject oversized messages to prevent storage and memory exhaustion.
    const MAX_HUB_TEXT = 5_000;
    if (text.length > MAX_HUB_TEXT) {
      res.status(400).json({ error: `text exceeds maximum length of ${MAX_HUB_TEXT} characters` });
      return;
    }

    // Determine the "from" name: use session name if sessionId provided, else require "from"
    let displayName = from;
    if (sessionId) {
      const meta = sessionStore.get(sessionId);
      if (meta) {
        displayName = meta.name;
      }
    }

    if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
      res.status(400).json({ error: "from is required (or provide a valid sessionId)" });
      return;
    }

    const hubMsg = hubStore.add({
      from: displayName.trim(),
      text: text.trim(),
      sessionId: sessionId || "",
    });

    // Broadcast to all connected clients
    io.emit("hub:message", hubMsg);

    // Route any @mentions
    mentionRouter.processMessage(hubMsg);

    res.status(201).json(hubMsg);
  });

  // GET /tasks — return unacknowledged completed tasks
  router.get("/tasks", (_req: Request, res: Response) => {
    const tasks = hubStore.getUnacknowledged();
    res.json(tasks);
  });

  // POST /tasks/ack — acknowledge all completed tasks (clears badges + checkmarks)
  router.post("/tasks/ack", (_req: Request, res: Response) => {
    hubStore.acknowledgeAll();
    // Broadcast to all clients so they can clear checkmark icons
    io.emit("tasks:acknowledged");
    res.json({ ok: true });
  });

  return router;
}
