import type { Server as IOServer } from "socket.io";
import type { ProcessManager } from "../claude/process-manager.js";
import type { SessionStore } from "../sessions/store.js";
import type { ChatStore } from "../chat/store.js";
import type { HubStore } from "../hub/store.js";
import type { MentionRouter } from "../hub/mention-router.js";
import type { TokenLogger } from "../metrics/token-logger.js";
import type { QuickTaskStore } from "../projects/quick-task-store.js";
import { DevControlStore } from "./store.js";
import { autonomousDeliver } from "../claude/autonomous-deliver.js";

export interface DevControlStatePayload {
  sessionId: string;
  paused: boolean;
  statusRequested: boolean;
  interrupted: boolean;
  updatedAt: number;
}

export class DevControlController {
  constructor(
    private store: DevControlStore,
    private processManager: ProcessManager,
    private sessionStore: SessionStore,
    private io: IOServer,
    private chatStore: ChatStore,
    private hubStore: HubStore,
    private mentionRouter?: MentionRouter,
    private tokenLogger?: TokenLogger,
    private quickTaskStore?: QuickTaskStore
  ) {}

  private broadcast(sessionId: string): void {
    const entry = this.store.get(sessionId);
    const payload: DevControlStatePayload = {
      sessionId,
      paused: entry.paused,
      statusRequested: entry.statusRequested,
      interrupted: entry.interrupted,
      updatedAt: entry.updatedAt,
    };
    this.io.emit("dev-control:update", payload);
  }

  private getSessionName(sessionId: string): string {
    return this.sessionStore.get(sessionId)?.name ?? sessionId;
  }

  private statusPrompt(): string {
    return `[Status Request] The PM/user has requested an immediate status update. Stop your current work, summarize what you were doing, what is complete, and what remains. Post your status to the Hub with [HUB-POST: your status]. If you have no active work, respond with [NO-ACTION].`;
  }

  /**
   * Pause a session: abort any running process and mark it paused so polls/nudges skip it.
   */
  pause(sessionId: string): { ok: boolean; wasBusy: boolean; error?: string } {
    const meta = this.sessionStore.get(sessionId);
    if (!meta) {
      return { ok: false, wasBusy: false, error: "Session not found" };
    }

    const wasBusy = this.processManager.isSessionBusy(sessionId);
    if (wasBusy) {
      console.log(`[dev-control] Pausing ${meta.name} (${sessionId}) — aborting active process`);
      this.processManager.abort(sessionId);
    }

    this.store.pause(sessionId);
    this.broadcast(sessionId);

    return { ok: true, wasBusy };
  }

  /**
   * Resume a session: clear pause/interrupt flags so normal polling resumes.
   */
  resume(sessionId: string): { ok: boolean; error?: string } {
    const meta = this.sessionStore.get(sessionId);
    if (!meta) {
      return { ok: false, error: "Session not found" };
    }

    this.store.resume(sessionId);
    this.broadcast(sessionId);
    console.log(`[dev-control] Resumed ${meta.name} (${sessionId})`);
    return { ok: true };
  }

  /**
   * Request an immediate status update from a session. This interrupts any running task,
   * then asks the bot to report its status. The request is persisted so it can be retried
   * if the bot is currently paused or busy.
   */
  async requestStatus(sessionId: string): Promise<{ ok: boolean; sent: boolean; error?: string }> {
    const meta = this.sessionStore.get(sessionId);
    if (!meta) {
      return { ok: false, sent: false, error: "Session not found" };
    }

    this.store.requestStatus(sessionId);

    // If currently busy, abort the running task first (context is preserved via --resume)
    if (this.processManager.isSessionBusy(sessionId)) {
      console.log(`[dev-control] Interrupting ${meta.name} (${sessionId}) for status request`);
      this.processManager.abort(sessionId);
      this.store.markInterrupted(sessionId);
    }

    // If paused, don't send now — the scheduler will pick up the pending request on resume
    if (this.store.isPaused(sessionId)) {
      this.broadcast(sessionId);
      return { ok: true, sent: false };
    }

    this.broadcast(sessionId);
    await this.deliverStatusRequest(sessionId);
    return { ok: true, sent: true };
  }

  /**
   * Actually deliver the status prompt to a session. Called by the HTTP endpoint and by
   * the poll scheduler when a pending status request becomes actionable.
   */
  async deliverStatusRequest(sessionId: string): Promise<void> {
    if (!this.store.hasStatusRequest(sessionId)) return;
    if (this.store.isPaused(sessionId)) return;
    if (this.processManager.isSessionBusy(sessionId)) return;

    const meta = this.sessionStore.get(sessionId);
    if (!meta) return;

    this.store.markInterrupted(sessionId);
    this.broadcast(sessionId);

    try {
      await autonomousDeliver({
        sessionId,
        prompt: this.statusPrompt(),
        source: "status-request",
        io: this.io,
        processManager: this.processManager,
        sessionStore: this.sessionStore,
        hubStore: this.hubStore,
        chatStore: this.chatStore,
        mentionRouter: this.mentionRouter,
        tokenLogger: this.tokenLogger,
        quickTaskStore: this.quickTaskStore,
      });
      console.log(`[dev-control] Status request delivered to ${meta.name} (${sessionId})`);
    } catch (err) {
      console.error(`[dev-control] Status request failed for ${meta.name} (${sessionId}):`, err);
      throw err;
    } finally {
      this.store.clearStatusRequest(sessionId);
      this.broadcast(sessionId);
    }
  }

  /**
   * Remove all control state for a deleted session.
   */
  removeSession(sessionId: string): void {
    this.store.remove(sessionId);
    this.io.emit("dev-control:removed", { sessionId });
  }

  /**
   * Build a client-facing snapshot for one session.
   */
  getSessionState(sessionId: string): DevControlStatePayload | { error: string } {
    const meta = this.sessionStore.get(sessionId);
    if (!meta) return { error: "Session not found" };
    const entry = this.store.get(sessionId);
    return {
      sessionId,
      paused: entry.paused,
      statusRequested: entry.statusRequested,
      interrupted: entry.interrupted,
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * Build a client-facing snapshot for all known sessions.
   */
  snapshot(): DevControlStatePayload[] {
    const allSessions = this.sessionStore.loadAll();
    const result: DevControlStatePayload[] = [];
    for (const session of allSessions) {
      const entry = this.store.get(session.id);
      result.push({
        sessionId: session.id,
        paused: entry.paused,
        statusRequested: entry.statusRequested,
        interrupted: entry.interrupted,
        updatedAt: entry.updatedAt,
      });
    }
    return result;
  }
}
