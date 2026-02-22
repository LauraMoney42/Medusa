import type { Server as IOServer } from "socket.io";
import type { ProcessManager } from "../claude/process-manager.js";
import type { SessionStore } from "../sessions/store.js";
import type { ChatStore } from "../chat/store.js";
import type { HubStore } from "./store.js";
import type { MentionRouter } from "./mention-router.js";
import type { TokenLogger } from "../metrics/token-logger.js";
import type { QuickTaskStore } from "../projects/quick-task-store.js";
import { autonomousDeliver } from "../claude/autonomous-deliver.js";
import config from "../config.js";

/** Per-bot cooldown: 2 minutes between polls (reduced from 10min to keep bots active) */
const PER_BOT_COOLDOWN_MS = 2 * 60 * 1000;
/** Max bots polled per tick to prevent stampede */
const MAX_BOTS_PER_TICK = 4;
/** Heartbeat stale threshold: if a bot hasn't responded in 10 min, flag as stale */
const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
/** Only warn about a stale bot once per this cooldown to avoid Hub spam */
const STALE_WARN_COOLDOWN_MS = 15 * 60 * 1000;

interface StaleEntry {
  sessionId: string;
  assignedAt: number;
  nudged: boolean;
}

/**
 * Periodically nudges idle bots to check the Hub for unaddressed messages.
 * Disabled by default — enable via HUB_POLLING=true env var.
 *
 * Fixes applied:
 * - Tracks last-seen hub message per bot (skips if no new messages)
 * - Filters out self-authored messages (don't poll a bot about its own posts)
 * - [NO-ACTION] marker: silently discards empty check-ins from chat history
 */
export class HubPollScheduler {
  private processManager: ProcessManager;
  private sessionStore: SessionStore;
  private hubStore: HubStore;
  private mentionRouter: MentionRouter;
  private io: IOServer;
  private chatStore: ChatStore;
  private tokenLogger?: TokenLogger;
  private quickTaskStore?: QuickTaskStore;

  /** sessionId -> last poll timestamp */
  private lastPollTime = new Map<string, number>();
  /** sessionId -> last hub message ID the bot was polled about */
  private lastSeenMessageId = new Map<string, string>();
  /** sessionId -> stale assignment tracking */
  private staleAssignments = new Map<string, StaleEntry>();
  /** sessionId -> last activity timestamp (heartbeat tracking) */
  private lastHeartbeat = new Map<string, number>();
  /** sessionId -> last time we warned about this bot being stale */
  private lastStaleWarning = new Map<string, number>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    processManager: ProcessManager,
    sessionStore: SessionStore,
    hubStore: HubStore,
    mentionRouter: MentionRouter,
    io: IOServer,
    chatStore: ChatStore,
    tokenLogger?: TokenLogger,
    quickTaskStore?: QuickTaskStore
  ) {
    this.processManager = processManager;
    this.sessionStore = sessionStore;
    this.hubStore = hubStore;
    this.mentionRouter = mentionRouter;
    this.io = io;
    this.chatStore = chatStore;
    this.tokenLogger = tokenLogger;
    this.quickTaskStore = quickTaskStore;
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => this.tick(), config.hubPollIntervalMs);
    console.log("[poll-scheduler] Started");
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log("[poll-scheduler] Stopped");
    }
  }

  /**
   * Track a pending task assignment for stale detection.
   * Call when session:pending-task fires with hasPendingTask: true.
   */
  trackPendingTask(sessionId: string): void {
    if (!this.staleAssignments.has(sessionId)) {
      this.staleAssignments.set(sessionId, {
        sessionId,
        assignedAt: Date.now(),
        nudged: false,
      });
      console.log(`[poll-scheduler] Tracking pending task for session ${sessionId}`);
    }
  }

  /**
   * Remove all state for a deleted session to prevent Map growth over time.
   * Call when a session is permanently removed.
   */
  removeSession(sessionId: string): void {
    this.lastPollTime.delete(sessionId);
    this.lastSeenMessageId.delete(sessionId);
    this.staleAssignments.delete(sessionId);
    this.lastHeartbeat.delete(sessionId);
    this.lastStaleWarning.delete(sessionId);
  }

  /**
   * Record a heartbeat for a bot session. Call whenever a bot shows activity:
   * - After autonomousDeliver completes (poll, mention, nudge, bot-to-bot)
   * - On server startup for all registered sessions
   * - When a bot posts a Hub message
   */
  recordHeartbeat(sessionId: string): void {
    this.lastHeartbeat.set(sessionId, Date.now());
  }

  /**
   * Check all bot sessions for heartbeat staleness.
   * If a bot hasn't had activity in HEARTBEAT_STALE_MS and isn't currently busy,
   * post a warning to Hub (once per STALE_WARN_COOLDOWN_MS).
   */
  private checkBotHeartbeats(): void {
    const now = Date.now();
    const allSessions = this.sessionStore.loadAll();

    for (const session of allSessions) {
      // Skip non-bot sessions
      if (session.name === "You" || session.name === "System") continue;

      // Skip if bot is currently busy (it's working, not stale)
      if (this.processManager.isSessionBusy(session.id)) {
        // Busy = active, update heartbeat
        this.lastHeartbeat.set(session.id, now);
        continue;
      }

      const lastBeat = this.lastHeartbeat.get(session.id);
      if (!lastBeat) {
        // No heartbeat recorded yet — initialize and skip
        this.lastHeartbeat.set(session.id, now);
        continue;
      }

      const silentMs = now - lastBeat;
      if (silentMs < HEARTBEAT_STALE_MS) continue;

      // Check stale warning cooldown — don't spam Hub
      const lastWarning = this.lastStaleWarning.get(session.id) ?? 0;
      if (now - lastWarning < STALE_WARN_COOLDOWN_MS) continue;

      // Bot is stale — post warning to Hub
      const minutesSilent = Math.round(silentMs / 60_000);
      this.lastStaleWarning.set(session.id, now);

      const warningMsg = this.hubStore.add({
        from: "System",
        text: `⚠️ ${session.name} has been silent for ${minutesSilent} min. May need attention. @You`,
        sessionId: "",
      });
      this.io.emit("hub:message", warningMsg);
      console.log(`[poll-scheduler] Heartbeat stale: ${session.name} silent for ${minutesSilent}m`);
    }
  }

  /**
   * Clear a pending task assignment.
   * Call when session:pending-task fires with hasPendingTask: false, or TASK-DONE detected.
   */
  clearPendingTask(sessionId: string): void {
    if (this.staleAssignments.delete(sessionId)) {
      console.log(`[poll-scheduler] Cleared pending task for session ${sessionId}`);
    }
  }

  /**
   * Check for stale assignments and auto-nudge bots that haven't reported progress.
   * Called on each poll tick.
   */
  private checkStaleAssignments(): void {
    const now = Date.now();

    for (const [sessionId, entry] of this.staleAssignments) {
      // Skip if already nudged (single nudge per assignment)
      if (entry.nudged) continue;

      // Skip if not yet stale
      if (now - entry.assignedAt < config.staleTaskThresholdMs) continue;

      // Skip if bot is currently busy (it's working, not stale)
      if (this.processManager.isSessionBusy(sessionId)) continue;

      const meta = this.sessionStore.get(sessionId);
      if (!meta) continue;

      const minutesAgo = Math.round((now - entry.assignedAt) / 60_000);

      // Mark as nudged before sending (prevents re-nudge on next tick)
      entry.nudged = true;

      // Post warning to Hub
      const warningMsg = this.hubStore.add({
        from: "System",
        text: `⚠️ ${meta.name} was assigned a task ${minutesAgo} minutes ago and hasn't reported progress. Nudging...`,
        sessionId: "",
      });
      this.io.emit("hub:message", warningMsg);

      console.log(`[poll-scheduler] Stale assignment detected: ${meta.name} (${minutesAgo}m), sending nudge`);

      // Auto-nudge the bot directly
      this.nudgeBot(sessionId, minutesAgo);
    }
  }

  /**
   * Send a direct nudge message to a bot about its stale assignment via autonomousDeliver.
   */
  private nudgeBot(sessionId: string, minutesAgo: number): void {
    const meta = this.sessionStore.get(sessionId);
    if (!meta) return;

    // Skip if busy — the bot is doing something
    if (this.processManager.isSessionBusy(sessionId)) return;

    const prompt = `You were assigned a task via the Hub ${minutesAgo} minutes ago but haven't started or reported progress. Please check your Hub assignments and either start working or report what's blocking you.`;

    autonomousDeliver({
      sessionId,
      prompt,
      source: "nudge",
      io: this.io,
      processManager: this.processManager,
      sessionStore: this.sessionStore,
      hubStore: this.hubStore,
      chatStore: this.chatStore,
      mentionRouter: this.mentionRouter,
      tokenLogger: this.tokenLogger,
      quickTaskStore: this.quickTaskStore,
    }).then(() => {
      this.recordHeartbeat(sessionId);
    }).catch((err) => {
      console.error(`[poll-scheduler] nudgeBot autonomousDeliver failed:`, err);
    });
  }

  private tick(): void {
    // Check for stale assignments on every tick, even if no new hub messages
    this.checkStaleAssignments();

    // Check bot heartbeats — flag bots that haven't responded recently
    this.checkBotHeartbeats();

    const recentMessages = this.hubStore.getRecent(20);
    if (recentMessages.length === 0) return;

    const allSessions = this.sessionStore.loadAll();
    const now = Date.now();
    let polledCount = 0;

    for (const session of allSessions) {
      if (polledCount >= MAX_BOTS_PER_TICK) break;

      // Skip busy bots
      if (this.processManager.isSessionBusy(session.id)) continue;

      // Per-bot cooldown
      const lastPoll = this.lastPollTime.get(session.id) ?? 0;
      if (now - lastPoll < PER_BOT_COOLDOWN_MS) continue;

      // Fix 3: Only poll if new messages exist since last check
      const lastSeenId = this.lastSeenMessageId.get(session.id);
      const lastSeenIdx = lastSeenId
        ? recentMessages.findIndex((m) => m.id === lastSeenId)
        : -1;
      const newMessages = recentMessages.slice(lastSeenIdx + 1);
      if (newMessages.length === 0) continue;

      // Idle bot hibernation: bots with no pending tasks only wake for direct @mentions.
      // Bots with pending tasks get the full relevant feed (broadcasts, system, @You).
      const hasPendingTask = this.staleAssignments.has(session.id);
      const lowerName = session.name.toLowerCase();

      const relevantNew = newMessages.filter((m) => {
        // Exclude self-authored
        if (m.sessionId === session.id) return false;
        const lowerText = m.text.toLowerCase();

        // Direct @mention always wakes the bot
        if (lowerText.includes(`@${lowerName}`)) return true;

        // @all targets every bot — wake regardless of pending task status
        if (lowerText.includes("@all")) return true;

        // If hibernating (no pending tasks), only wake for direct @mentions / @all
        if (!hasPendingTask) return false;

        // Below here: bot has pending tasks, include broader context
        // Include system messages
        if (m.from === "System") return true;
        // Include @You escalations
        if (lowerText.includes("@you")) return true;
        // Include broadcasts (no @ mentions)
        if (!lowerText.includes("@")) return true;
        // Skip messages directed at other bots
        return false;
      });
      if (relevantNew.length === 0) {
        // Mark as seen even if no relevant new messages
        this.lastSeenMessageId.set(
          session.id,
          recentMessages[recentMessages.length - 1].id
        );
        continue;
      }

      // TC-5: Capture previous last-seen ID for delta context, then update
      const previousLastSeenId = this.lastSeenMessageId.get(session.id);
      this.lastSeenMessageId.set(
        session.id,
        recentMessages[recentMessages.length - 1].id
      );

      this.pollBot(session.id, relevantNew.length, previousLastSeenId);
      polledCount++;
    }
  }

  /**
   * Send a "check the Hub" prompt to a single bot.
   * autonomousDeliver builds the hub section per-session (filtered to relevant messages only)
   * so each bot only sees what @mentions them, system messages, @You, and broadcasts.
   *
   * TC-5: sinceMessageId enables delta context — only new messages since this ID
   * are included in the hub prompt, with an anchor for previously seen messages.
   */
  private pollBot(sessionId: string, newMessageCount: number, sinceMessageId?: string): void {
    const meta = this.sessionStore.get(sessionId);
    if (!meta) return;

    this.lastPollTime.set(sessionId, Date.now());

    const prompt = `[Hub Check] There are ${newMessageCount} new message(s) in the Hub since your last check. Review them in the Hub context above. If any are relevant to your role or expertise, respond via [HUB-POST: your response]. If you have assigned tasks you haven't started or completed, start working on them now and post a status update. If you are blocked, escalate with [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: <what you need>]. If nothing needs your attention, respond with exactly: [NO-ACTION]`;

    autonomousDeliver({
      sessionId,
      prompt,
      source: "poll",
      io: this.io,
      processManager: this.processManager,
      sessionStore: this.sessionStore,
      hubStore: this.hubStore,
      chatStore: this.chatStore,
      mentionRouter: this.mentionRouter,
      tokenLogger: this.tokenLogger,
      quickTaskStore: this.quickTaskStore,
      // TC-5: Pass last-seen message ID for delta hub context
      sinceMessageId,
    }).then(() => {
      this.recordHeartbeat(sessionId);
    }).catch((err) => {
      console.error(`[poll-scheduler] pollBot autonomousDeliver failed:`, err);
    });
  }
}
