import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { z } from "zod";
import config from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SessionMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  workingDir: z.string(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  yoloMode: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

const SessionsFileSchema = z.array(SessionMetaSchema);

export type SessionMeta = z.infer<typeof SessionMetaSchema>;

/**
 * Persists session metadata to disk as a JSON file.
 * Uses an in-memory cache as the source of truth to avoid disk read-modify-write
 * races. All mutating methods update the cache first, then flush atomically to disk.
 * Disk reads only happen at startup (constructor).
 */
export class SessionStore {
  private filePath: string;
  /** In-memory cache — always the authoritative state */
  private sessions: SessionMeta[] = [];

  constructor() {
    this.filePath = config.sessionsFile;
    this.load();
  }

  /** Load sessions from disk into memory at startup. */
  private load(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      // First launch — seed from default-bots.json if it exists
      const defaults = this.loadDefaults();
      this.writeAtomic(defaults);
      this.sessions = defaults;
      if (defaults.length > 0) {
        console.log(`[sessions] Seeded ${defaults.length} default bot(s) on first launch`);
      }
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.sessions = SessionsFileSchema.parse(JSON.parse(raw));
    } catch {
      this.sessions = [];
    }
  }

  /** Load default bot templates from server/default-bots.json. */
  private loadDefaults(): SessionMeta[] {
    try {
      // default-bots.json is at server root (two levels up from dist/sessions/)
      const defaultsPath = path.resolve(__dirname, "../../default-bots.json");
      if (!fs.existsSync(defaultsPath)) return [];

      const raw = fs.readFileSync(defaultsPath, "utf-8");
      const templates = JSON.parse(raw) as Array<{ name: string; systemPrompt: string }>;
      const now = new Date().toISOString();
      const homeDir = os.homedir();
      const defaultWorkingDir = path.join(homeDir, "Documents");

      return templates.map((t) => ({
        id: crypto.randomUUID(),
        name: t.name,
        workingDir: fs.existsSync(defaultWorkingDir) ? defaultWorkingDir : homeDir,
        createdAt: now,
        lastActiveAt: now,
        systemPrompt: t.systemPrompt.replace(/~\//g, homeDir + "/"),
      }));
    } catch (err) {
      console.error("[sessions] Failed to load default bots:", err);
      return [];
    }
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
