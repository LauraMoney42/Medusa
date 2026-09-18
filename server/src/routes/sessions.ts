import { Router, Request, Response } from "express";
import os from "os";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { SessionStore, type SessionMeta } from "../sessions/store.js";
import { ProcessManager } from "../claude/process-manager.js";
import { ChatStore } from "../chat/store.js";

/** Engines Medusa knows how to spawn. */
const ENGINE_IDS = ["claude", "kimi", "code-puppy"];
/** Providers whose env Medusa knows how to build. */
const PROVIDER_IDS = ["claude", "kimi", "openrouter"];

/**
 * Resolve a user-supplied folder to an absolute path inside the home directory.
 * Returns null when the path escapes home or does not exist.
 */
function resolveWorkingDir(workingDir: string): string | null {
  // Normalize backslashes to forward slashes (Windows input on Mac)
  let normalized = workingDir.trim().replace(/\\/g, "/");
  const homeDir = os.homedir();
  // Expand a leading "~" the way a shell would. Without this, "~/Documents"
  // would be treated as a relative path and resolve to "<home>/~/Documents",
  // which never exists. The New Chat placeholder shows a tilde path, so this
  // is a common input.
  if (normalized === "~") {
    normalized = homeDir;
  } else if (normalized.startsWith("~/")) {
    normalized = path.join(homeDir, normalized.slice(2));
  }
  const resolved = path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.resolve(homeDir, normalized);

  // Security: reject paths outside the user's home directory to prevent path traversal.
  // An attacker supplying workingDir="../../etc" or "/root" would be rejected here.
  const relative = path.relative(homeDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    console.warn(`[sessions] Rejected workingDir outside homedir: ${resolved}`);
    return null;
  }
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

/**
 * A chat's title defaults to its folder's basename, deduped against the
 * existing titles ("Medusa", "Medusa 2", "Medusa 3").
 */
function dedupeName(base: string, existing: SessionMeta[]): string {
  const taken = new Set(existing.map((s) => s.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function createSessionsRouter(
  store: SessionStore,
  processManager: ProcessManager,
  chatStore: ChatStore
): Router {
  const router = Router();

  // GET / -- list all chats
  router.get("/", (_req: Request, res: Response) => {
    res.json(store.loadAll());
  });

  // POST / -- create a new chat: one folder + one provider + one model + one engine
  router.post("/", (req: Request, res: Response) => {
    const { name, workingDir, engineId, providerId, model, systemPrompt } = req.body as {
      name?: string;
      workingDir?: string;
      engineId?: string;
      providerId?: string;
      model?: string;
      systemPrompt?: string;
    };

    // workingDir is required: a chat is scoped to exactly one project folder.
    if (!workingDir || !workingDir.trim()) {
      res.status(400).json({ error: "workingDir is required" });
      return;
    }

    const resolvedDir = resolveWorkingDir(workingDir);
    if (!resolvedDir) {
      res.status(400).json({ error: "Invalid working directory" });
      return;
    }

    if (engineId && !ENGINE_IDS.includes(engineId)) {
      res.status(400).json({ error: `Unknown engine: ${engineId}` });
      return;
    }
    if (providerId && !PROVIDER_IDS.includes(providerId)) {
      res.status(400).json({ error: `Unknown provider: ${providerId}` });
      return;
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const title = name?.trim()
      ? name.trim()
      : dedupeName(path.basename(resolvedDir), store.loadAll());

    const session: SessionMeta = {
      id,
      name: title,
      workingDir: resolvedDir,
      createdAt: now,
      lastActiveAt: now,
      ...(systemPrompt?.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
      ...(engineId ? { engineId } : {}),
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
    };

    store.save(session);
    processManager.createSession(id, resolvedDir, true, {
      engineId: session.engineId,
      providerId: session.providerId,
    });

    res.status(201).json(session);
  });

  // PUT /reorder -- reorder chats
  router.put("/reorder", (req: Request, res: Response) => {
    const { order } = req.body as { order?: string[] };
    if (!order || !Array.isArray(order)) {
      res.status(400).json({ error: "order array is required" });
      return;
    }
    store.reorder(order);
    res.json({ ok: true });
  });

  // PATCH /:id -- update a chat (title, folder, provider, engine, model, notes)
  router.patch("/:id", (req: Request, res: Response) => {
    const { name, systemPrompt, model, voiceModel, engineId, providerId, workingDir } =
      req.body as {
        name?: string;
        systemPrompt?: string;
        model?: string | null;
        voiceModel?: string | null;
        engineId?: string | null;
        providerId?: string | null;
        workingDir?: string;
      };

    if (
      !name &&
      systemPrompt === undefined &&
      model === undefined &&
      voiceModel === undefined &&
      engineId === undefined &&
      providerId === undefined &&
      workingDir === undefined
    ) {
      res.status(400).json({
        error:
          "At least one of name, systemPrompt, model, voiceModel, engineId, providerId, or workingDir is required",
      });
      return;
    }

    if (engineId && !ENGINE_IDS.includes(engineId)) {
      res.status(400).json({ error: `Unknown engine: ${engineId}` });
      return;
    }
    if (providerId && !PROVIDER_IDS.includes(providerId)) {
      res.status(400).json({ error: `Unknown provider: ${providerId}` });
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
    // Per-session model override (e.g. "fable", "haiku", "opus"; null to clear)
    if (model !== undefined) {
      session = store.setModel(id, model) ?? session;
    }
    // S14: voice turns may run on a faster tier than the rest of the chat.
    if (voiceModel !== undefined) {
      session = store.setVoiceModel(id, voiceModel) ?? session;
    }
    if (engineId !== undefined) {
      session = store.setEngine(id, engineId) ?? session;
    }
    if (providerId !== undefined) {
      session = store.setProvider(id, providerId) ?? session;
    }
    if (workingDir !== undefined) {
      const resolvedDir = resolveWorkingDir(workingDir);
      if (!resolvedDir) {
        res.status(400).json({ error: "Invalid working directory" });
        return;
      }
      session = store.updateWorkingDir(id, resolvedDir) ?? session;
      processManager.updateWorkingDir(id, resolvedDir);
    }

    // Keep the spawn path in step with the chat's settings.
    processManager.configureSession(id, {
      engineId: session.engineId,
      providerId: session.providerId,
    });

    res.json(session);
  });

  // DELETE /:id -- delete a chat
  router.delete("/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    processManager.deleteSession(id);
    chatStore.deleteSession(id);
    const removed = store.remove(id);

    if (!removed) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.json({ ok: true });
  });

  return router;
}
