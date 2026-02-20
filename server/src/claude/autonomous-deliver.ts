/**
 * P0 Architecture Optimization: Unified streaming pipeline for autonomous bot delivery.
 * Eliminates duplication across mention-router, poll-scheduler (poll+nudge), and index.ts auto-resume.
 * All autonomous bot triggers (mention, poll, nudge, resume) now converge on a single implementation.
 */

import { v4 as uuidv4 } from "uuid";
import type { Server as IOServer } from "socket.io";
import type { ProcessManager } from "./process-manager.js";
import type { SessionStore } from "../sessions/store.js";
import type { ChatStore } from "../chat/store.js";
import type { HubStore } from "../hub/store.js";
import type { MentionRouter } from "../hub/mention-router.js";
import type { ParsedEvent } from "./types.js";
import { HubPostDetector, buildHubPromptSection } from "../socket/handler.js";
import { selectModel, NEXT_TIER, type ModelTier } from "./model-router.js";
import { processHubPosts } from "../hub/post-processor.js";
import { summarizeConversation } from "../chat/conversation-summarizer.js";
import config from "../config.js";

export interface AutonomousDeliverParams {
  sessionId: string;
  prompt: string;
  source: "mention" | "poll" | "nudge" | "resume" | "bot-to-bot";
  io: IOServer;
  processManager: ProcessManager;
  sessionStore: SessionStore;
  hubStore: HubStore;
  chatStore: ChatStore;
  mentionRouter?: MentionRouter;
  chainDepth?: number;
  /**
   * P1 optimization: pre-built hub section to avoid rebuilding it for each bot in a tick.
   * When provided, skips the `buildHubPromptSection()` call entirely.
   * Built once per poll tick in `HubPollScheduler.tick()`, passed to all bots polled that tick.
   */
  hubSectionOverride?: string;
}

/**
 * Unified streaming pipeline for autonomous bot delivery.
 * Handles mention, poll, nudge, and resume triggers through a single code path.
 * Behavior varies slightly per source (hub post detection, NO-ACTION filtering, user message persistence).
 */
export async function autonomousDeliver(params: AutonomousDeliverParams): Promise<void> {
  const {
    sessionId,
    prompt,
    source,
    io,
    processManager,
    sessionStore,
    hubStore,
    chatStore,
    mentionRouter,
    chainDepth = 0,
    hubSectionOverride,
  } = params;

  // Determine behavior based on source
  // bot-to-bot uses compact mode — internal task messages don't need full Hub history
  const compactMode = source === "poll" || source === "nudge" || source === "mention" || source === "bot-to-bot";
  const detectHubPosts = source !== "resume"; // Resume doesn't route hub posts
  const persistUserMessage = source !== "poll" && source !== "nudge"; // Poll/nudge defer persistence until NO-ACTION check
  const checkNoAction = source === "poll"; // Only poll checks for [NO-ACTION] to skip persistence

  const meta = sessionStore.get(sessionId);
  if (!meta) return;

  // Lazily ensure session exists in process manager
  try {
    processManager.createSession(sessionId, meta.workingDir, false);
  } catch {
    // Already registered
  }

  const now = new Date().toISOString();
  const userMsgId = uuidv4();
  const assistantMsgId = uuidv4();

  // Emit the user message to the session room
  const userMsg = {
    id: userMsgId,
    sessionId,
    role: "user" as const,
    text: prompt,
    timestamp: now,
  };
  io.to(sessionId).emit("message:user", userMsg);
  // Defer persistence for poll/nudge until we check for NO-ACTION
  if (persistUserMessage) {
    chatStore.appendMessage(userMsg);
  }

  // Emit stream start
  io.to(sessionId).emit("message:stream:start", {
    id: assistantMsgId,
    sessionId,
    role: "assistant",
    text: "",
    timestamp: now,
  });

  // Set busy status
  io.to(sessionId).emit("session:status", { sessionId, status: "busy" });
  sessionStore.updateLastActive(sessionId);

  // Stream state
  let streamEnded = false;
  let gotDeltas = false;
  let assistantText = "";
  const assistantTools: { name: string; input?: unknown; output?: string }[] = [];
  let assistantCost: number | undefined;
  let assistantDurationMs: number | undefined;

  const hubDetector = detectHubPosts ? new HubPostDetector() : null;
  const nextChainDepth = chainDepth + 1;

  // Helper: process extracted hub posts (with chain routing + task-done detection)
  const handleHubPosts = (posts: string[]) => {
    if (!posts.length || !mentionRouter) return;
    processHubPosts(posts, {
      from: meta.name,
      sessionId,
      hubStore,
      mentionRouter,
      io,
      chainDepth: nextChainDepth,
    });
  };

  // Helper: route [BOT-TASK: ...] tokens directly to target bots (no Hub write, no broadcast)
  const handleBotTasks = (tasks: string[]) => {
    if (!tasks.length || !mentionRouter) return;
    mentionRouter.processBotTaskContent(tasks, sessionId, meta.name, nextChainDepth);
  };

  const onEvent = (event: ParsedEvent) => {
    switch (event.kind) {
      case "init":
        console.log(`[autonomous-deliver] stream session=${sessionId} source=${source} model=${event.model}`);
        break;

      case "delta": {
        gotDeltas = true;
        let cleanDelta = event.text;
        let hubPosts: string[] = [];
        let botTasks: string[] = [];

        if (hubDetector) {
          const result = hubDetector.feed(event.text);
          cleanDelta = result.cleanDelta;
          hubPosts = result.hubPosts;
          botTasks = result.botTasks;
        }

        if (cleanDelta) {
          assistantText += cleanDelta;
          io.to(sessionId).emit("message:stream:delta", {
            sessionId,
            messageId: assistantMsgId,
            delta: cleanDelta,
          });
        }

        if (detectHubPosts && hubPosts.length > 0) {
          handleHubPosts(hubPosts);
        }
        if (detectHubPosts && botTasks.length > 0) {
          handleBotTasks(botTasks);
        }
        break;
      }

      case "tool_use_start":
        assistantTools.push({ name: event.toolName, input: event.input });
        io.to(sessionId).emit("message:stream:tool", {
          sessionId,
          messageId: assistantMsgId,
          tool: { name: event.toolName, input: event.input },
        });
        break;

      case "tool_result": {
        const lastTool = assistantTools[assistantTools.length - 1];
        if (lastTool) lastTool.output = event.content;
        io.to(sessionId).emit("message:stream:tool_result", {
          sessionId,
          messageId: assistantMsgId,
          toolName: event.toolUseId,
          output: event.content,
        });
        break;
      }

      case "assistant_complete":
        if (!gotDeltas) {
          for (const block of event.content) {
            if (block.type === "text" && block.text) {
              let cleanDelta = block.text;
              let hubPosts: string[] = [];
              let botTasks: string[] = [];

              if (hubDetector) {
                const result = hubDetector.feed(block.text);
                cleanDelta = result.cleanDelta;
                hubPosts = result.hubPosts;
                botTasks = result.botTasks;
              }

              if (cleanDelta) {
                assistantText += cleanDelta;
                io.to(sessionId).emit("message:stream:delta", {
                  sessionId,
                  messageId: assistantMsgId,
                  delta: cleanDelta,
                });
              }

              if (detectHubPosts && hubPosts.length > 0) {
                handleHubPosts(hubPosts);
              }
              if (detectHubPosts && botTasks.length > 0) {
                handleBotTasks(botTasks);
              }
            }
          }
        }
        break;

      case "result": {
        let remaining = "";
        if (hubDetector) {
          remaining = hubDetector.flush();
        }
        if (remaining) {
          assistantText += remaining;
          io.to(sessionId).emit("message:stream:delta", {
            sessionId,
            messageId: assistantMsgId,
            delta: remaining,
          });
        }
        streamEnded = true;
        assistantCost = event.totalCostUsd;
        assistantDurationMs = event.durationMs;
        io.to(sessionId).emit("message:stream:end", {
          sessionId,
          messageId: assistantMsgId,
          cost: event.totalCostUsd,
          durationMs: event.durationMs,
        });
        break;
      }

      case "error":
        io.to(sessionId).emit("message:error", {
          sessionId,
          messageId: assistantMsgId,
          error: event.message,
        });
        break;
    }
  };

  // Build system prompt with hub context.
  // Use pre-built hub section if provided (P1 tick caching optimization),
  // otherwise build it fresh with per-session message filtering.
  const hubSection = hubSectionOverride !== undefined
    ? hubSectionOverride
    : buildHubPromptSection(hubStore, sessionStore, sessionId, meta.name, compactMode);

  let finalSystemPrompt = (meta.systemPrompt || "") + hubSection;

  // Inject conversation summary if available (TO4: conversation summarization)
  const conversationSummary = chatStore.loadSummary(sessionId);
  if (conversationSummary) {
    finalSystemPrompt += `\n\n--- CONVERSATION SUMMARY (previous context) ---\n${conversationSummary}\n--- END SUMMARY ---`;
  }

  finalSystemPrompt = finalSystemPrompt.trim();

  // Send to bot with tier escalation on failure
  try {
    // Map source to selectModel's expected sources
    // "resume" and "bot-to-bot" use "mention" tier — re-triggered or internal tasks
    const modelSource = source === "resume" || source === "bot-to-bot" ? "mention" : source;

    // Select model based on routing config
    const routingEnabled = config.modelRoutingEnabled !== false;
    let selectedModel: ModelTier = routingEnabled
      ? selectModel({ prompt, source: modelSource })
      : "sonnet";

    // Send message with tier escalation on failure
    let exitCode: number | null = await processManager.sendMessage(
      sessionId,
      prompt,
      undefined,
      onEvent,
      meta.yoloMode === true,
      finalSystemPrompt || undefined,
      selectedModel
    );

    // Escalate to next tier if this tier failed with no output
    if (exitCode !== 0 && !gotDeltas && NEXT_TIER[selectedModel]) {
      const nextTier = NEXT_TIER[selectedModel];
      if (nextTier) {
        console.log(
          `[autonomous-deliver] Model ${selectedModel} failed (exit ${exitCode}), escalating to ${nextTier}`
        );
        selectedModel = nextTier;
        exitCode = await processManager.sendMessage(
          sessionId,
          prompt,
          undefined,
          onEvent,
          meta.yoloMode === true,
          finalSystemPrompt || undefined,
          nextTier
        );
      }
    }

    // Escalate to opus as final fallback if sonnet also failed
    if (exitCode !== 0 && !gotDeltas && selectedModel === "sonnet") {
      console.log(
        `[autonomous-deliver] Model sonnet failed (exit ${exitCode}), escalating to opus (final)`
      );
      exitCode = await processManager.sendMessage(
        sessionId,
        prompt,
        undefined,
        onEvent,
        meta.yoloMode === true,
        finalSystemPrompt || undefined,
        "opus"
      );
    }

    // Finalize stream if parser didn't emit a result event
    if (!streamEnded) {
      let remaining = "";
      if (hubDetector) {
        remaining = hubDetector.flush();
      }
      if (remaining) {
        assistantText += remaining;
        io.to(sessionId).emit("message:stream:delta", {
          sessionId,
          messageId: assistantMsgId,
          delta: remaining,
        });
      }
      io.to(sessionId).emit("message:stream:end", { sessionId, messageId: assistantMsgId });
    }

    // Check for NO-ACTION response (poll only)
    if (checkNoAction) {
      const isNoAction =
        assistantText.trim() === "[NO-ACTION]" ||
        assistantText.includes("[NO-ACTION]");

      if (isNoAction) {
        console.log(`[autonomous-deliver] ${meta.name} responded [NO-ACTION], skipping persistence`);
      } else {
        // Only persist the exchange if the bot had something to say
        chatStore.appendMessage(userMsg);
        chatStore.appendMessage({
          id: assistantMsgId,
          sessionId,
          role: "assistant",
          text: assistantText,
          toolUses: assistantTools.length > 0 ? assistantTools : undefined,
          timestamp: now,
          cost: assistantCost,
          durationMs: assistantDurationMs,
        });
      }
    } else {
      // Persist assistant message (non-poll sources)
      chatStore.appendMessage({
        id: assistantMsgId,
        sessionId,
        role: "assistant",
        text: assistantText,
        toolUses: assistantTools.length > 0 ? assistantTools : undefined,
        timestamp: now,
        cost: assistantCost,
        durationMs: assistantDurationMs,
      });
    }

    // Check if conversation needs summarization (async, don't block response)
    if (config.summarizationEnabled && source !== "resume") {
      const allMessages = chatStore.loadMessages(sessionId);
      if (allMessages.length >= config.summarizationThreshold) {
        console.log(
          `[autonomous-deliver] Session ${sessionId} has ${allMessages.length} messages, triggering summarization`
        );
        // Async summarization — don't block the response
        summarizeConversation(allMessages)
          .then((summary) => {
            // Save summary
            chatStore.saveSummary(sessionId, summary);
            // Keep only the most recent N messages (e.g., last 5)
            const keepCount = 5;
            const trimmed = allMessages.slice(-keepCount);
            chatStore.deleteSession(sessionId);
            for (const msg of trimmed) {
              chatStore.appendMessage(msg);
            }
            console.log(
              `[autonomous-deliver] Session ${sessionId} summarized and trimmed to ${trimmed.length} messages`
            );
            // Reset the session to start fresh on next message (forces new --session-id instead of --resume)
            processManager.createSession(sessionId, meta.workingDir, true);
          })
          .catch((err) => {
            console.error(
              `[autonomous-deliver] Summarization failed for session ${sessionId}:`,
              err
            );
          });
      }
    }

    // Clear pending task and set idle (for mention/poll/nudge)
    if (source !== "resume") {
      io.emit("session:pending-task", { sessionId, hasPendingTask: false });
    }
    io.to(sessionId).emit("session:status", { sessionId, status: "idle" });

    // Deliver any pending mentions (mention/poll/nudge)
    if (mentionRouter && source !== "resume") {
      mentionRouter.onSessionIdle(sessionId);
    }
  } catch (err) {
    console.error(`[autonomous-deliver] Failed to deliver ${source} to ${meta.name}:`, err);
    if (source !== "resume") {
      io.emit("session:pending-task", { sessionId, hasPendingTask: false });
    }
    io.to(sessionId).emit("message:error", {
      sessionId,
      messageId: assistantMsgId,
      error: err instanceof Error ? err.message : `${source} delivery failed`,
    });
    io.to(sessionId).emit("session:status", { sessionId, status: "idle" });
  }
}
