import { Server as IOServer } from "socket.io";
import type { Socket } from "socket.io";
import { timingSafeEqual, createHash } from "crypto";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import config from "../config.js";
import { compress, assembleSystemPrompt, estimateTokens } from "../compressor/engine.js";
import { buildOrchestratorPrompt } from "../sessions/orchestrator-prompt.js";
import { startScreencast, stopScreencast, sendCoworkInput, type CoworkInput } from "../cowork/screencast.js";
import { startSimulatorStream, stopSimulatorStream, sendSimulatorInput, type SimulatorInput } from "../cowork/simulator-stream.js";

// P2-9: Validate that every image path is within the uploads directory.
// Accepts URL paths (/uploads/filename) and converts them to filesystem paths
// before validation. path.basename() strips any traversal attempts before join.
// Rejects anything that resolves outside uploadsDir. Filters silently.
export function sanitizeImagePaths(images: string[] | undefined): string[] {
  if (!images || images.length === 0) return [];
  const uploadsDir = path.resolve(config.uploadsDir);
  return images.flatMap((img) => {
    if (typeof img !== "string" || !img.trim()) return [];
    // Convert URL path (/uploads/filename.png) → filesystem path.
    // path.basename() neutralises any traversal before we join.
    const fsPath = img.startsWith("/uploads/")
      ? path.join(uploadsDir, path.basename(img))
      : img;
    const resolved = path.resolve(fsPath);
    if (!resolved.startsWith(uploadsDir + path.sep) && resolved !== uploadsDir) {
      console.warn(`[handler] Rejected image path outside uploads dir: ${img}`);
      return [];
    }
    return [resolved];
  });
}

// ---- Socket.IO handshake rate limiter (P1-5) ----
// Tracks failed auth attempts per IP. After MAX_FAILURES in WINDOW_MS, rejects all
// connections from that IP until the window expires.
const HANDSHAKE_MAX_FAILURES = 5;
const HANDSHAKE_WINDOW_MS = 60_000; // 1 minute

interface FailureEntry {
  count: number;
  windowStart: number;
}

const handshakeFailures = new Map<string, FailureEntry>();

function isHandshakeRateLimited(ip: string): boolean {
  const entry = handshakeFailures.get(ip);
  if (!entry) return false;
  // Reset window if expired
  if (Date.now() - entry.windowStart > HANDSHAKE_WINDOW_MS) {
    handshakeFailures.delete(ip);
    return false;
  }
  return entry.count >= HANDSHAKE_MAX_FAILURES;
}

function recordHandshakeFailure(ip: string): void {
  const now = Date.now();
  const entry = handshakeFailures.get(ip);
  if (!entry || now - entry.windowStart > HANDSHAKE_WINDOW_MS) {
    handshakeFailures.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

/**
 * Constant-time token comparison to prevent timing side-channel attacks.
 */
function safeTokenCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
import { ProcessManager } from "../claude/process-manager.js";
import { SessionStore } from "../sessions/store.js";
import { SkillCatalog } from "../skills/catalog.js";
import { ChatStore } from "../chat/store.js";
import type { ParsedEvent } from "../claude/types.js";
import type { TokenLogger } from "../metrics/token-logger.js";
import { selectModel, NEXT_TIER, type ModelTier } from "../claude/model-router.js";
import { summarizeConversation } from "../chat/conversation-summarizer.js";
import { summarizingSessionIds } from "../chat/summarization-guard.js";
import { getActiveProvider, getActiveConfigDir } from "../settings/store.js";
import { isAnthropicCompatibleProvider, getDefaultModel } from "../settings/providers.js";
import { isAuthError, ConsecutiveErrorDeduper, buildAllTiersFailedMessage } from "./error-policy.js";
import type { SubagentManager } from "../subagents/manager.js";
import { descriptorForSession } from "../mcp/config.js";
import { registerVoiceHandlers } from "./voice-handlers.js";
import {
  activityFromParsedEvent,
  activityFromSubagentEvent,
  type SubagentActivityPayload,
} from "./activity.js";

// ---- Activity Log emission ----
// The Activity Log is the session-wide superset of a message's own tool cards
// (UI addendum). Both entry points below only translate and broadcast; the
// mapping itself lives in `activity.ts` and is unit-tested there.

/** Broadcast the Activity Log lines for one parsed stream event. */
function emitParsedActivity(
  io: IOServer,
  sessionId: string,
  event: ParsedEvent
): void {
  const ts = new Date().toISOString();
  for (const line of activityFromParsedEvent(sessionId, event, ts)) {
    io.to(sessionId).emit("activity:event", line);
  }
}

/**
 * Broadcast the Activity Log lines for one `subagent:*` emission. Called from
 * the SubagentManager's emitter in `index.ts`, which is the only place that
 * sees those events, so a subagent's traffic reaches the log the same way the
 * parent's does.
 */
export function emitSubagentActivity(
  io: IOServer,
  eventName: string,
  payload: SubagentActivityPayload
): void {
  const ts = new Date().toISOString();
  for (const line of activityFromSubagentEvent(eventName, payload, ts)) {
    io.to(line.sessionId).emit("activity:event", line);
  }
}

// ---- Per-session send queue ----
// A minimal stand-in for the old MentionRouter's queueDirectMessage/onSessionIdle:
// if a user sends a message while the session is already busy, hold it here and
// drain it once the in-flight turn finishes. One pending call per session is all
// the client can produce (the input is disabled while busy), so a simple FIFO
// array is enough.
const pendingSendQueues = new Map<string, Array<() => void>>();

function queueDirectMessage(sessionId: string, fn: () => void): void {
  const queue = pendingSendQueues.get(sessionId) ?? [];
  queue.push(fn);
  pendingSendQueues.set(sessionId, queue);
}

function drainSendQueue(sessionId: string): void {
  const queue = pendingSendQueues.get(sessionId);
  if (!queue || queue.length === 0) return;
  const next = queue.shift();
  if (queue.length === 0) pendingSendQueues.delete(sessionId);
  next?.();
}


// ---- Socket Handler ----

/**
 * Wire up Socket.IO authentication and event handlers.
 */
export function setupSocketHandler(
  io: IOServer,
  processManager: ProcessManager,
  store: SessionStore,
  skillCatalog: SkillCatalog,
  chatStore: ChatStore,
  tokenLogger?: TokenLogger,
  subagentManager?: SubagentManager
): void {
  // ---- Auth middleware (rate-limited + constant-time comparison) ----
  io.use((socket, next) => {
    if (!config.authToken) {
      return next();
    }

    // Resolve source IP (respects X-Forwarded-For for proxy deployments)
    const ip =
      (socket.handshake.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ||
      socket.handshake.address ||
      "unknown";

    // Reject immediately if this IP has exceeded the failure threshold
    if (isHandshakeRateLimited(ip)) {
      console.warn(`[socket] Rate limited handshake from ${ip}`);
      return next(new Error("Too many authentication attempts — try again later"));
    }

    // 1. Accept token from Socket.IO auth payload (legacy client path)
    const authToken = socket.handshake.auth?.token as string | undefined;
    if (authToken && safeTokenCompare(authToken, config.authToken)) {
      return next();
    }

    // 2. Accept httpOnly cookie (new cookie-based auth path).
    // Socket.IO sends the browser's cookies in the HTTP upgrade request headers.
    const cookieHeader = (socket.handshake.headers.cookie as string | undefined) ?? "";
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map((c: string) => {
        const [k, ...v] = c.trim().split("=");
        return [k, v.join("=")];
      })
    );
    const cookieToken = cookies["medusa-auth"] as string | undefined;
    if (cookieToken && safeTokenCompare(cookieToken, config.authToken)) {
      return next();
    }

    // Auth failed — record failure and reject
    recordHandshakeFailure(ip);
    const failures = handshakeFailures.get(ip)?.count ?? 1;
    console.warn(`[socket] Auth failure from ${ip} (${failures}/${HANDSHAKE_MAX_FAILURES})`);
    return next(new Error("Authentication failed"));
  });

  // ---- Core message send pipeline ----
  // Extracted from the message:send socket handler so it can be called both
  // directly (session idle) and via queueDirectMessage (session was busy).
  // All deps are closed over from setupSocketHandler scope — no `socket` needed here
  // since every emission uses io.to(sessionId) (room broadcast).
  async function handleMessageSend(
    sessionId: string,
    text: string,
    images: string[] | undefined,
    files: string[] | undefined
  ): Promise<void> {
    const meta = store.get(sessionId);
    if (!meta) return; // session removed between queue and drain — skip silently

    const now = new Date().toISOString();
    const userMsgId = uuidv4();
    const assistantMsgId = uuidv4();

    // Sanitize file paths the same way as images
    const sanitizedFiles = sanitizeImagePaths(files);

    // Echo the user message with the shape the client expects (ChatMessage)
    const userMsg = {
      id: userMsgId,
      sessionId,
      role: "user" as const,
      text,
      images,
      files: sanitizedFiles.length > 0 ? files : undefined,
      timestamp: now,
    };
    io.to(sessionId).emit("message:user", userMsg);

    // Persist user message
    chatStore.appendMessage(userMsg);

    // Immediately emit the assistant stream start so the client creates
    // the accumulation buffer before any deltas arrive
    io.to(sessionId).emit("message:stream:start", {
      id: assistantMsgId,
      sessionId,
      role: "assistant",
      text: "",
      timestamp: now,
    });

    store.updateLastActive(sessionId);

    // Track whether stream:end was sent so we can finalize on abort/crash
    let streamEnded = false;
    // Track whether any deltas were emitted (to avoid duplicating text
    // from the assistant_complete event which always contains the full text)
    let gotDeltas = false;

    // Accumulate assistant response for persistence
    let assistantText = "";
    const assistantTools: {
      id?: string;
      name: string;
      input?: unknown;
      output?: string;
      isError?: boolean;
      parentToolUseId?: string | null;
    }[] = [];
    let assistantCost: number | undefined;
    let assistantDurationMs: number | undefined;

    // Tracks whether the last error emitted was a repeat, so tier-escalation
    // retries don't render the same "Not logged in" (or any other) message
    // two or three times in a row. Also records whether any error seen so
    // far is an auth error, since escalating to a different model tier
    // can't fix that.
    const errorDeduper = new ConsecutiveErrorDeduper();
    let authErrorSeen = false;

    // Provider/model for this send, used to tag the usage log entry below.
    // `currentModel` is assigned once the model is selected further down; onEvent
    // is a closure over this same block scope, so by the time the "result" event
    // actually fires (after the child process has been spawned) it will be set.
    // S2: the chat's own provider wins; the global setting is only the fallback,
    // so one chat can run on OpenRouter while another stays native.
    const activeProviderId = meta.providerId ?? getActiveProvider();
    let currentModel = "";

    // Stream callback — translate ParsedEvents into client-expected shapes
    const onEvent = (event: ParsedEvent) => {
      // Activity Log: every parsed event becomes one or more log lines. Done
      // before the switch so nothing that returns early can skip the log.
      emitParsedActivity(io, sessionId, event);

      switch (event.kind) {
        case "init":
          console.log(
            `[stream] session=${sessionId} model=${event.model}`
          );
          break;

        case "delta": {
          // Subagent text (forwarded with --forward-subagent-text) is not the
          // agent's own answer: it goes to the subagent card, and it must not
          // suppress the main message's assistant_complete text.
          if (event.parentToolUseId) break;

          gotDeltas = true;

          assistantText += event.text;
          io.to(sessionId).emit("message:stream:delta", {
            sessionId,
            messageId: assistantMsgId,
            delta: event.text,
          });
          break;
        }

        case "tool_use_start":
          assistantTools.push({
            id: event.toolId,
            name: event.toolName,
            input: event.input,
            parentToolUseId: event.parentToolUseId ?? null,
          });
          io.to(sessionId).emit("message:stream:tool", {
            sessionId,
            messageId: assistantMsgId,
            tool: {
              id: event.toolId,
              name: event.toolName,
              input: event.input,
              parentToolUseId: event.parentToolUseId ?? null,
            },
          });
          // S1 2e: the MCP shim is never told the id of the tool call it is
          // servicing, so correlate the card to this block on the server side.
          if (
            event.toolName === "spawn_agent" ||
            event.toolName === "mcp__medusa__spawn_agent"
          ) {
            const input = event.input as { task?: unknown } | undefined;
            const task = typeof input?.task === "string" ? input.task : null;
            subagentManager?.registerSpawnToolUse(sessionId, event.toolId, task);
          }
          break;

        case "tool_input_delta":
          // The completed `assistant` message carries the whole input, so the
          // partial JSON is not forwarded. Kept as an explicit no-op so the
          // switch stays exhaustive over ParsedEvent.
          break;

        case "tool_result": {
          // Pair by tool id, not by arrival order: parallel tool calls and
          // subagent results interleave.
          const target =
            assistantTools.find((t) => t.id === event.toolUseId) ??
            assistantTools[assistantTools.length - 1];
          if (target) {
            target.output = event.content;
            target.isError = event.isError;
          }
          io.to(sessionId).emit("message:stream:tool_result", {
            sessionId,
            messageId: assistantMsgId,
            toolUseId: event.toolUseId,
            // Legacy field name kept for older clients; now the real name.
            toolName: target?.name ?? event.toolUseId,
            output: event.content,
            isError: event.isError ?? false,
            parentToolUseId: event.parentToolUseId ?? null,
          });
          break;
        }

        case "assistant_complete":
          // Subagent messages are surfaced only as tool activity, never as the
          // bot's own chat text.
          if (event.parentToolUseId) break;
          // Only send text if no deltas were streamed (avoids duplicating).
          // A retried/escalated attempt reuses this same onEvent closure, so
          // once one assistant_complete has contributed text, flip the same
          // gotDeltas guard the "delta" case uses — otherwise a second
          // attempt's assistant_complete (e.g. a repeated "Not logged in"
          // message) gets appended right after the first, with no separator.
          if (!gotDeltas) {
            for (const block of event.content) {
              if (block.type === "text" && block.text) {
                assistantText += block.text;
                io.to(sessionId).emit("message:stream:delta", {
                  sessionId,
                  messageId: assistantMsgId,
                  delta: block.text,
                });
              }
            }
            gotDeltas = true;
          }
          break;

        case "result": {
          // Drop any spawn_agent block that was never claimed by a shim call.
          subagentManager?.clearSpawnToolUses(sessionId);
          streamEnded = true;
          assistantCost = event.totalCostUsd;
          assistantDurationMs = event.durationMs;
          io.to(sessionId).emit("message:stream:end", {
            sessionId,
            messageId: assistantMsgId,
            cost: event.totalCostUsd,
            durationMs: event.durationMs,
          });

          // TC-2B: Log token usage metrics
          tokenLogger?.log({
            timestamp: new Date().toISOString(),
            sessionId,
            sessionTitle: meta.name,
            claudeSessionId: event.sessionId,
            messageId: assistantMsgId,
            source: "user",
            costUsd: event.totalCostUsd ?? 0,
            durationMs: event.durationMs ?? 0,
            durationApiMs: event.durationApiMs,
            numTurns: event.numTurns,
            inputTokens: event.usage?.input_tokens,
            outputTokens: event.usage?.output_tokens,
            cacheCreationTokens: event.usage?.cache_creation_input_tokens,
            cacheReadTokens: event.usage?.cache_read_input_tokens,
            success: event.success,
            provider: activeProviderId ?? undefined,
            model: currentModel || undefined,
          });
          break;
        }

        case "error": {
          const errMsg = event.message;
          if (isAuthError(errMsg)) authErrorSeen = true;
          // Escalation re-runs the same prompt on the next model tier, and
          // the engine has its own resume retries, so the identical error
          // text can arrive several times in a row. Only render it once.
          if (errorDeduper.shouldEmit(errMsg)) {
            io.to(sessionId).emit("message:error", {
              sessionId,
              messageId: assistantMsgId,
              error: errMsg,
            });
          }
          break;
        }
      }
    };

    // Build combined system prompt (custom instructions + skills + summary)
    const skillsPrompt =
      meta.skills && meta.skills.length > 0
        ? await skillCatalog.buildSkillsPrompt(meta.skills)
        : "";
    const summary = chatStore.loadSummary(sessionId);

    let sessionSection = assembleSystemPrompt(
      meta.systemPrompt || "",
      skillsPrompt,
      summary,
      ""
    );

    // TC-4: Compress the per-session section (instructions + skills + summary).
    // Uses moderate level: balances token savings with semantic preservation.
    // The orchestrator prompt itself is never compressed, since its wording is
    // the contract the engine is held to.
    sessionSection = compress(sessionSection, "moderate").compressed;

    // S8: the Medusa layer. One prompt for every engine, with the session's own
    // instructions appended under "## Project notes" rather than substituted.
    const finalSystemPrompt = buildOrchestratorPrompt({
      engineId: meta.engineId,
      sessionSystemPrompt: sessionSection,
      workingDir: meta.workingDir,
    });

    // S1 2d: hand this chat's Medusa MCP server to every engine spawn. Returns
    // null when no AUTH_TOKEN is configured (an unauthenticated shim would let
    // any local process drive subagents) or when the shim itself can't
    // actually be launched (e.g. a desktop sidecar build with no bundled
    // shim binary) -- the latter case also surfaces one "warning" Activity
    // Log line explaining why subagents are off for this session.
    const mcpConfig =
      descriptorForSession(sessionId, {}, (message) => {
        io.to(sessionId).emit("activity:event", {
          sessionId,
          ts: new Date().toISOString(),
          kind: "warning",
          summary: message,
        });
      }) ?? undefined;

    try {
      // S2: per-session engine/provider resolution belongs here; see
      // server/src/sessions/HANDLER_PATCH.md.
      // Anthropic-compatible custom providers (OpenRouter, etc.) use full model
      // ids (e.g. "openai/gpt-5.1"), not the haiku/sonnet/opus tiers the model
      // router classifies native Claude prompts into, so routing/escalation is
      // skipped entirely for them and the session's chosen model (or that
      // provider's default) is used as-is.
      const usingAnthropicCompatible = isAnthropicCompatibleProvider(activeProviderId);

      // Select model based on routing config (per-session model override takes priority)
      const routingEnabled = config.modelRoutingEnabled !== false;
      let selectedModel: ModelTier = usingAnthropicCompatible
        ? ((meta?.model as ModelTier | undefined) ?? (getDefaultModel(activeProviderId as string) as ModelTier | undefined) ?? ("sonnet" as ModelTier))
        : routingEnabled
        ? selectModel({ prompt: text, source: "user", modelOverride: meta?.model })
        : (meta?.model as ModelTier | undefined) ?? "sonnet";
      currentModel = selectedModel;

      // Send message with tier escalation on failure
      let exitCode: number | null = await processManager.sendMessage(
        sessionId,
        text,
        sanitizeImagePaths(images),
        onEvent,
        meta.yoloMode === true,
        finalSystemPrompt || undefined,
        selectedModel,
        sanitizedFiles,
        { engineId: meta.engineId, providerId: meta.providerId },
        mcpConfig
      );

      // Escalate to next tier if this tier failed with no output. Not applicable
      // to Anthropic-compatible providers, whose "model" isn't a tier, and not
      // applicable to an auth error, since no model tier can fix "not logged in".
      if (!usingAnthropicCompatible && !authErrorSeen && exitCode !== 0 && !gotDeltas && NEXT_TIER[selectedModel]) {
        const nextTier = NEXT_TIER[selectedModel];
        if (nextTier) {
          console.log(
            `[handler] Model ${selectedModel} failed (exit ${exitCode}), escalating to ${nextTier}`
          );
          selectedModel = nextTier;
          currentModel = selectedModel;
          exitCode = await processManager.sendMessage(
            sessionId,
            text,
            sanitizeImagePaths(images),
            onEvent,
            meta.yoloMode === true,
            finalSystemPrompt || undefined,
            nextTier,
            sanitizedFiles,
            { engineId: meta.engineId, providerId: meta.providerId },
            mcpConfig
          );
        }
      }

      // Escalate to opus as final fallback if sonnet also failed
      if (!authErrorSeen && exitCode !== 0 && !gotDeltas && selectedModel === "sonnet") {
        console.log(
          `[handler] Model sonnet failed (exit ${exitCode}), escalating to opus (final)`
        );
        currentModel = "opus";
        exitCode = await processManager.sendMessage(
          sessionId,
          text,
          sanitizeImagePaths(images),
          onEvent,
          meta.yoloMode === true,
          finalSystemPrompt || undefined,
          "opus",
          sanitizedFiles,
          { engineId: meta.engineId, providerId: meta.providerId },
          mcpConfig
        );
      }

      // Every tier that was tried (or the single attempt, if an auth error
      // stopped escalation early) has now failed with no output. Rather than
      // leaving the last per-tier error as the final word, finish with one
      // clear summary line that tells the user exactly what to run.
      if (!usingAnthropicCompatible && exitCode !== 0 && !gotDeltas) {
        const lastError = errorDeduper.getLast() ?? "Unknown error";
        const summary = buildAllTiersFailedMessage(lastError, getActiveConfigDir());
        io.to(sessionId).emit("message:error", {
          sessionId,
          messageId: assistantMsgId,
          error: summary,
        });
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      io.to(sessionId).emit("message:error", {
        sessionId,
        messageId: assistantMsgId,
        error: message,
      });
    }

    // Always finalize the stream if the parser didn't emit a result event
    if (!streamEnded) {
      io.to(sessionId).emit("message:stream:end", {
        sessionId,
        messageId: assistantMsgId,
      });
    }

    // Persist the completed assistant message
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

    // Check if conversation needs summarization
    if (config.summarizationEnabled && !summarizingSessionIds.has(sessionId)) {
      const allMessages = chatStore.loadMessages(sessionId);
      const estimatedMsgTokens = allMessages.reduce(
        (sum, m) => sum + estimateTokens(m.text),
        0
      );
      const tokenThreshold = 120_000; // ~half of 256K context window
      if (
        allMessages.length >= config.summarizationThreshold ||
        estimatedMsgTokens >= tokenThreshold
      ) {
        console.log(
          `[summarization] Session ${sessionId} has ${allMessages.length} messages ` +
          `(~${estimatedMsgTokens} est. tokens), triggering summarization`
        );
        // Mark in-flight to prevent concurrent re-triggers
        summarizingSessionIds.add(sessionId);
        // Async summarization — don't block the response
        summarizeConversation(allMessages, {
          sessionId,
          botName: meta.name,
          tokenLogger,
        })
          .then((result) => {
            // Save summary
            chatStore.saveSummary(sessionId, result.summary);
            // Keep only the most recent N messages (e.g., last 5)
            const keepCount = 5;
            const trimmed = allMessages.slice(-keepCount);
            chatStore.deleteSession(sessionId);
            for (const msg of trimmed) {
              chatStore.appendMessage(msg);
            }
            console.log(
              `[summarization] Session ${sessionId} summarized and trimmed to ${trimmed.length} messages`
            );
            // Reset the session to start fresh on next message
            processManager.createSession(sessionId, meta.workingDir, true, {
              engineId: meta.engineId,
              providerId: meta.providerId,
            });
          })
          .catch((err) => {
            console.error(
              `[summarization] Failed for session ${sessionId}:`,
              err
            );
          })
          .finally(() => {
            summarizingSessionIds.delete(sessionId);
          });
      }
    }

    // Drain any message that was queued while this session was busy.
    drainSendQueue(sessionId);
  }

  // ---- Connection handler ----
  io.on("connection", (socket: Socket) => {
    console.log(`[socket] connected: ${socket.id}`);

    // -- Join a session room --
    // P2-7: Verify the session exists before allowing join.
    // Prevents a socket from subscribing to arbitrary room IDs.
    socket.on("session:join", ({ sessionId }: { sessionId: string }) => {
      if (!store.get(sessionId)) {
        socket.emit("error", { message: "Session not found" });
        return;
      }
      socket.join(sessionId);
      socket.emit("session:joined", { sessionId });
    });

    // -- Leave a session room --
    socket.on("session:leave", ({ sessionId }: { sessionId: string }) => {
      socket.leave(sessionId);
    });

    // -- Cowork live browser view: start/stop the CDP screencast --
    socket.on("cowork:start", () => {
      void startScreencast(io);
    });
    socket.on("cowork:stop", () => {
      stopScreencast();
    });
    socket.on("cowork:input", (input: CoworkInput) => {
      sendCoworkInput(input);
    });

    // -- Simulator live view: start/stop/input for the booted iOS Simulator --
    socket.on("simulator:start", () => {
      void startSimulatorStream(io);
    });
    socket.on("simulator:stop", () => {
      stopSimulatorStream();
    });
    socket.on("simulator:input", (input: SimulatorInput) => {
      sendSimulatorInput(input);
    });

    // -- Send a message --
    socket.on(
      "message:send",
      async ({
        sessionId,
        text,
        images,
        files,
      }: {
        sessionId: string;
        text: string;
        images?: string[];
        files?: string[];
      }) => {
        const meta = store.get(sessionId);
        if (!meta) {
          socket.emit("error", { message: "Session not found" });
          return;
        }

        // Ensure the socket is in the room so it receives streamed events
        socket.join(sessionId);

        // Lazily create the process-manager entry if it was lost on restart
        try {
          processManager.createSession(sessionId, meta.workingDir, undefined, {
            engineId: meta.engineId,
            providerId: meta.providerId,
          });
        } catch {
          // Already exists -- that is fine
        }

        // Guard: if the session is already processing, queue the message rather
        // than dropping it. drainSendQueue() runs it as soon as the current turn
        // finishes, so the user's message is delivered rather than lost.
        if (processManager.isSessionBusy(sessionId)) {
          queueDirectMessage(sessionId, () => {
            void handleMessageSend(sessionId, text, images, files);
          });
          socket.emit("message:queued", { sessionId });
          return;
        }

        await handleMessageSend(sessionId, text, images, files);
      }
    );

    // -- Toggle YOLO mode (skip permissions) for a session --
    socket.on(
      "session:toggle-yolo",
      ({ sessionId }: { sessionId: string }) => {
        const updated = store.toggleYolo(sessionId);
        if (updated) {
          io.to(sessionId).emit("session:yolo-changed", {
            sessionId,
            yoloMode: updated.yoloMode ?? false,
          });
        }
      }
    );

    // -- Update system prompt for a session --
    // ACK callback fires once the update is persisted to sessions.json.
    // Client waits for all ACKs before closing the editor modal.
    socket.on(
      "session:update-system-prompt",
      (
        { sessionId, systemPrompt }: { sessionId: string; systemPrompt: string },
        ack?: (result: { ok: boolean }) => void
      ) => {
        const updated = store.updateSystemPrompt(sessionId, systemPrompt);
        if (updated) {
          io.to(sessionId).emit("session:system-prompt-changed", {
            sessionId,
            systemPrompt: updated.systemPrompt ?? "",
          });
          ack?.({ ok: true });
        } else {
          ack?.({ ok: false });
        }
      }
    );

    // -- Update skills for a session --
    socket.on(
      "session:update-skills",
      (
        { sessionId, skills }: { sessionId: string; skills: string[] },
        ack?: (result: { ok: boolean }) => void
      ) => {
        const updated = store.updateSkills(sessionId, skills);
        if (updated) {
          io.to(sessionId).emit("session:skills-changed", {
            sessionId,
            skills: updated.skills ?? [],
          });
          ack?.({ ok: true });
        } else {
          ack?.({ ok: false });
        }
      }
    );

    // -- Set YOLO mode explicitly for a session --
    socket.on(
      "session:set-yolo",
      (
        { sessionId, yoloMode }: { sessionId: string; yoloMode: boolean },
        ack?: (result: { ok: boolean }) => void
      ) => {
        const updated = store.setYolo(sessionId, yoloMode);
        if (updated) {
          io.to(sessionId).emit("session:yolo-changed", {
            sessionId,
            yoloMode: updated.yoloMode ?? false,
          });
          ack?.({ ok: true });
        } else {
          ack?.({ ok: false });
        }
      }
    );

    // -- Update working directory for a session --
    socket.on(
      "session:update-working-dir",
      (
        { sessionId, workingDir }: { sessionId: string; workingDir: string },
        ack?: (result: { ok: boolean }) => void
      ) => {
        const updated = store.updateWorkingDir(sessionId, workingDir);
        if (updated) {
          io.to(sessionId).emit("session:working-dir-changed", {
            sessionId,
            workingDir: updated.workingDir,
          });
          ack?.({ ok: true });
        } else {
          ack?.({ ok: false });
        }
      }
    );

    // -- Stop one subagent from its card's Stop button --
    socket.on(
      "subagent:cancel",
      ({ sessionId, agentId }: { sessionId: string; agentId: string }) => {
        if (!subagentManager || !sessionId || !agentId) return;
        // Scoped by parent session on purpose: a socket may only cancel a
        // subagent belonging to the chat it names, never another chat's.
        const record = subagentManager.getForParent(agentId, sessionId);
        if (!record) return;
        subagentManager.cancel(agentId);
      }
    );

    // -- Abort a running message (kills the process; close handler finalizes) --
    socket.on("message:abort", ({ sessionId }: { sessionId: string }) => {
      const wasBusy = processManager.isSessionBusy(sessionId);
      processManager.abort(sessionId);
      // A subagent must never outlive its parent turn (spec A.8).
      subagentManager?.cancelForParent(sessionId);
      // If the process wasn't running (e.g. server restarted and lost it),
      // force the client out of the stuck 'busy' state.
      if (!wasBusy) {
        io.to(sessionId).emit("message:stream:end", {
          sessionId,
          messageId: "abort",
        });
      }
    });

    registerVoiceHandlers(io, socket, { store, processManager, sendMessage: handleMessageSend });

    socket.on("disconnect", () => {
      console.log(`[socket] disconnected: ${socket.id}`);
    });
  });
}
