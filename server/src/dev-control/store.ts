import fs from "fs";
import path from "path";
import config from "../config.js";

export interface DevControlEntry {
  paused: boolean;
  statusRequested: boolean;
  interrupted: boolean;
  updatedAt: number;
}

export interface DevControlSnapshot {
  [sessionId: string]: DevControlEntry;
}

export class DevControlStore {
  private entries = new Map<string, DevControlEntry>();
  private filePath: string;

  constructor(filePath = config.devControlFile) {
    this.filePath = filePath;
    this.loadSync();
  }

  private loadSync(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as DevControlSnapshot;
      for (const [id, entry] of Object.entries(parsed)) {
        this.entries.set(id, entry);
      }
    } catch (err) {
      console.error("[dev-control] Failed to load state:", err);
      this.entries.clear();
    }
  }

  private persistSync(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const snapshot: DevControlSnapshot = {};
      for (const [id, entry] of this.entries) {
        snapshot[id] = entry;
      }
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[dev-control] Failed to persist state:", err);
    }
  }

  private touch(sessionId: string): DevControlEntry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { paused: false, statusRequested: false, interrupted: false, updatedAt: Date.now() };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  get(sessionId: string): DevControlEntry {
    return this.touch(sessionId);
  }

  isPaused(sessionId: string): boolean {
    return this.get(sessionId).paused;
  }

  pause(sessionId: string): void {
    const entry = this.touch(sessionId);
    entry.paused = true;
    entry.updatedAt = Date.now();
    this.persistSync();
  }

  resume(sessionId: string): void {
    const entry = this.touch(sessionId);
    entry.paused = false;
    entry.interrupted = false;
    entry.updatedAt = Date.now();
    this.persistSync();
  }

  requestStatus(sessionId: string): void {
    const entry = this.touch(sessionId);
    entry.statusRequested = true;
    entry.updatedAt = Date.now();
    this.persistSync();
  }

  clearStatusRequest(sessionId: string): void {
    const entry = this.touch(sessionId);
    entry.statusRequested = false;
    entry.updatedAt = Date.now();
    this.persistSync();
  }

  hasStatusRequest(sessionId: string): boolean {
    return this.get(sessionId).statusRequested;
  }

  markInterrupted(sessionId: string): void {
    const entry = this.touch(sessionId);
    entry.interrupted = true;
    entry.updatedAt = Date.now();
    this.persistSync();
  }

  clearInterrupted(sessionId: string): void {
    const entry = this.touch(sessionId);
    entry.interrupted = false;
    entry.updatedAt = Date.now();
    this.persistSync();
  }

  remove(sessionId: string): boolean {
    const removed = this.entries.delete(sessionId);
    if (removed) this.persistSync();
    return removed;
  }

  snapshot(): DevControlSnapshot {
    const result: DevControlSnapshot = {};
    for (const [id, entry] of this.entries) {
      result[id] = { ...entry };
    }
    return result;
  }

  allSessionIds(): string[] {
    return Array.from(this.entries.keys());
  }
}

export const devControlStore = new DevControlStore();
