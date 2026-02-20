import fs from "fs";
import http from "http";
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
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
import { createSkillsRouter } from "./routes/skills.js";
import { setupSocketHandler } from "./socket/handler.js";
import { ProcessManager } from "./claude/process-manager.js";
import { SessionStore } from "./sessions/store.js";
import { SkillCatalog } from "./skills/catalog.js";
import { ChatStore } from "./chat/store.js";
import { createChatRouter } from "./routes/chat.js";
import { HubStore } from "./hub/store.js";
import { MentionRouter } from "./hub/mention-router.js";
import { createHubRouter } from "./routes/hub.js";
import { ProjectStore } from "./projects/store.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createCaffeineRouter, shutdownCaffeine } from "./routes/caffeine.js";
import { createSettingsRouter } from "./routes/settings.js";
import { TaskSyncManager } from "./projects/task-sync.js";
import { HubPollScheduler } from "./hub/poll-scheduler.js";
import { paginateDevlogs } from "./utils/devlog-paginator.js";
import { autonomousDeliver } from "./claude/autonomous-deliver.js";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Instantiate shared services ----
const processManager = new ProcessManager();
const sessionStore = new SessionStore();
const skillCatalog = new SkillCatalog(config.skillsCacheDir);
skillCatalog.initialize().catch(console.error);
const chatStore = new ChatStore(path.dirname(config.sessionsFile));
const hubStore = new HubStore(config.hubFile);
const projectStore = new ProjectStore(config.projectsFile);

// Pre-load existing sessions into the process manager so that
// resumed conversations work after a server restart.
// isFirstMessage=false because these sessions already exist in Claude Code.
const allSessions = sessionStore.loadAll();
for (const meta of allSessions) {
  processManager.createSession(meta.id, meta.workingDir, false);
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
  },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10 MB
});

// MentionRouter needs io for streaming responses to session rooms
const mentionRouter = new MentionRouter(processManager, sessionStore, hubStore, chatStore, io);

setupSocketHandler(io, processManager, sessionStore, skillCatalog, chatStore, hubStore, mentionRouter);

// ---- Background hub polling + stale assignment tracking ----
const pollScheduler = new HubPollScheduler(
  processManager, sessionStore, hubStore, mentionRouter, io, chatStore
);

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

// ---- Routes (now we can reference pollScheduler for shutdown endpoint) ----
app.use("/api/auth", createAuthRouter());
app.use("/api/health", generalLimiter, createHealthRouter(processManager, pollScheduler, io));
app.use("/api/sessions", sessionCreateLimiter, createSessionsRouter(sessionStore, processManager, chatStore, mentionRouter, pollScheduler));
app.use("/api/images", uploadLimiter, imagesRouter);
app.use("/api/skills", generalLimiter, createSkillsRouter(skillCatalog));
app.use("/api/chat", generalLimiter, createChatRouter(chatStore));
app.use("/api/hub", generalLimiter, createHubRouter(hubStore, io, mentionRouter, sessionStore));
app.use("/api/projects", generalLimiter, createProjectsRouter(projectStore));
app.use("/api/caffeine", generalLimiter, createCaffeineRouter());
app.use("/api/settings", generalLimiter, createSettingsRouter());

// ---- Graceful shutdown function (defined before routes so we can use it) ----
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[medusa] ${signal} received — starting graceful shutdown`);

  // 1. Stop accepting new connections
  server.close();

  // 2. Stop the poll scheduler (no new polls) and release caffeine assertion
  pollScheduler.stop();
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

        // Persist interrupted session state before killing so AR2 can auto-resume on next startup.
        const interrupted = stillBusy.map((id) => {
          const meta = sessionStore.get(id);
          const messages = chatStore.loadMessages(id);
          // Find the last user message — that's the task the bot was working on.
          const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
          return {
            sessionId: id,
            botName: meta?.name ?? id,
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

// In production, serve the built client as static files
const publicDir = path.resolve(__dirname, "public");
app.use(express.static(publicDir));
// SPA fallback: serve index.html for any non-API route
app.get("*", (_req, res, next) => {
  if (_req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir, "index.html"), (err) => {
    if (err) next();
  });
});

if (config.hubPolling) {
  pollScheduler.start();
  console.log(`[medusa] Hub polling enabled (interval: ${config.hubPollIntervalMs}ms)`);
}

// ---- Project/Devlog Hygiene: Auto-update projects on [TASK-DONE:] ----
const taskSyncManager = new TaskSyncManager(projectStore);

// Wire session:pending-task and task:done events.
// Intercept io.emit() calls without modifying callsites.
const originalEmit = io.emit.bind(io);
io.emit = ((event: string, ...args: unknown[]) => {
  if (event === "session:pending-task") {
    const data = args[0] as { sessionId: string; hasPendingTask: boolean } | undefined;
    if (data) {
      if (data.hasPendingTask) {
        pollScheduler.trackPendingTask(data.sessionId);
      } else {
        pollScheduler.clearPendingTask(data.sessionId);
      }
    }
  } else if (event === "task:done") {
    const task = args[0] as any;
    if (task) {
      taskSyncManager.handleTaskDone(task);
    }
  }
  return originalEmit(event, ...args);
}) as typeof io.emit;

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

// ---- AR2: Startup detection + auto-re-trigger of interrupted sessions ----

/** Shape of each entry in interrupted-sessions.json (written by AR1 on forced shutdown). */
export interface InterruptedSession {
  sessionId: string;
  botName: string;
  lastMessageId: string;
  lastMessageText: string;
  interruptedAt: string;
}

// P2-6: Zod schema for validating interrupted-sessions.json
const InterruptedSessionSchema = z.object({
  sessionId: z.string(),
  botName: z.string(),
  lastMessageId: z.string(),
  lastMessageText: z.string(),
  interruptedAt: z.string(),
});

const InterruptedSessionsFileSchema = z.array(InterruptedSessionSchema);

/**
 * Reads interrupted-sessions.json (if present), re-queues the original user message
 * for each session, then immediately deletes the file to prevent re-triggering on the
 * next restart.
 *
 * Returns the list of entries that were successfully queued — AR3 (Backend Dev) uses
 * this list to post Hub notifications.
 *
 * Called after server.listen() so that `io` is active and clients can receive events.
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
    console.error("[medusa] AR2: Failed to read interrupted-sessions.json — skipping auto-resume:", err);
    return [];
  }

  // Delete the file immediately — before triggering anything — so a crash mid-resume
  // cannot cause an infinite re-trigger loop on the next restart.
  try {
    fs.unlinkSync(filePath);
    console.log("[medusa] AR2: Deleted interrupted-sessions.json");
  } catch (err) {
    console.error("[medusa] AR2: Failed to delete interrupted-sessions.json:", err);
    // Continue anyway — re-triggering is more important than file cleanup failure.
  }

  const queued: InterruptedSession[] = [];

  for (const entry of entries) {
    const { sessionId, botName, lastMessageText } = entry;

    if (!lastMessageText) {
      console.log(`[medusa] AR2: Skipping ${botName} (${sessionId}) — no lastMessageText`);
      continue;
    }

    const meta = sessionStore.get(sessionId);
    if (!meta) {
      // Session was deleted between shutdown and restart — skip silently per spec.
      console.log(`[medusa] AR2: Session ${sessionId} (${botName}) no longer exists — skipping`);
      continue;
    }

    const prompt = `[Auto-Resume] Your previous task was interrupted by a server restart. Resuming: ${lastMessageText}`;

    autonomousDeliver({
      sessionId,
      prompt,
      source: "resume",
      io,
      processManager,
      sessionStore,
      hubStore,
      chatStore,
    }).catch((err) => {
      console.error(`[medusa] AR2: autonomousDeliver failed for ${botName} (${sessionId}):`, err);
    });

    console.log(`[medusa] AR2: Queued auto-resume for ${botName} (${sessionId})`);
    queued.push(entry);
  }

  console.log(`[medusa] AR2: Queued ${queued.length} / ${entries.length} interrupted session(s) for auto-resume`);
  return queued;
}

// ---- Start listening ----
server.listen(config.port, config.host, () => {
  console.log(
    `[medusa] Server running at http://${config.host}:${config.port}`
  );

  // Hot-reload projects.json when it changes on disk (e.g., a bot edits it directly).
  // Broadcasts projects:updated to all clients so the Projects Pane refreshes without restart.
  projectStore.watchFile((projects) => {
    io.emit("projects:updated", projects);
  });

  // AR2 + AR3: Check for interrupted sessions, auto-resume them, then post Hub
  // notifications for each resumed bot. Small delay to let socket handlers settle.
  setTimeout(() => {
    resumeInterruptedSessions()
      .then((resumed) => {
        // AR3: Post one Hub message per resumed bot so the team knows what was auto-resumed.
        for (const entry of resumed) {
          const preview =
            entry.lastMessageText.length > 80
              ? entry.lastMessageText.slice(0, 80) + "..."
              : entry.lastMessageText;

          const hubMessage = `Resuming interrupted work for ${entry.botName}: "${preview}"`;

          // Use the session's own ID as the Hub message author — Medusa system message.
          const stored = hubStore.add({
            from: "Medusa",
            text: hubMessage,
            sessionId: entry.sessionId,
          });

          // Broadcast to all connected clients so the Hub panel updates live.
          io.emit("hub:message", stored);

          console.log(`[medusa] AR3: Posted Hub notification for ${entry.botName}`);
        }
      })
      .catch((err) => {
        console.error("[medusa] AR2/AR3: Unhandled error during auto-resume:", err);
      });
  }, 1000);
});

// ---- Signal handlers for graceful shutdown ----
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
