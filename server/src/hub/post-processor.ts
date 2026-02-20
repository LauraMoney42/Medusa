import type { Server as IOServer } from "socket.io";
import type { HubStore } from "./store.js";
import type { MentionRouter } from "./mention-router.js";
import { extractTaskDone } from "../socket/handler.js";

/**
 * Shared hub post processing logic used across handler.ts, mention-router.ts,
 * and poll-scheduler.ts.
 *
 * Why this exists: the same 4-step pattern (add to store, broadcast, route
 * @mentions, detect TASK-DONE) was copy-pasted into 4 separate locations.
 * Any bug fix or new behavior (e.g. @all support) had to be applied 4 times.
 * This centralizes it to one place.
 */
export interface HubPostProcessorOptions {
  from: string;
  sessionId: string;
  hubStore: HubStore;
  mentionRouter: MentionRouter;
  io: IOServer;
  /** Optional callback for chain-routing (mention-router sets its own depth) */
  onPost?: (hubMsgId: string) => void;
  /** Chain depth for mention routing (default 0) */
  chainDepth?: number;
}

/**
 * Process a batch of hub post strings extracted from a bot's streaming response.
 * Adds each post to the hub store, broadcasts it, routes @mentions,
 * and detects [TASK-DONE:] markers.
 */
export function processHubPosts(
  posts: string[],
  opts: HubPostProcessorOptions
): void {
  const { from, sessionId, hubStore, mentionRouter, io, chainDepth = 0 } = opts;

  for (const postText of posts) {
    const hubMsg = hubStore.add({ from, text: postText, sessionId });

    // Broadcast to all connected clients
    io.emit("hub:message", hubMsg);

    // Route @mentions (with optional chain depth for nested routing)
    mentionRouter.processMessage(hubMsg, chainDepth);

    // Detect [TASK-DONE:] markers and emit completion events
    const taskDesc = extractTaskDone(postText);
    if (taskDesc) {
      const task = hubStore.addCompletedTask({
        hubMessageId: hubMsg.id,
        from,
        description: taskDesc,
        sessionId,
      });
      io.emit("task:done", task);
      io.emit("session:pending-task", { sessionId, hasPendingTask: false });
    }

    opts.onPost?.(hubMsg.id);
  }
}
