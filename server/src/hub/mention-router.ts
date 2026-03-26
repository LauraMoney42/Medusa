import type { Server as IOServer } from "socket.io";
import type { ProcessManager } from "../claude/process-manager.js";
import type { SessionStore } from "../sessions/store.js";
import type { ChatStore } from "../chat/store.js";
import type { HubStore, HubMessage } from "./store.js";
import type { TokenLogger } from "../metrics/token-logger.js";
import type { QuickTaskStore } from "../projects/quick-task-store.js";
import { autonomousDeliver } from "../claude/autonomous-deliver.js";

interface PendingMention {
  hubMessage: HubMessage;
  chainDepth: number;
}

interface PendingBotTask {
  prompt: string;
  chainDepth: number;
}

/** A user-sent message queued because the session was busy when it arrived. */
interface PendingDirectMessage {
  deliver: () => void;
}

export const MAX_CHAIN_DEPTH = 3;

/**
 * Detects @mentions in hub messages and routes them to the target bot's session.
 * Bot responses are streamed to the session room, run through HubPostDetector,
 * and persisted to chat history.
 *
 * Guards:
 * - Self-mentions are ignored (prevents loops)
 * - Max 20 pending mentions per bot in FIFO queue (21st+ silently dropped)
 * - 60-second cooldown per bot (prevents spam)
 * - Max chain depth of 3 (prevents infinite back-and-forth)
 */
export class MentionRouter {
  private processManager: ProcessManager;
  private sessionStore: SessionStore;
  private hubStore: HubStore;
  private chatStore: ChatStore;
  private io: IOServer;
  private tokenLogger?: TokenLogger;
  private quickTaskStore?: QuickTaskStore;

  /** sessionId -> FIFO queue of pending mentions (max MAX_PENDING per bot) */
  private pendingMentions = new Map<string, PendingMention[]>();

  /** sessionId -> FIFO queue of direct bot-to-bot tasks (max MAX_PENDING per bot) */
  private pendingBotTasks = new Map<string, PendingBotTask[]>();

  /**
   * sessionId -> FIFO queue of user-sent messages that arrived while the session
   * was busy. Drained before hub mentions so the user's next message is never lost.
   */
  private pendingDirectMessages = new Map<string, PendingDirectMessage[]>();

  private static MAX_PENDING = 20; // raised from 3 — low cap caused silent drops when bots @mention each other mid-response

  /** sessionId -> last auto-prompt timestamp (for cooldown) */
  private lastMentionTime = new Map<string, number>();

  private static COOLDOWN_MS = 60_000;

  constructor(
    processManager: ProcessManager,
    sessionStore: SessionStore,
    hubStore: HubStore,
    chatStore: ChatStore,
    io: IOServer,
    tokenLogger?: TokenLogger,
    quickTaskStore?: QuickTaskStore
  ) {
    this.processManager = processManager;
    this.sessionStore = sessionStore;
    this.hubStore = hubStore;
    this.chatStore = chatStore;
    this.io = io;
    this.tokenLogger = tokenLogger;
    this.quickTaskStore = quickTaskStore;
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
    console.log(`[mention-router] processMessage from="${hubMessage.from}" mentions=${JSON.stringify(mentions)} text="${hubMessage.text.slice(0, 80)}"`);

    const allSessions = this.sessionStore.loadAll();

    // If no @mentions, default to Medusa as the responder — but ONLY for
    // user-originated messages. Bot hub posts without @mentions should not
    // auto-route to Medusa (they'd burn the cooldown and block real user requests).
    if (mentions.length === 0) {
      const isUserMessage = hubMessage.from === "User" || hubMessage.from === "You";
      if (!isUserMessage) return;
      const medusa = allSessions.find(
        (s) => s.name.toLowerCase() === "medusa"
      );
      if (medusa) {
        console.log(`[mention-router] No @mentions in "${hubMessage.text.slice(0, 60)}" — routing to Medusa`);
        mentions.push(medusa.name);
      } else {
        return;
      }
    }

    for (const mentionName of mentions) {
      const target = allSessions.find(
        (s) => s.name.toLowerCase() === mentionName.toLowerCase()
      );
      if (!target) continue;

      // Self-mention guard: prevent bots from pinging themselves.
      // Skip this check for user-originated messages — their sessionId is just
      // the active sidebar session, not the sender's own session.
      const isUserMessage = hubMessage.from === "User" || hubMessage.from === "You";
      if (!isUserMessage && target.id === hubMessage.sessionId) continue;

      // Cooldown guard — only applies to bot-originated mentions.
      // User @mentions always go through so the user is never silently ignored.
      if (!isUserMessage) {
        const lastTime = this.lastMentionTime.get(target.id) ?? 0;
        if (Date.now() - lastTime < MentionRouter.COOLDOWN_MS) continue;
      }

      const busy = this.processManager.isSessionBusy(target.id);
      console.log(`[mention-router] → target=${target.name} (${target.id.slice(0, 8)}) busy=${busy} isUser=${isUserMessage}`);
      if (busy) {
        // Enqueue up to MAX_PENDING mentions per bot (FIFO). Silently drop 4th+.
        const queue = this.pendingMentions.get(target.id) ?? [];
        if (queue.length < MentionRouter.MAX_PENDING) {
          queue.push({ hubMessage, chainDepth });
          this.pendingMentions.set(target.id, queue);
          console.log(`[mention-router] → queued (depth: ${queue.length})`);
        }
      } else {
        console.log(`[mention-router] → delivering now`);
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
  /**
   * Queue a user-sent message for delivery once the session becomes idle.
   * Called by the socket handler when a message arrives while the session is busy.
   * The `deliver` callback re-runs the full send pipeline with the original payload.
   */
  queueDirectMessage(sessionId: string, deliver: () => void): void {
    const q = this.pendingDirectMessages.get(sessionId) ?? [];
    q.push({ deliver });
    this.pendingDirectMessages.set(sessionId, q);
    console.log(`[mention-router] Queued direct message for ${sessionId} (queue depth: ${q.length})`);
  }

  onSessionIdle(sessionId: string): void {
    // Drain pending direct (user-sent) messages FIRST — highest priority.
    // These were sent while the session was busy and must not be skipped.
    const directQueue = this.pendingDirectMessages.get(sessionId);
    if (directQueue && directQueue.length > 0) {
      const { deliver } = directQueue.shift()!;
      if (directQueue.length === 0) this.pendingDirectMessages.delete(sessionId);
      deliver();
      return;
    }

    // Drain pending hub mentions next.
    // No cooldown re-check here — cooldown was already enforced at enqueue time.
    // Re-checking would block user mentions that were queued while the session was busy.
    const mentionQueue = this.pendingMentions.get(sessionId);
    if (mentionQueue && mentionQueue.length > 0) {
      const pending = mentionQueue.shift()!;
      if (mentionQueue.length === 0) {
        this.pendingMentions.delete(sessionId);
      }
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

      // Mark bot as having a pending task — enters active task mode per coordination spec
      this.io.emit("bot:task-assigned", { sessionId: targetSessionId });

      if (this.processManager.isSessionBusy(targetSessionId)) {
        // Queue for delivery when target becomes idle (FIFO, max MAX_PENDING)
        const queue = this.pendingBotTasks.get(targetSessionId) ?? [];
        if (queue.length < MentionRouter.MAX_PENDING) {
          queue.push({ prompt: message, chainDepth });
          this.pendingBotTasks.set(targetSessionId, queue);
        }
        // Silently drop if queue is full — consistent with mention behavior
      } else {
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
      tokenLogger: this.tokenLogger,
      quickTaskStore: this.quickTaskStore,
    }).catch((err) => {
      console.error(`[mention-router] bot-to-bot delivery failed for ${sessionId}:`, err);
    });
  }

  /**
   * Extract @mentions from message text by scanning for known session names.
   * Handles multi-word names like "Security" or "Medusa".
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

    // @devs pings every session whose name contains "dev" (case-insensitive), except the sender
    if (lowerText.includes("@devs")) {
      return allSessions
        .filter((s) => s.id !== senderSessionId && s.name.toLowerCase().includes("dev"))
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

    const meta = this.sessionStore.get(sessionId);
    const botName = meta?.name || "Bot";

    const prompt = `[Hub Message from ${hubMessage.from}]: "${hubMessage.text}"\n\nYou are ${botName}. ALWAYS respond via [HUB-POST: your response] so the sender can see your reply in the Hub. If the message is a task or bug: do the actual work first (read code, edit files, fix bugs), then report results via [HUB-POST:]. Do NOT post status dashboards or triage — that is the PM's job. You are NOT Medusa/PM.`;

    // Pass hub message images and files to the Claude process
    const images = hubMessage.images && hubMessage.images.length > 0
      ? hubMessage.images
      : undefined;
    const files = hubMessage.files && hubMessage.files.length > 0
      ? hubMessage.files
      : undefined;

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
      tokenLogger: this.tokenLogger,
      quickTaskStore: this.quickTaskStore,
      images,
      files,
    }).catch((err) => {
      console.error(`[mention-router] autonomousDeliver failed for ${sessionId}:`, err);
    });
  }
}
