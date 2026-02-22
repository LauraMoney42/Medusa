import { Server as IOServer } from "socket.io";
import type { Socket } from "socket.io";
import { timingSafeEqual, createHash } from "crypto";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import config from "../config.js";

// P2-9: Validate that every image path is within the uploads directory.
// Accepts URL paths (/uploads/filename) and converts them to filesystem paths
// before validation. path.basename() strips any traversal attempts before join.
// Rejects anything that resolves outside uploadsDir. Filters silently.
function sanitizeImagePaths(images: string[] | undefined): string[] {
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
import { HubStore } from "../hub/store.js";
import { MentionRouter } from "../hub/mention-router.js";
import type { ParsedEvent } from "../claude/types.js";
import { selectModel, NEXT_TIER, type ModelTier } from "../claude/model-router.js";
import { summarizeConversation } from "../chat/conversation-summarizer.js";
import { processHubPosts } from "../hub/post-processor.js";

// ---- Hub Post Detection ----

interface DetectorResult {
  cleanDelta: string;
  hubPosts: string[];
  /** Raw inner content of [BOT-TASK: ...] tokens, e.g. "@Backend Dev check the API" */
  botTasks: string[];
}

const HUB_PREFIX = "[HUB-POST: ";
const HUB_PREFIX_LOWER = "[hub-post: ";
const BOT_TASK_PREFIX = "[BOT-TASK: ";
const BOT_TASK_PREFIX_LOWER = "[bot-task: ";

/**
 * Buffers streaming deltas and detects `[HUB-POST: ...]` and `[BOT-TASK: ...]` patterns.
 * Both token types are stripped from the clean output and returned for routing.
 * Handles: splits across deltas, nested brackets, multiple tokens per response.
 */
export class HubPostDetector {
  private buffer = "";

  /**
   * Feed a delta chunk. Returns clean text (with hub posts and bot tasks stripped)
   * and any fully extracted hub posts / bot tasks.
   */
  feed(delta: string): DetectorResult {
    this.buffer += delta;
    return this.extract();
  }

  /** Flush remaining buffer as clean output (called on stream end). */
  flush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    return remaining;
  }

  private extract(): DetectorResult {
    const hubPosts: string[] = [];
    const botTasks: string[] = [];
    let cleanDelta = "";

    while (this.buffer.length > 0) {
      const lowerBuf = this.buffer.toLowerCase();

      // Find whichever token prefix appears first in the buffer
      const hubIdx = lowerBuf.indexOf(HUB_PREFIX_LOWER);
      const botIdx = lowerBuf.indexOf(BOT_TASK_PREFIX_LOWER);

      let startIdx: number;
      let prefixLen: number;
      let isBot: boolean;

      if (hubIdx === -1 && botIdx === -1) {
        // No token start found — check for a partial prefix at the end of the buffer
        const partialLen = this.findPartialPrefix(lowerBuf);
        if (partialLen > 0) {
          cleanDelta += this.buffer.slice(0, this.buffer.length - partialLen);
          this.buffer = this.buffer.slice(this.buffer.length - partialLen);
          break;
        }
        cleanDelta += this.buffer;
        this.buffer = "";
        break;
      } else if (botIdx !== -1 && (hubIdx === -1 || botIdx < hubIdx)) {
        startIdx = botIdx;
        prefixLen = BOT_TASK_PREFIX.length;
        isBot = true;
      } else {
        startIdx = hubIdx;
        prefixLen = HUB_PREFIX.length;
        isBot = false;
      }

      // Emit text before the token marker
      cleanDelta += this.buffer.slice(0, startIdx);

      // Scan forward to find the matching closing bracket (depth-tracks nested brackets)
      const contentStart = startIdx + prefixLen;
      let depth = 1;
      let i = contentStart;
      let found = false;

      while (i < this.buffer.length) {
        if (this.buffer[i] === "[") {
          depth++;
        } else if (this.buffer[i] === "]") {
          depth--;
          if (depth === 0) {
            const content = this.buffer.slice(contentStart, i).trim();
            if (content) {
              if (isBot) botTasks.push(content);
              else hubPosts.push(content);
            }
            this.buffer = this.buffer.slice(i + 1);
            found = true;
            break;
          }
        }
        i++;
      }

      if (!found) {
        // Token is incomplete — keep buffering until more deltas arrive
        break;
      }
    }

    return { cleanDelta, hubPosts, botTasks };
  }

  /**
   * Check if the tail of the buffer could be the start of either prefix.
   * Returns the longest partial match length found, or 0 if none.
   * Used to hold back text that might be the beginning of a token.
   */
  private findPartialPrefix(lowerBuf: string): number {
    const prefixes = [HUB_PREFIX_LOWER, BOT_TASK_PREFIX_LOWER];
    let maxLen = 0;
    for (const prefix of prefixes) {
      for (let len = Math.min(lowerBuf.length, prefix.length - 1); len >= 1; len--) {
        if (lowerBuf.slice(-len) === prefix.slice(0, len)) {
          maxLen = Math.max(maxLen, len);
          break;
        }
      }
    }
    return maxLen;
  }
}

// ---- Task-Done Detection ----

/**
 * Extract [TASK-DONE: description] from hub message text.
 * Returns the description string or null if not found.
 */
export function extractTaskDone(text: string): string | null {
  const match = text.match(/\[TASK-DONE:\s*(.*?)\]/i);
  return match ? match[1].trim() : null;
}

// ---- Hub System Prompt Builder ----

export function buildHubPromptSection(
  hubStore: HubStore,
  sessionStore: SessionStore,
  forSessionId?: string,
  forSessionName?: string,
  compactMode = false
): string {
  // Compact mode: fewer messages to reduce input tokens
  const messageLimit = compactMode ? 5 : 20;
  // If session context provided, filter to only relevant messages
  const recentMessages = forSessionId && forSessionName
    ? hubStore.getRecentForSession(messageLimit, forSessionId, forSessionName)
    : hubStore.getRecent(messageLimit);
  const allSessions = sessionStore.loadAll();
  const botNames = allSessions.map((s) => s.name).join(", ");

  // Compact mode: minimal instructions for poll checks and routine ops
  if (compactMode) {
    let section = `\n\n--- HUB ---
You are in COMPACT MODE. Respond in under 100 tokens unless the task requires more.
Skip preamble, context-setting, and sign-offs. Do not restate the question or assignment.
If no action needed: [NO-ACTION]. If action needed: do it immediately.
Post via [HUB-POST: ...]. Task completions: [TASK-DONE: description].
Escalate: [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: <what>]
For internal bot-to-bot coordination only, use [BOT-TASK: @BotName message] — NOT [HUB-POST: ...]. Routes directly, invisible to user.
Active bots: ${botNames || "none"}`;

    if (recentMessages.length > 0) {
      section += "\n";
      for (const msg of recentMessages) {
        section += `\n[${msg.from} @ ${msg.timestamp}]: ${msg.text}`;
      }
    }
    section += "\n--- END HUB ---";
    return section;
  }

  let section = `\n\n--- HUB (shared awareness feed) ---
The Hub is a shared message board where all bots can see each other's posts.
To post a new message to the Hub, include [HUB-POST: your message here] anywhere in your response.
To tag another bot for help, include their name with @: [HUB-POST: @BotName your question].
Only use [HUB-POST: ...] when you genuinely need to communicate — examples: flagging uncertainty, asking for help, reporting task completion, handing off work, or coordinating with teammates.
When you complete an assigned task, include [TASK-DONE: brief description] inside your hub post.
Always post to the Hub when you finish assigned work or need input from the team.
If you have assigned tasks, report your progress. If you're stuck or blocked, say so.

IMPORTANT — Auto-continuation:
- When you finish a task, check the Hub for your next assignment. If you have one, start it immediately. Do NOT wait for the user to tell you to begin.
- If you are idle and see assigned work for you in the Hub, pick it up and start working.
- Only stop and wait if you have NO assigned tasks remaining.

IMPORTANT — Escalation:
- If you need human approval, a decision, or are blocked on something only the user can resolve, post to the Hub with this exact format:
  [HUB-POST: @You 🚨🚨🚨 APPROVAL NEEDED: <description of what you need>]
- Do NOT silently wait. Always escalate visibly.

IMPORTANT — Token Efficiency:
- When posting to the Hub, keep it under 50 tokens. No pleasantries, no restating what was already said.
- Status updates: state only what changed and what's next. Skip context the reader already has.
- Acknowledgments: "Acknowledged" or "Confirmed" is sufficient. Do not restate the assignment.
- [NO-ACTION] responses: respond with exactly "[NO-ACTION]" — no explanation needed.
- Never open with "Great question!", "Absolutely!", "Thanks for the update!" or similar filler.
- Bot-to-bot communication is signal, not conversation. Be terse.

IMPORTANT — Bot-to-Bot Coordination:
- Use [BOT-TASK: @BotName message] for internal coordination: task handoffs, delegation, status between bots. Routes directly. NOT visible in Hub.
- Use [HUB-POST: ...] ONLY when the user needs to see it (assignments, completions, escalations).
- Rule: if a human doesn't need to read it → [BOT-TASK:]. If they do → [HUB-POST:].
- Chain depth limit enforced server-side (max 3).

Active bots: ${botNames || "none"}`;

  if (recentMessages.length > 0) {
    section += "\n";
    for (const msg of recentMessages) {
      section += `\n[${msg.from} @ ${msg.timestamp}]: ${msg.text}`;
    }
  }

  section += "\n--- END HUB ---";
  return section;
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
  hubStore: HubStore,
  mentionRouter: MentionRouter
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

    // -- Send a message --
    socket.on(
      "message:send",
      async ({
        sessionId,
        text,
        images,
      }: {
        sessionId: string;
        text: string;
        images?: string[];
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
          processManager.createSession(sessionId, meta.workingDir);
        } catch {
          // Already exists -- that is fine
        }

        const now = new Date().toISOString();
        const userMsgId = uuidv4();
        const assistantMsgId = uuidv4();

        // Echo the user message with the shape the client expects (ChatMessage)
        const userMsg = {
          id: userMsgId,
          sessionId,
          role: "user" as const,
          text,
          images,
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

        // Notify busy status
        io.to(sessionId).emit("session:status", {
          sessionId,
          status: "busy",
        });

        store.updateLastActive(sessionId);

        // Track whether stream:end was sent so we can finalize on abort/crash
        let streamEnded = false;
        // Track whether any deltas were emitted (to avoid duplicating text
        // from the assistant_complete event which always contains the full text)
        let gotDeltas = false;

        // Accumulate assistant response for persistence
        let assistantText = "";
        const assistantTools: { name: string; input?: unknown; output?: string }[] = [];
        let assistantCost: number | undefined;
        let assistantDurationMs: number | undefined;

        // Hub post detector for this stream
        const hubDetector = new HubPostDetector();

        // Helper: process extracted hub posts via shared post-processor
        const handleHubPosts = (posts: string[]) =>
          processHubPosts(posts, { from: meta.name, sessionId, hubStore, mentionRouter, io });

        // Helper: route [BOT-TASK: ...] tokens directly to target bots (no Hub write)
        const handleBotTasks = (tasks: string[]) => {
          if (tasks.length > 0) {
            mentionRouter.processBotTaskContent(tasks, sessionId, meta.name, 0);
          }
        };

        // Stream callback — translate ParsedEvents into client-expected shapes
        const onEvent = (event: ParsedEvent) => {
          switch (event.kind) {
            case "init":
              console.log(
                `[stream] session=${sessionId} model=${event.model}`
              );
              break;

            case "delta": {
              gotDeltas = true;

              // Run through hub post detector — strips [HUB-POST: ...] and [BOT-TASK: ...] markers
              const { cleanDelta, hubPosts, botTasks } = hubDetector.feed(event.text);

              if (cleanDelta) {
                assistantText += cleanDelta;
                io.to(sessionId).emit("message:stream:delta", {
                  sessionId,
                  messageId: assistantMsgId,
                  delta: cleanDelta,
                });
              }

              handleHubPosts(hubPosts);
              handleBotTasks(botTasks);
              break;
            }

            case "tool_use_start":
              assistantTools.push({ name: event.toolName, input: event.input });
              io.to(sessionId).emit("message:stream:tool", {
                sessionId,
                messageId: assistantMsgId,
                tool: {
                  name: event.toolName,
                  input: event.input,
                },
              });
              break;

            case "tool_result": {
              const lastTool = assistantTools[assistantTools.length - 1];
              if (lastTool) {
                lastTool.output = event.content;
              }
              io.to(sessionId).emit("message:stream:tool_result", {
                sessionId,
                messageId: assistantMsgId,
                toolName: event.toolUseId,
                output: event.content,
              });
              break;
            }

            case "assistant_complete":
              // Only send text if no deltas were streamed (avoids duplicating)
              if (!gotDeltas) {
                for (const block of event.content) {
                  if (block.type === "text" && block.text) {
                    const { cleanDelta, hubPosts, botTasks } = hubDetector.feed(block.text);
                    if (cleanDelta) {
                      assistantText += cleanDelta;
                      io.to(sessionId).emit("message:stream:delta", {
                        sessionId,
                        messageId: assistantMsgId,
                        delta: cleanDelta,
                      });
                    }
                    handleHubPosts(hubPosts);
                    handleBotTasks(botTasks);
                  }
                }
              }
              break;

            case "result": {
              // Flush any remaining buffered text from the hub detector
              const remaining = hubDetector.flush();
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

        // Build combined system prompt (custom instructions + skills + summary + hub context)
        let finalSystemPrompt = meta.systemPrompt || "";
        if (meta.skills && meta.skills.length > 0) {
          const skillsPrompt = await skillCatalog.buildSkillsPrompt(meta.skills);
          finalSystemPrompt = (finalSystemPrompt + skillsPrompt).trim();
        }
        // Inject conversation summary if available
        const summary = chatStore.loadSummary(sessionId);
        if (summary) {
          finalSystemPrompt += `\n\n--- CONVERSATION SUMMARY (previous context) ---\n${summary}\n--- END SUMMARY ---`;
        }
        // Inject hub context filtered to this bot's relevant messages
        finalSystemPrompt += buildHubPromptSection(hubStore, store, sessionId, meta.name);
        finalSystemPrompt = finalSystemPrompt.trim();

        try {
          // Select model based on routing config
          const routingEnabled = config.modelRoutingEnabled !== false;
          let selectedModel: ModelTier = routingEnabled
            ? selectModel({ prompt: text, source: "user" })
            : "sonnet";

          // Send message with tier escalation on failure
          let exitCode: number | null = await processManager.sendMessage(
            sessionId,
            text,
            sanitizeImagePaths(images),
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
                `[handler] Model ${selectedModel} failed (exit ${exitCode}), escalating to ${nextTier}`
              );
              selectedModel = nextTier;
              exitCode = await processManager.sendMessage(
                sessionId,
                text,
                sanitizeImagePaths(images),
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
              `[handler] Model sonnet failed (exit ${exitCode}), escalating to opus (final)`
            );
            exitCode = await processManager.sendMessage(
              sessionId,
              text,
              sanitizeImagePaths(images),
              onEvent,
              meta.yoloMode === true,
              finalSystemPrompt || undefined,
              "opus"
            );
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
          const remaining = hubDetector.flush();
          if (remaining) {
            assistantText += remaining;
          }

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
        if (config.summarizationEnabled) {
          const allMessages = chatStore.loadMessages(sessionId);
          if (allMessages.length >= config.summarizationThreshold) {
            console.log(
              `[summarization] Session ${sessionId} has ${allMessages.length} messages, triggering summarization`
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
                  `[summarization] Session ${sessionId} summarized and trimmed to ${trimmed.length} messages`
                );
                // Reset the session to start fresh on next message
                processManager.createSession(sessionId, meta.workingDir, true);
              })
              .catch((err) => {
                console.error(
                  `[summarization] Failed for session ${sessionId}:`,
                  err
                );
              });
          }
        }

        // Notify idle status
        io.to(sessionId).emit("session:status", {
          sessionId,
          status: "idle",
        });

        // Deliver any pending @mentions now that this session is idle
        mentionRouter.onSessionIdle(sessionId);
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
    socket.on(
      "session:update-system-prompt",
      ({ sessionId, systemPrompt }: { sessionId: string; systemPrompt: string }) => {
        const updated = store.updateSystemPrompt(sessionId, systemPrompt);
        if (updated) {
          io.to(sessionId).emit("session:system-prompt-changed", {
            sessionId,
            systemPrompt: updated.systemPrompt ?? "",
          });
        }
      }
    );

    // -- Update skills for a session --
    socket.on(
      "session:update-skills",
      ({ sessionId, skills }: { sessionId: string; skills: string[] }) => {
        const updated = store.updateSkills(sessionId, skills);
        if (updated) {
          io.to(sessionId).emit("session:skills-changed", {
            sessionId,
            skills: updated.skills ?? [],
          });
        }
      }
    );

    // -- Set YOLO mode explicitly for a session --
    socket.on(
      "session:set-yolo",
      ({ sessionId, yoloMode }: { sessionId: string; yoloMode: boolean }) => {
        const updated = store.setYolo(sessionId, yoloMode);
        if (updated) {
          io.to(sessionId).emit("session:yolo-changed", {
            sessionId,
            yoloMode: updated.yoloMode ?? false,
          });
        }
      }
    );

    // -- Update working directory for a session --
    socket.on(
      "session:update-working-dir",
      ({ sessionId, workingDir }: { sessionId: string; workingDir: string }) => {
        const updated = store.updateWorkingDir(sessionId, workingDir);
        if (updated) {
          io.to(sessionId).emit("session:working-dir-changed", {
            sessionId,
            workingDir: updated.workingDir,
          });
        }
      }
    );

    // -- User posts to the hub --
    socket.on(
      "hub:post",
      ({ sessionId, text, from, images }: { sessionId?: string; text: string; from?: string; images?: string[] }) => {
        console.log(`[hub] post received: sessionId=${sessionId ?? "none"} text="${text.slice(0, 80)}"`);

        // sessionId is optional — user posts from the Hub input may not have an active session.
        const meta = sessionId ? store.get(sessionId) : null;
        const resolvedFrom = from || meta?.name || "You";
        const resolvedSessionId = sessionId || "user";

        const hubMsg = hubStore.add({
          from: resolvedFrom,
          text,
          sessionId: resolvedSessionId,
          ...(images && images.length > 0 ? { images } : {}),
        });

        // Broadcast to all connected clients
        console.log(`[hub] broadcasting message: id=${hubMsg.id} from=${hubMsg.from}`);
        io.emit("hub:message", hubMsg);

        // Route any @mentions
        mentionRouter.processMessage(hubMsg);
      }
    );

    // -- Abort a running message (kills the process; close handler finalizes) --
    socket.on("message:abort", ({ sessionId }: { sessionId: string }) => {
      const wasBusy = processManager.isSessionBusy(sessionId);
      processManager.abort(sessionId);
      // If the process wasn't running (e.g. server restarted and lost it),
      // force the client out of the stuck 'busy' state.
      if (!wasBusy) {
        io.to(sessionId).emit("message:stream:end", {
          sessionId,
          messageId: "abort",
        });
      }
    });

    socket.on("disconnect", () => {
      console.log(`[socket] disconnected: ${socket.id}`);
    });
  });
}
