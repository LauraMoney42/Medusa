import type { Server as IOServer } from "socket.io";
import type { ProcessManager } from "../claude/process-manager.js";
import type { SessionStore } from "../sessions/store.js";
import type { ChatStore } from "../chat/store.js";
import type { HubStore, HubMessage } from "./store.js";
import { autonomousDeliver } from "../claude/autonomous-deliver.js";

interface PendingMention {
  hubMessage: HubMessage;
  chainDepth: number;
}

interface PendingBotTask {
  prompt: string;
  chainDepth: number;
}

export const MAX_CHAIN_DEPTH = 3;

/**
 * Detects @mentions in hub messages and routes them to the target bot's session.
 * Bot responses are streamed to the session room, run through HubPostDetector,
 * and persisted to chat history.
 *
 * Guards:
 * - Self-mentions are ignored (prevents loops)
 * - Max 3 pending mentions per bot in FIFO queue (4th+ silently dropped)
 * - 60-second cooldown per bot (prevents spam)
 * - Max chain depth of 3 (prevents infinite back-and-forth)
 */
export class MentionRouter {
  private processManager: ProcessManager;
  private sessionStore: SessionStore;
  private hubStore: HubStore;
  private chatStore: ChatStore;
  private io: IOServer;

  /** sessionId -> FIFO queue of pending mentions (max MAX_PENDING per bot) */
  private pendingMentions = new Map<string, PendingMention[]>();

  /** sessionId -> FIFO queue of direct bot-to-bot tasks (max MAX_PENDING per bot) */
  private pendingBotTasks = new Map<string, PendingBotTask[]>();

  private static MAX_PENDING = 3;

  /** sessionId -> last auto-prompt timestamp (for cooldown) */
  private lastMentionTime = new Map<string, number>();

  private static COOLDOWN_MS = 60_000;

  constructor(
    processManager: ProcessManager,
    sessionStore: SessionStore,
    hubStore: HubStore,
    chatStore: ChatStore,
    io: IOServer
  ) {
    this.processManager = processManager;
    this.sessionStore = sessionStore;
    this.hubStore = hubStore;
    this.chatStore = chatStore;
    this.io = io;
  }

  /**
   * Scan a hub message for @mentions and route to matching sessions.
   * chainDepth tracks how deep we are in a mention chain (default 0).
   */
  processMessage(hubMessage: HubMessage, chainDepth = 0): void {
    if (chainDepth >= MAX_CHAIN_DEPTH) {
      console.log(`[mention-router] Chain depth ${chainDepth} reached, stopping`);
      return;
    }

    const mentions = this.extractMentions(hubMessage.text, hubMessage.sessionId);
    if (mentions.length === 0) return;

    const allSessions = this.sessionStore.loadAll();

    for (const mentionName of mentions) {
      const target = allSessions.find(
        (s) => s.name.toLowerCase() === mentionName.toLowerCase()
      );
      if (!target) continue;

      // Self-mention guard
      if (target.id === hubMessage.sessionId) continue;

      // Cooldown guard
      const lastTime = this.lastMentionTime.get(target.id) ?? 0;
      if (Date.now() - lastTime < MentionRouter.COOLDOWN_MS) continue;

      if (this.processManager.isSessionBusy(target.id)) {
        // Enqueue up to MAX_PENDING mentions per bot (FIFO). Silently drop 4th+.
        const queue = this.pendingMentions.get(target.id) ?? [];
        if (queue.length < MentionRouter.MAX_PENDING) {
          queue.push({ hubMessage, chainDepth });
          this.pendingMentions.set(target.id, queue);
          this.io.emit("session:pending-task", { sessionId: target.id, hasPendingTask: true });
        }
      } else {
        // Signal pending task before delivery starts
        this.io.emit("session:pending-task", { sessionId: target.id, hasPendingTask: true });
        this.deliverMention(target.id, hubMessage, chainDepth);
      }
    }
  }

  /**
   * Remove all state for a deleted session to prevent Map growth over time.
   * Call when a session is permanently removed.
   */
  removeSession(sessionId: string): void {
    this.pendingMentions.delete(sessionId);
    this.pendingBotTasks.delete(sessionId);
    this.lastMentionTime.delete(sessionId);
  }

  /**
   * Called when a session becomes idle. Delivers the next queued item (FIFO).
   * Hub mentions are drained first; bot tasks fill in after.
   */
  onSessionIdle(sessionId: string): void {
    // Drain pending hub mentions first
    const mentionQueue = this.pendingMentions.get(sessionId);
    if (mentionQueue && mentionQueue.length > 0) {
      const pending = mentionQueue.shift()!;
      if (mentionQueue.length === 0) {
        this.pendingMentions.delete(sessionId);
      }
      const lastTime = this.lastMentionTime.get(sessionId) ?? 0;
      if (Date.now() - lastTime < MentionRouter.COOLDOWN_MS) return;
      this.deliverMention(sessionId, pending.hubMessage, pending.chainDepth);
      return;
    }

    // Then drain pending bot tasks
    const taskQueue = this.pendingBotTasks.get(sessionId);
    if (taskQueue && taskQueue.length > 0) {
      const task = taskQueue.shift()!;
      if (taskQueue.length === 0) {
        this.pendingBotTasks.delete(sessionId);
      }
      this.deliverBotTaskDirect(sessionId, task.prompt, task.chainDepth);
    }
  }

  /**
   * Parse and route [BOT-TASK: ...] token content extracted from a bot's response.
   * Resolves @BotName to a session, applies self-send + chain depth guards,
   * then delivers directly (no Hub write, no broadcast).
   *
   * chainDepth is the depth AT WHICH the target bot will receive the task.
   * Callers should pass nextChainDepth (= senderChainDepth + 1).
   */
  processBotTaskContent(
    tasks: string[],
    senderSessionId: string,
    senderName: string,
    chainDepth: number
  ): void {
    if (!tasks.length) return;

    if (chainDepth >= MAX_CHAIN_DEPTH) {
      console.warn(
        `[mention-router] [BOT-TASK] from ${senderName} dropped: chain depth ${chainDepth} >= ${MAX_CHAIN_DEPTH}`
      );
      return;
    }

    const allSessions = this.sessionStore.loadAll();
    // Sort longest names first — prevents "@Full Stack Dev" matching just "@Dev"
    const sorted = [...allSessions].sort((a, b) => b.name.length - a.name.length);

    for (const taskContent of tasks) {
      const target = this.resolveBotTaskTarget(taskContent, senderSessionId, sorted);
      if (!target) {
        console.warn(
          `[mention-router] [BOT-TASK] from ${senderName}: unresolvable target in "${taskContent.slice(0, 60)}" — dropping`
        );
        continue; // Fail silently — no Hub fallback per spec
      }

      const { targetSessionId, message } = target;
      console.log(
        `[mention-router] [BOT-TASK] ${senderName} → ${target.targetName} (depth=${chainDepth}): "${message.slice(0, 60)}"`
      );

      if (this.processManager.isSessionBusy(targetSessionId)) {
        // Queue for delivery when target becomes idle (FIFO, max MAX_PENDING)
        const queue = this.pendingBotTasks.get(targetSessionId) ?? [];
        if (queue.length < MentionRouter.MAX_PENDING) {
          queue.push({ prompt: message, chainDepth });
          this.pendingBotTasks.set(targetSessionId, queue);
          this.io.emit("session:pending-task", { sessionId: targetSessionId, hasPendingTask: true });
        }
        // Silently drop if queue is full — consistent with mention behavior
      } else {
        this.io.emit("session:pending-task", { sessionId: targetSessionId, hasPendingTask: true });
        this.deliverBotTaskDirect(targetSessionId, message, chainDepth);
      }
    }
  }

  /**
   * Parse "@BotName message" from a [BOT-TASK: ...] content string.
   * Returns the resolved session ID, bot name, and message — or null if unresolvable.
   */
  private resolveBotTaskTarget(
    content: string,
    senderSessionId: string,
    sortedSessions: { id: string; name: string }[]
  ): { targetSessionId: string; targetName: string; message: string } | null {
    if (!content.startsWith("@")) return null;
    const withoutAt = content.slice(1); // e.g. "Backend Dev please verify..."

    for (const session of sortedSessions) {
      const lowerName = session.name.toLowerCase();
      const lowerContent = withoutAt.toLowerCase();
      if (lowerContent.startsWith(lowerName)) {
        // Self-send guard — no valid use case, prevents loops
        if (session.id === senderSessionId) {
          console.warn(`[mention-router] [BOT-TASK] self-send to ${session.name} dropped`);
          return null;
        }
        const message = withoutAt.slice(session.name.length).trim();
        if (!message) return null; // Empty message body
        return { targetSessionId: session.id, targetName: session.name, message };
      }
    }
    return null;
  }

  /**
   * Queue a direct bot task for delivery to a target session.
   * Called by processBotTaskContent when the target is busy.
   */
  queueBotTask(targetSessionId: string, prompt: string, chainDepth: number): void {
    const queue = this.pendingBotTasks.get(targetSessionId) ?? [];
    if (queue.length < MentionRouter.MAX_PENDING) {
      queue.push({ prompt, chainDepth });
      this.pendingBotTasks.set(targetSessionId, queue);
      this.io.emit("session:pending-task", { sessionId: targetSessionId, hasPendingTask: true });
    }
  }

  /**
   * Deliver a bot task directly to the target session via autonomousDeliver.
   * Source is "bot-to-bot" — uses compact mode, no Hub write, no broadcast.
   */
  private deliverBotTaskDirect(sessionId: string, prompt: string, chainDepth: number): void {
    autonomousDeliver({
      sessionId,
      prompt,
      source: "bot-to-bot",
      io: this.io,
      processManager: this.processManager,
      sessionStore: this.sessionStore,
      hubStore: this.hubStore,
      chatStore: this.chatStore,
      mentionRouter: this,
      chainDepth,
    }).catch((err) => {
      console.error(`[mention-router] bot-to-bot delivery failed for ${sessionId}:`, err);
    });
  }

  /**
   * Extract @mentions from message text by scanning for known session names.
   * Handles multi-word names like "Full Stack Dev" or "UI Dev".
   * Sorted longest-first so "@Full Stack Dev" matches the full name, not just "Dev".
   */
  private extractMentions(text: string, senderSessionId?: string): string[] {
    const allSessions = this.sessionStore.loadAll();
    const lowerText = text.toLowerCase();

    // @all pings every session except the sender
    if (lowerText.includes("@all")) {
      return allSessions
        .filter((s) => s.id !== senderSessionId)
        .map((s) => s.name);
    }

    const mentioned: string[] = [];

    // Sort longest names first to prevent partial matches (e.g. "@Full Stack Dev" before "@Dev")
    const sorted = [...allSessions].sort(
      (a, b) => b.name.length - a.name.length
    );

    for (const session of sorted) {
      const pattern = `@${session.name.toLowerCase()}`;
      if (lowerText.includes(pattern)) {
        mentioned.push(session.name);
      }
    }

    return mentioned;
  }

  /**
   * Send the hub mention to the target session via autonomousDeliver.
   */
  private deliverMention(sessionId: string, hubMessage: HubMessage, chainDepth: number): void {
    this.lastMentionTime.set(sessionId, Date.now());

    const prompt = `[Hub Request] A teammate tagged you in the Hub: "${hubMessage.text}" (from ${hubMessage.from}). Please review and respond. If you have something to share back, use [HUB-POST: your response].`;

    autonomousDeliver({
      sessionId,
      prompt,
      source: "mention",
      io: this.io,
      processManager: this.processManager,
      sessionStore: this.sessionStore,
      hubStore: this.hubStore,
      chatStore: this.chatStore,
      mentionRouter: this,
      chainDepth,
    }).catch((err) => {
      console.error(`[mention-router] autonomousDeliver failed for ${sessionId}:`, err);
    });
  }
}
