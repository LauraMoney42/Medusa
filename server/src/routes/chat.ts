import { Router, Request, Response } from "express";
import { ChatStore } from "../chat/store.js";

export function createChatRouter(chatStore: ChatStore): Router {
  const router = Router();

  // GET /:sessionId/messages — load persisted chat history
  router.get("/:sessionId/messages", (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    const messages = chatStore.loadMessages(sessionId);
    res.json(messages);
  });

  return router;
}
