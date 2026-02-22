import type { Server as IOServer } from "socket.io";
import type { HubStore } from "./store.js";
import type { MentionRouter } from "./mention-router.js";
import type { QuickTaskStore } from "../projects/quick-task-store.js";
import { extractTaskDone } from "../socket/handler.js";

/**
 * Extract [QUICK-TASK: title | assignee] from hub post text.
 * Returns { title, assignedTo } or null if no match.
 * Format: [QUICK-TASK: task title | assigned bot name]
 * If no pipe separator, assignee defaults to "Unassigned".
 */
export function extractQuickTask(
  text: string
): { title: string; assignedTo: string } | null {
  const match = text.match(/\[QUICK-TASK:\s*(.*?)\]/i);
  if (!match) return null;
  const inner = match[1].trim();
  if (!inner) return null;

  const parts = inner.split("|").map((s) => s.trim());
  return {
    title: parts[0],
    assignedTo: parts[1] || "Unassigned",
  };
}

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
  /** Optional: enables [QUICK-TASK:] pattern detection in hub posts */
  quickTaskStore?: QuickTaskStore;
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

    // Detect [QUICK-TASK: title | assignee] and auto-create quick tasks
    if (opts.quickTaskStore) {
      const qt = extractQuickTask(postText);
      if (qt) {
        const created = opts.quickTaskStore.create(qt);
        console.log(
          `[quick-task] Auto-created "${created.title}" assigned to ${created.assignedTo} (from ${from})`
        );
        io.emit("quick-tasks:updated", opts.quickTaskStore.getAll());
      }
    }

    opts.onPost?.(hubMsg.id);
  }
}
