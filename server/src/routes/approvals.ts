import { Router, Request, Response } from "express";
import type { Server as IOServer } from "socket.io";
import type { ApprovalStore } from "../hub/approval-store.js";
import type { HubStore } from "../hub/store.js";
import type { MentionRouter } from "../hub/mention-router.js";

/**
 * Human-in-the-loop guardrail — REST surface for the Approve/Deny UI.
 *
 * Resolving a request posts the decision back to the Hub as an @mention to the
 * requesting bot ("@BotName ✅ APPROVED: ..."), reusing the existing hub +
 * mention-routing pipeline exactly as if the user had typed the reply — no new
 * bot-side plumbing required.
 */
export function createApprovalsRouter(
  approvalStore: ApprovalStore,
  hubStore: HubStore,
  mentionRouter: MentionRouter,
  io: IOServer
): Router {
  const router = Router();

  // GET / — all approval requests (pending + resolved), newest first.
  router.get("/", (_req: Request, res: Response) => {
    res.json(approvalStore.getAll());
  });

  function resolve(status: "approved" | "denied") {
    return (req: Request<{ id: string }>, res: Response) => {
      const { id } = req.params;
      const approval = approvalStore.resolve(id, status);
      if (!approval) {
        res.status(404).json({ error: "Approval request not found" });
        return;
      }

      const icon = status === "approved" ? "✅ APPROVED" : "❌ DENIED";
      const hubMsg = hubStore.add({
        from: "You",
        text: `@${approval.from} ${icon}: ${approval.description}`,
        sessionId: approval.sessionId,
      });
      io.emit("hub:message", hubMsg);
      mentionRouter.processMessage(hubMsg);

      io.emit("approval:resolved", approval);
      res.json(approval);
    };
  }

  // POST /:id/approve — resolve as approved and notify the requesting bot.
  router.post("/:id/approve", resolve("approved"));

  // POST /:id/deny — resolve as denied and notify the requesting bot.
  router.post("/:id/deny", resolve("denied"));

  return router;
}
