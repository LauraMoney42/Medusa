import { Router, Request, Response } from "express";
import os from "os";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { SessionStore } from "../sessions/store.js";
import { ProcessManager } from "../claude/process-manager.js";
import { ChatStore } from "../chat/store.js";
import type { MentionRouter } from "../hub/mention-router.js";
import type { HubPollScheduler } from "../hub/poll-scheduler.js";

export function createSessionsRouter(
  store: SessionStore,
  processManager: ProcessManager,
  chatStore: ChatStore,
  mentionRouter?: MentionRouter,
  pollScheduler?: HubPollScheduler
): Router {
  const router = Router();

  // GET / -- list all sessions
  router.get("/", (_req: Request, res: Response) => {
    const sessions = store.loadAll();
    res.json(sessions);
  });

  // POST / -- create a new session
  router.post("/", (req: Request, res: Response) => {
    const { name, workingDir, systemPrompt } = req.body as {
      name?: string;
      workingDir?: string;
      systemPrompt?: string;
    };

    const id = uuidv4();
    const now = new Date().toISOString();

    // Resolve to absolute path, normalize separators, default to home
    let resolvedDir = os.homedir();
    if (workingDir && workingDir.trim()) {
      // Normalize backslashes to forward slashes (Windows input on Mac)
      const normalized = workingDir.trim().replace(/\\/g, "/");
      // Resolve relative paths against home directory
      resolvedDir = path.isAbsolute(normalized)
        ? path.normalize(normalized)
        : path.resolve(os.homedir(), normalized);
    }

    // Security: reject paths outside the user's home directory to prevent path traversal.
    // An attacker supplying workingDir="../../etc" or "/root" would be rejected here.
    const homeDir = os.homedir();
    const relative = path.relative(homeDir, resolvedDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      // Log the actual path server-side for debugging; return generic message to client.
      console.warn(`[sessions] Rejected workingDir outside homedir: ${resolvedDir}`);
      res.status(400).json({ error: "Invalid working directory" });
      return;
    }

    // Validate the directory exists — use generic error to avoid leaking filesystem paths.
    if (!fs.existsSync(resolvedDir)) {
      res.status(400).json({ error: "Invalid working directory" });
      return;
    }

    const session = {
      id,
      name: name || "New Chat",
      workingDir: resolvedDir,
      createdAt: now,
      lastActiveAt: now,
      ...(systemPrompt?.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
    };

    store.save(session);
    processManager.createSession(id, resolvedDir);

    res.status(201).json(session);
  });

  // PUT /reorder -- reorder sessions
  router.put("/reorder", (req: Request, res: Response) => {
    const { order } = req.body as { order?: string[] };
    if (!order || !Array.isArray(order)) {
      res.status(400).json({ error: "order array is required" });
      return;
    }
    store.reorder(order);
    res.json({ ok: true });
  });

  // POST /bulk-prompt-append -- append text to all sessions' system prompts.
  // Idempotent: sessions that already contain the exact text are skipped.
  // Used for deploying protocol updates (e.g. [BOT-TASK] token spec) to all active bots at once.
  router.post("/bulk-prompt-append", (req: Request, res: Response) => {
    const { append } = req.body as { append?: string };

    if (!append?.trim()) {
      res.status(422).json({ error: "append text is required" });
      return;
    }

    const text = append.trim();
    const allSessions = store.loadAll();
    const results: Array<{ id: string; name: string; status: "updated" | "skipped" }> = [];

    for (const session of allSessions) {
      const current = session.systemPrompt ?? "";
      // Idempotency guard — don't append if this exact block is already present
      if (current.includes(text)) {
        results.push({ id: session.id, name: session.name, status: "skipped" });
        continue;
      }
      const newPrompt = current ? `${current}\n\n${text}` : text;
      store.updateSystemPrompt(session.id, newPrompt);
      results.push({ id: session.id, name: session.name, status: "updated" });
    }

    const updated = results.filter((r) => r.status === "updated").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    // Log counts only — prompt content may be sensitive
    console.log(`[sessions] Bulk prompt append: ${updated} updated, ${skipped} already up-to-date`);

    res.json({ updated, skipped, sessions: results });
  });

  // PATCH /:id -- update a session (name, systemPrompt, and/or compactSystemPrompt)
  router.patch("/:id", (req: Request, res: Response) => {
    const { name, systemPrompt, compactSystemPrompt } = req.body as {
      name?: string;
      systemPrompt?: string;
      compactSystemPrompt?: string;
    };

    if (!name && systemPrompt === undefined && compactSystemPrompt === undefined) {
      res.status(400).json({ error: "At least one of name, systemPrompt, or compactSystemPrompt is required" });
      return;
    }

    const id = req.params.id as string;
    let session = store.get(id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (name) {
      session = store.rename(id, name) ?? session;
    }
    if (systemPrompt !== undefined) {
      session = store.updateSystemPrompt(id, systemPrompt) ?? session;
    }
    // TC-4B: Allow setting compact system prompt per session
    if (compactSystemPrompt !== undefined) {
      session = store.updateCompactSystemPrompt(id, compactSystemPrompt) ?? session;
    }

    res.json(session);
  });

  // DELETE /:id -- delete a session
  router.delete("/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    processManager.deleteSession(id);
    chatStore.deleteSession(id);
    // Clean up orphaned Map entries to prevent memory growth
    mentionRouter?.removeSession(id);
    pollScheduler?.removeSession(id);
    const removed = store.remove(id);

    if (!removed) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.json({ ok: true });
  });

  return router;
}
