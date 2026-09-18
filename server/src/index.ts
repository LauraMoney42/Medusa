import fs from "fs";
import http from "http";
import { createHash, timingSafeEqual } from "crypto";
import { execFileSync } from "child_process";
import path from "path";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { Server as IOServer } from "socket.io";

import config from "./config.js";
import { authMiddleware } from "./auth.js";
import { createHealthRouter } from "./routes/health.js";
import { createAuthRouter } from "./routes/auth.js";
import { createSessionsRouter } from "./routes/sessions.js";
import imagesRouter from "./routes/images.js";
import filesRouter from "./routes/files.js";
import sttRouter from "./routes/stt.js";
import ttsRouter from "./routes/tts.js";
import { createSkillsRouter } from "./routes/skills.js";
import { setupSocketHandler } from "./socket/handler.js";
import { ProcessManager } from "./claude/process-manager.js";
import { SessionStore } from "./sessions/store.js";
import { SkillCatalog } from "./skills/catalog.js";
import { ChatStore } from "./chat/store.js";
import { createChatRouter } from "./routes/chat.js";
import { ProjectStore } from "./projects/store.js";
import { createProjectsRouter } from "./routes/projects.js";
import { QuickTaskStore } from "./projects/quick-task-store.js";
import { createQuickTasksRouter } from "./routes/quick-tasks.js";
import { createCaffeineRouter, shutdownCaffeine } from "./routes/caffeine.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createProvidersRouter } from "./routes/providers.js";
import { createTicTalkRouter } from "./routes/tictalk.js";
import { paginateDevlogs } from "./utils/devlog-paginator.js";
import { TokenLogger } from "./metrics/token-logger.js";
import { refreshOpenRouterPricing } from "./metrics/pricing.js";
import { createMetricsRouter } from "./routes/metrics.js";
import { createOneNoteRouter } from "./routes/onenote.js";
import { startHeadroomProxy, stopHeadroomProxy } from "./headroom/proxy-manager.js";
import { startWhisperServer, stopWhisperServer } from "./stt/whisper-manager.js";
import { startTtsServer, stopTtsServer } from "./tts/tts-manager.js";
import { stopScreencast } from "./cowork/screencast.js";
import { stopSimulatorStream } from "./cowork/simulator-stream.js";
import { RunnerManager } from "./runner/runner-manager.js";
import { createRunnersRouter } from "./routes/runners.js";
import { createHeadroomRouter } from "./routes/headroom.js";
import { SubagentManager } from "./subagents/manager.js";
import { createSubagentsRouter } from "./routes/subagents.js";
import { getActiveProvider } from "./settings/store.js";
import { z } from "zod";

// ---- Instantiate shared services ----
const processManager = new ProcessManager();
const sessionStore = new SessionStore();
const skillCatalog = new SkillCatalog(config.skillsCacheDir);
skillCatalog.initialize().catch(console.error);
const chatStore = new ChatStore(path.dirname(config.sessionsFile));
const projectStore = new ProjectStore(config.projectsFile);
const quickTaskStore = new QuickTaskStore(config.quickTasksFile);
const tokenLogger = new TokenLogger(config.tokenUsageLogFile);
// Best-effort, non-blocking: populates the OpenRouter per-token pricing cache
// used to recompute cost for OpenRouter-routed entries (A.8). A failed fetch
// just leaves those entries flagged priceKnown: false, never blocks startup.
refreshOpenRouterPricing().catch(() => {});

// Pre-load existing sessions into the process manager so that
// resumed conversations work after a server restart.
// isFirstMessage=false uses --resume. If the Claude CLI session doesn't exist,
// the "No conversation found" fallback in process-manager retries with --session-id.
const allSessions = sessionStore.loadAll();
for (const meta of allSessions) {
  processManager.createSession(meta.id, meta.workingDir, false, {
    engineId: meta.engineId,
    providerId: meta.providerId,
  });
}

// Paginate devlog.md files in all session working directories on startup.
// Moves entries older than 48h to devlog_archive.md to reduce bot context size.
const workingDirs = [...new Set(allSessions.map((s) => s.workingDir))];
paginateDevlogs(workingDirs);

// ---- Express app ----
const app = express();

app.use(
  cors({
    origin: config.allowedOrigins,
    credentials: true,
  })
);
// P2-3: Explicit body size limit. Express default is 100KB (undocumented); 1MB covers
// all legitimate use cases while preventing memory exhaustion from oversized payloads.
app.use(express.json({ limit: "1mb" }));
app.use(authMiddleware);

// ---- HTTP + Socket.IO (created early so io is available for MentionRouter) ----
const server = http.createServer(app);

const io = new IOServer(server, {
  cors: {
    origin: config.allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10 MB
  // Detect dead connections faster so stale sockets don't accumulate
  // after laptop sleep / network drops.
  pingInterval: 15000,
  pingTimeout: 8000,
} as any);

// ---- Multi-machine runner protocol ("one brain, many hands") ----
// A runner daemon (server/src/runner/runner-client.ts) on each machine dials
// OUT to this namespace — the brain never dials in. Gated by the same
// AUTH_TOKEN as the rest of the app (see runner-manager.ts for the security
// model: exec runs an arbitrary shell command on the connected machine).
const runnerManager = new RunnerManager();
// io.of()'s types don't resolve cleanly under this project's TS config (see
// runner-manager.ts's comment on the same pre-existing socket.io typing quirk).
const runnerNamespace = (io as any).of("/runner");
runnerNamespace.use((socket: any, next: (err?: Error) => void) => {
  if (!config.authToken) return next();
  const token = socket.handshake.auth?.token as string | undefined;
  // Constant-time compare (via SHA-256 digests, same technique as the main
  // socket namespace's auth) to avoid a timing side-channel on the token.
  const hashA = createHash("sha256").update(token ?? "").digest();
  const hashB = createHash("sha256").update(config.authToken).digest();
  if (token && timingSafeEqual(hashA, hashB)) {
    return next();
  }
  next(new Error("Unauthorized"));
});
runnerManager.attach(runnerNamespace);

// ---- Subagents ----
// One chat = one folder + one engine + one model (spec B.1), so a subagent
// inherits the parent chat's engine/provider unless the spawn call overrides it.
// Resolution mirrors ProcessManager.resolveEngine: session engine, then session
// provider, then the global setting.
const subagentManager = new SubagentManager({
  getParent: (sessionId) => {
    const session = sessionStore.get(sessionId);
    if (!session) return null;
    return {
      workingDir: session.workingDir,
      engineId: session.engineId ?? session.providerId ?? getActiveProvider() ?? "claude",
      model: session.model ?? null,
      yoloMode: session.yoloMode ?? false,
    };
  },
  emit: (sessionId, event, payload) => io.to(sessionId).emit(event, payload),
  // A.8 cost attribution: one TokenUsageEntry per finished subagent, keyed to
  // the PARENT session so the token ring and bySession totals stay correct,
  // plus its own row in bySubagent via role/agentId/subagentTask.
  logUsage: (entry) => {
    const record = subagentManager.get(entry.agentId);
    const parentMeta = sessionStore.get(entry.sessionId);
    tokenLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: entry.sessionId,
      sessionTitle: parentMeta?.name,
      claudeSessionId: record?.engineSessionId ?? "",
      messageId: entry.agentId,
      source: "subagent",
      costUsd: entry.usage.costUsd,
      durationMs: entry.durationMs,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      success: record?.status === "done",
      provider: entry.engineId,
      model: entry.model ?? undefined,
      role: "subagent",
      agentId: entry.agentId,
      subagentTask: record?.task,
      subagentName: record?.name,
    });
  },
});

setupSocketHandler(io, processManager, sessionStore, skillCatalog, chatStore, tokenLogger, subagentManager);

// ---- P2-2: HTTP rate limiting ----
// This is a local single-user app — limits are generous to avoid self-DoS.
// Tighter limits protect against runaway scripts or external abuse if port is exposed.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down" },
});

const sessionCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many session creation requests" },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Upload limit reached — try again later" },
});

// ---- Routes ----
app.use("/api/auth", createAuthRouter());
app.use("/api/health", generalLimiter, createHealthRouter(processManager, io, subagentManager));
app.use("/api/sessions", sessionCreateLimiter, createSessionsRouter(sessionStore, processManager, chatStore));
app.use("/api/images", uploadLimiter, imagesRouter);
app.use("/api/files", uploadLimiter, filesRouter);
app.use("/api/stt", uploadLimiter, sttRouter);
app.use("/api/tts", generalLimiter, ttsRouter);
app.use("/api/skills", generalLimiter, createSkillsRouter(skillCatalog));
app.use("/api/chat", generalLimiter, createChatRouter(chatStore));
app.use("/api/projects", generalLimiter, createProjectsRouter(projectStore));
app.use("/api/quick-tasks", generalLimiter, createQuickTasksRouter(quickTaskStore));
app.use("/api/runners", generalLimiter, createRunnersRouter(runnerManager));
// `spawn_agent` with wait:true holds this request open for the whole subagent
// run, so this mount must stay out of any future request-timeout middleware.
app.use("/api/subagents", generalLimiter, createSubagentsRouter(subagentManager));
const { metricsRouter, tokenUsageHandler } = createMetricsRouter(tokenLogger);
app.use("/api/metrics", generalLimiter, metricsRouter);
// Clean alias: GET /api/token-usage?period=day|week|month (for Token Usage Dashboard)
app.get("/api/token-usage", generalLimiter, tokenUsageHandler);
app.use("/api/caffeine", generalLimiter, createCaffeineRouter());
app.use("/api/settings", generalLimiter, createSettingsRouter(processManager, io));
app.use("/api/providers", generalLimiter, createProvidersRouter());
app.use("/api/headroom", generalLimiter, createHeadroomRouter());
app.use("/api/onenote", generalLimiter, createOneNoteRouter());
// TicTalk proxy — forwards TicBuddy/TicTamer iOS app messages to Anthropic Claude API.
// Has its own stricter rate limiter (20 req/min) since each call hits the paid API.
app.use("/api/tictalk", createTicTalkRouter());

// ---- Graceful shutdown function (defined before routes so we can use it) ----
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[medusa] ${signal} received — starting graceful shutdown`);

  // 0. Stop the Headroom proxy + local Whisper STT server if we own them
  //    (safe no-op if reused/never started)
  stopHeadroomProxy();
  stopWhisperServer();
  stopTtsServer();
  stopScreencast();
  stopSimulatorStream();
  // A subagent must never outlive the server that owns its socket room.
  subagentManager.cancelAll();

  // 1. Stop accepting new connections
  server.close();

  // 2. Release the caffeine assertion
  shutdownCaffeine();

  // 3. Check for busy sessions
  const busyIds = processManager.getBusySessions();
  const busySessions = busyIds
    .map((id) => {
      const meta = sessionStore.get(id);
      return meta ? { id, name: meta.name } : { id, name: id };
    });

  if (busySessions.length === 0) {
    console.log("[medusa] No active sessions — shutting down immediately");
    process.exit(0);
  }

  console.log(`[medusa] Waiting for ${busySessions.length} active session(s) to finish...`);
  busySessions.forEach((s) => console.log(`  - ${s.name} (${s.id})`));

  // 4. Notify clients that shutdown is in progress
  io.emit("server:shutting-down", { busySessions });

  // 5. Wait up to gracefulTimeoutMs for active sessions to finish
  const timeout = config.gracefulTimeoutMs;
  const start = Date.now();

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const stillBusy = processManager.getBusySessions();

      if (stillBusy.length === 0) {
        clearInterval(check);
        console.log("[medusa] All sessions finished — shutting down");
        // Clean shutdown: remove any stale interrupted-sessions file so we
        // don't spuriously re-trigger on next startup.
        try {
          if (fs.existsSync(config.interruptedSessionsFile)) {
            fs.unlinkSync(config.interruptedSessionsFile);
          }
        } catch (err) {
          console.error("[medusa] Failed to remove interrupted-sessions file:", err);
        }
        resolve();
        return;
      }

      if (Date.now() - start > timeout) {
        clearInterval(check);
        console.log(`[medusa] Timeout (${timeout}ms) — force killing ${stillBusy.length} session(s):`);

        // Persist interrupted session state before killing so a future restart
        // can tell the user what was in flight.
        const interrupted = stillBusy.map((id) => {
          const messages = chatStore.loadMessages(id);
          // Find the last user message: that's the task the session was working on.
          const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
          return {
            sessionId: id,
            lastMessageId: lastUserMsg?.id ?? "",
            lastMessageText: lastUserMsg?.text ?? "",
            interruptedAt: new Date().toISOString(),
          };
        });

        try {
          fs.writeFileSync(
            config.interruptedSessionsFile,
            JSON.stringify(interrupted, null, 2),
            "utf-8"
          );
          console.log(`[medusa] Persisted ${interrupted.length} interrupted session(s) to ${config.interruptedSessionsFile}`);
        } catch (err) {
          console.error("[medusa] Failed to write interrupted-sessions file:", err);
        }

        stillBusy.forEach((id) => {
          const meta = sessionStore.get(id);
          console.log(`  - Force killing: ${meta?.name || id}`);
          processManager.abort(id);
        });
        resolve();
      }
    }, 500);
  });

  process.exit(0);
}

// Serve uploaded images. authMiddleware (applied globally above) protects this.
// Must come before express.static(publicDir) so /uploads/* isn't shadowed.
app.use("/uploads", express.static(config.uploadsDir));

// In production, serve the built client as static files
const publicDir = config.staticDir;
app.use(express.static(publicDir));
// SPA fallback: serve index.html for any non-API route
app.get("*", (_req, res, next) => {
  if (_req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir, "index.html"), (err) => {
    if (err) next();
  });
});

// ---- Free the port if a stale process is holding it ----
function freePort(port: number): void {
  // Guard: port must be a safe integer in valid range — prevents command injection
  // if config.port ever comes from an untrusted source (e.g., env var not yet validated).
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[medusa] freePort: invalid port ${port} — skipping`);
    return;
  }

  try {
    // Use execFileSync (not execSync) — arguments are passed as an array, bypassing the shell
    // entirely. No interpolation, no injection risk even if port were somehow non-numeric.
    const pids = execFileSync("lsof", ["-i", `:${port}`, "-t"], { encoding: "utf-8" })
      .trim()
      .split("\n")
      .filter(Boolean);

    if (pids.length > 0) {
      console.log(`[medusa] Port ${port} in use by PID(s) ${pids.join(", ")} — killing`);
      for (const pid of pids) {
        // Only send signals to numeric PIDs — guards against unexpected lsof output.
        const pidNum = Number(pid);
        if (Number.isInteger(pidNum) && pidNum > 0) {
          try { process.kill(pidNum, "SIGTERM"); } catch {}
        }
      }
      // Brief wait for processes to release the port before we bind.
      execFileSync("sleep", ["0.5"]);
    }
  } catch {
    // lsof exit code non-zero means port is free — no action needed.
  }
}

freePort(config.port);

// ---- Startup cleanup of interrupted-sessions.json ----
// The multi-bot auto-resume pipeline (autonomousDeliver) is gone: a chat that
// was force-killed mid-turn is no longer automatically re-sent on the next
// boot. This just clears the bookkeeping file left behind by a forced
// shutdown so it doesn't grow stale between restarts.

/** Shape of each entry in interrupted-sessions.json (written on forced shutdown). */
export interface InterruptedSession {
  sessionId: string;
  lastMessageId: string;
  lastMessageText: string;
  interruptedAt: string;
}

// P2-6: Zod schema for validating interrupted-sessions.json
const InterruptedSessionSchema = z.object({
  sessionId: z.string(),
  lastMessageId: z.string(),
  lastMessageText: z.string(),
  interruptedAt: z.string(),
});

const InterruptedSessionsFileSchema = z.array(InterruptedSessionSchema);

/**
 * Reads interrupted-sessions.json (if present), logs what was in flight, then
 * deletes the file. Called after server.listen() purely for bookkeeping:
 * there is no automatic resume anymore.
 */
async function resumeInterruptedSessions(): Promise<InterruptedSession[]> {
  const filePath = config.interruptedSessionsFile;

  if (!fs.existsSync(filePath)) {
    return [];
  }

  let entries: InterruptedSession[];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    entries = InterruptedSessionsFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.error("[medusa] Failed to read interrupted-sessions.json, discarding:", err);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // best-effort cleanup
    }
    return [];
  }

  try {
    fs.unlinkSync(filePath);
    console.log(`[medusa] Deleted interrupted-sessions.json (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`);
  } catch (err) {
    console.error("[medusa] Failed to delete interrupted-sessions.json:", err);
  }

  return entries;
}

// ---- Start listening ----
server.listen(config.port, config.host, () => {
  console.log(`\n  🐍 Medusa is running!\n`);
  console.log(`  Local:   http://localhost:${config.port}`);
  if (config.authToken) {
    console.log(`  Token:   ${config.authToken.slice(0, 8)}...${config.authToken.slice(-4)}`);
  }
  console.log("");

  // Start the Headroom compression proxy (fire-and-forget). Bots pick it up on
  // their next spawn once it's ready; if it never comes up they run direct.
  void startHeadroomProxy();

  // Start (or adopt) the local Whisper STT server that backs the mic button.
  void startWhisperServer();

  // Start (or adopt) the local Kokoro TTS server that voices Medusa's replies.
  void startTtsServer();

  // Hot-reload projects.json when it changes on disk (e.g., a bot edits it directly).
  // Broadcasts projects:updated to all clients so the Projects Pane refreshes without restart.
  projectStore.watchFile((projects) => {
    io.emit("projects:updated", projects);
  });

  // Hot-reload quick-tasks.json for real-time sync
  quickTaskStore.watchFile((tasks) => {
    io.emit("quick-tasks:updated", tasks);
  });

  // Clean up any interrupted-sessions.json left behind by a forced shutdown.
  // Small delay to let socket handlers settle first.
  setTimeout(() => {
    resumeInterruptedSessions().catch((err) => {
      console.error("[medusa] Unhandled error during interrupted-sessions cleanup:", err);
    });
  }, 1000);
});

// ---- Signal handlers for graceful shutdown ----
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
