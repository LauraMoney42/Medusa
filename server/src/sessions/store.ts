import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { z } from "zod";
import config from "../config.js";

const SessionMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The chat's project folder. One chat = one folder. */
  workingDir: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  yoloMode: z.boolean().optional(),
  /** Per-chat extra instructions, appended to the orchestrator prompt. */
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  /** Per-session model override: bypasses routing if set (e.g. "fable", "haiku", "opus") */
  model: z.string().optional(),
  /**
   * S14: model used for voice turns only. The conversation lane wants a fast
   * tier even when the chat is on a slower one. Unset means "use `model`".
   */
  voiceModel: z.string().optional(),
  /** Which CLI harness runs this chat ("claude" | "kimi" | "code-puppy"). */
  engineId: z.string().optional(),
  /** Which provider env this chat uses ("claude" | "kimi" | "openrouter"). */
  providerId: z.string().optional(),
  archived: z.boolean().optional(),
});

const SessionsFileSchema = z.array(SessionMetaSchema);

export type SessionMeta = z.infer<typeof SessionMetaSchema>;

/** Prompt markers from the removed multi-bot protocol. A migrated chat must carry none of them. */
const BOT_MARKERS = ["[HUB-POST", "[TASK-DONE", "[BOT-TASK"];

/**
 * Wording that only ever appeared in the PM/bot roster prompts. A systemPrompt
 * containing any of these is bot-era configuration and is dropped on migration,
 * because the orchestrator prompt replaces it wholesale.
 */
const PM_PHRASES = [
  "you are medusa, the pm",
  "pm bot",
  "pm + orchestrator",
  "@dev1",
  "@devs",
  "multi-bot",
  "assign tasks to a specific dev",
];

/** True when this prompt is bot-era configuration that migration must clear. */
export function hasBotMarkers(prompt: string | undefined): boolean {
  if (!prompt) return false;
  if (BOT_MARKERS.some((m) => prompt.includes(m))) return true;
  const lower = prompt.toLowerCase();
  return PM_PHRASES.some((p) => lower.includes(p));
}

/**
 * Build the single starter chat used when migration finds no Medusa session.
 * Named after its folder, per the B.2 title rule.
 */
function createDefaultSession(): SessionMeta {
  const now = new Date().toISOString();
  const homeDir = os.homedir();
  const documents = path.join(homeDir, "Documents");
  const workingDir = fs.existsSync(documents) ? documents : homeDir;
  return {
    id: crypto.randomUUID(),
    name: path.basename(workingDir),
    workingDir,
    createdAt: now,
    lastActiveAt: now,
  };
}

/**
 * Persists session metadata to disk as a JSON file.
 * Uses an in-memory cache as the source of truth to avoid disk read-modify-write
 * races. All mutating methods update the cache first, then flush atomically to disk.
 * Disk reads only happen at startup (constructor).
 */
export class SessionStore {
  private filePath: string;
  /** In-memory cache, always the authoritative state */
  private sessions: SessionMeta[] = [];

  /**
   * @param filePath Override the sessions.json location. Tests pass a temp path;
   *   production uses config.sessionsFile.
   */
  constructor(filePath?: string) {
    this.filePath = filePath ?? config.sessionsFile;
    this.load();
  }

  /** Path of the one-shot migration marker, beside sessions.json. */
  private get markerPath(): string {
    return path.join(path.dirname(this.filePath), ".migrated-single-agent");
  }

  /** Path of the pre-migration backup of the whole roster. */
  private get backupPath(): string {
    return path.join(path.dirname(this.filePath), "sessions.bots.backup.json");
  }

  /** Load sessions from disk into memory at startup. */
  private load(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      // Fresh install: zero chats. The client shows the "New chat" empty state.
      this.sessions = [];
      this.writeAtomic(this.sessions);
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.sessions = SessionsFileSchema.parse(JSON.parse(raw));
    } catch {
      this.sessions = [];
    }
    this.migrateFromBots();
  }

  /**
   * One-shot migration from the multi-bot roster to a single chat (spec B.3).
   *
   * Runs only when the marker file is absent, so a second load() is a no-op.
   * Nothing is destroyed: the whole pre-migration roster is copied to
   * sessions.bots.backup.json and the dropped bots keep their chat history
   * files on disk.
   */
  migrateFromBots(): void {
    if (fs.existsSync(this.markerPath)) return;

    // 1. Back up the roster verbatim before touching anything.
    try {
      fs.copyFileSync(this.filePath, this.backupPath);
    } catch (err) {
      console.error("[sessions] Migration backup failed, aborting migration:", err);
      return;
    }

    const before = this.sessions.length;

    // 2. Keep the Medusa session, with its id byte for byte, so
    //    ~/.claude-chat/chats/<id>.json and `claude --resume <id>` still resolve.
    const medusa = this.sessions.find((s) => /^medusa$/i.test(s.name.trim()));

    if (medusa) {
      // 3. Marker-bearing prompts must not survive: undefined means
      //    "use the orchestrator prompt".
      if (hasBotMarkers(medusa.systemPrompt)) {
        delete medusa.systemPrompt;
      }
      // 4. Drop every other session from sessions.json (chat files stay on disk).
      this.sessions = [medusa];
    } else {
      // 5. No Medusa session: start one chat at ~/Documents.
      this.sessions = [createDefaultSession()];
    }

    this.persist();

    // 6. Write the marker so this never runs again.
    try {
      fs.writeFileSync(this.markerPath, new Date().toISOString(), "utf-8");
    } catch (err) {
      console.error("[sessions] Failed to write migration marker:", err);
    }

    console.log(
      `[sessions] Migrated ${before} bot session(s) to 1 chat; backup at ${this.backupPath}`
    );
  }

  /** Atomically write the sessions array to disk. */
  private writeAtomic(sessions: SessionMeta[]): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }

  /** Flush the current in-memory state to disk. */
  private persist(): void {
    this.writeAtomic(this.sessions);
  }

  /** Load all session metadata from the in-memory cache. */
  loadAll(): SessionMeta[] {
    return [...this.sessions];
  }

  /** Save (create or update) a single session entry. */
  save(session: SessionMeta): void {
    const idx = this.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      this.sessions[idx] = session;
    } else {
      this.sessions.push(session);
    }
    this.persist();
  }

  /** Get a session by id, or undefined if not found. */
  get(id: string): SessionMeta | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** Rename a session. */
  rename(id: string, name: string): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.name = name;
    this.persist();
    return session;
  }

  /** Remove a session by id. Returns true if it existed. */
  remove(id: string): boolean {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    this.sessions.splice(idx, 1);
    this.persist();
    return true;
  }

  /** Toggle yoloMode (dangerously-skip-permissions) for a session. */
  toggleYolo(id: string): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.yoloMode = !session.yoloMode;
    this.persist();
    return session;
  }

  /** Set yoloMode explicitly for a session. */
  setYolo(id: string, yoloMode: boolean): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.yoloMode = yoloMode || undefined;
    this.persist();
    return session;
  }

  /** Update working directory for a session. */
  updateWorkingDir(id: string, workingDir: string): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.workingDir = workingDir;
    this.persist();
    return session;
  }

  /** Update system prompt for a session. */
  updateSystemPrompt(id: string, systemPrompt: string): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.systemPrompt = systemPrompt || undefined;
    this.persist();
    return session;
  }

  /** Set the engine (CLI harness) for a session. Pass null to clear. */
  setEngine(id: string, engineId: string | null): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.engineId = engineId ?? undefined;
    this.persist();
    return session;
  }

  /** Set the provider for a session. Pass null to fall back to the global setting. */
  setProvider(id: string, providerId: string | null): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.providerId = providerId ?? undefined;
    this.persist();
    return session;
  }

  /** Set per-session model override (e.g. "fable", "haiku", "opus"). Pass null to clear. */
  setModel(id: string, model: string | null): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.model = model ?? undefined;
    this.persist();
    return session;
  }

  /** Set the voice-turn model override. Pass null to fall back to `model`. */
  setVoiceModel(id: string, voiceModel: string | null): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.voiceModel = voiceModel ?? undefined;
    this.persist();
    return session;
  }

  /**
   * Temporarily point `model` at another tier for the duration of one turn,
   * returning the undo. Used by the voice loop so a `voiceModel` reaches the
   * engine through the normal send path without being written to disk (the
   * user's chosen model must survive a restart mid-conversation).
   */
  overrideModelForTurn(id: string, model: string): () => void {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return () => undefined;
    const previous = session.model;
    session.model = model;
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      session.model = previous;
    };
  }

  /** Update skills for a session. */
  updateSkills(id: string, skills: string[]): SessionMeta | undefined {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return undefined;
    session.skills = skills.length > 0 ? skills : undefined;
    this.persist();
    return session;
  }

  /** Reorder sessions by a list of IDs. */
  reorder(order: string[]): void {
    const map = new Map(this.sessions.map((s) => [s.id, s]));
    const reordered = order
      .map((id) => map.get(id))
      .filter((s): s is SessionMeta => s != null);
    // Append any sessions not in the order list (safety)
    for (const s of this.sessions) {
      if (!order.includes(s.id)) reordered.push(s);
    }
    this.sessions = reordered;
    this.persist();
  }

  /** Update the lastActiveAt timestamp for a session. */
  updateLastActive(id: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      this.persist();
    }
  }
}
