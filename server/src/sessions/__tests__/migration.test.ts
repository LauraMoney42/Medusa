import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SessionStore, hasBotMarkers, type SessionMeta } from "../store.js";

/**
 * Migration tests (spec B.3 / F.1). Everything runs against a temp directory:
 * the real ~/.claude-chat/sessions.json is never touched.
 */

const MEDUSA_ID = "3f0c1a7e-9c2b-4a11-8f77-0b1d2e3a4b5c";

/** A realistic pre-migration roster: Dev1, Dev2, Dev3, Fable, Medusa. */
function botFixture(): SessionMeta[] {
  const now = "2026-02-01T10:00:00.000Z";
  const home = os.homedir();
  const mk = (id: string, name: string, systemPrompt: string): SessionMeta => ({
    id,
    name,
    workingDir: home,
    createdAt: now,
    lastActiveAt: now,
    systemPrompt,
  });
  return [
    mk("11111111-1111-4111-8111-111111111111", "Dev1", "You are Dev1. Report with [TASK-DONE: description]."),
    mk("22222222-2222-4222-8222-222222222222", "Dev2", "You are Dev2. Post updates via [HUB-POST: ...]."),
    mk("33333333-3333-4333-8333-333333333333", "Dev3", "You are Dev3. Coordinate via [BOT-TASK: @Dev1 ...]."),
    mk("44444444-4444-4444-8444-444444444444", "Fable", "You are Fable, a writing assistant."),
    mk(
      MEDUSA_ID,
      "Medusa",
      "You are Medusa, the PM bot. Assign tasks to a specific dev using @Dev1. Post via [HUB-POST: ...]."
    ),
  ];
}

let tmpDir: string;
let sessionsPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-migration-"));
  sessionsPath = path.join(tmpDir, "sessions.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(sessions: SessionMeta[]): string {
  const raw = JSON.stringify(sessions, null, 2);
  fs.writeFileSync(sessionsPath, raw, "utf-8");
  return raw;
}

describe("migrateFromBots", () => {
  it("collapses a five-bot roster to a single chat", () => {
    writeFixture(botFixture());
    const store = new SessionStore(sessionsPath);
    const sessions = store.loadAll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.name).toBe("Medusa");
  });

  it("preserves the Medusa session id byte for byte", () => {
    writeFixture(botFixture());
    const store = new SessionStore(sessionsPath);
    expect(store.loadAll()[0]!.id).toBe(MEDUSA_ID);
    // and on disk, so ~/.claude-chat/chats/<id>.json stays attached
    const onDisk = JSON.parse(fs.readFileSync(sessionsPath, "utf-8")) as SessionMeta[];
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.id).toBe(MEDUSA_ID);
  });

  it("writes a backup that matches the input file exactly", () => {
    const raw = writeFixture(botFixture());
    new SessionStore(sessionsPath);
    const backupPath = path.join(tmpDir, "sessions.bots.backup.json");
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, "utf-8")).toBe(raw);
  });

  it("keeps the dropped bots recoverable from the backup", () => {
    writeFixture(botFixture());
    new SessionStore(sessionsPath);
    const backup = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "sessions.bots.backup.json"), "utf-8")
    ) as SessionMeta[];
    expect(backup.map((s) => s.name)).toEqual(["Dev1", "Dev2", "Dev3", "Fable", "Medusa"]);
  });

  it("clears a marker-bearing systemPrompt", () => {
    writeFixture(botFixture());
    const store = new SessionStore(sessionsPath);
    expect(store.loadAll()[0]!.systemPrompt).toBeUndefined();
  });

  it("keeps a clean systemPrompt on the surviving chat", () => {
    const fixture = botFixture();
    fixture[4]!.systemPrompt = "Prefer TypeScript and small commits.";
    writeFixture(fixture);
    const store = new SessionStore(sessionsPath);
    expect(store.loadAll()[0]!.systemPrompt).toBe("Prefer TypeScript and small commits.");
  });

  it("matches the Medusa session case-insensitively", () => {
    const fixture = botFixture();
    fixture[4]!.name = "  medusa ";
    writeFixture(fixture);
    const store = new SessionStore(sessionsPath);
    expect(store.loadAll()[0]!.id).toBe(MEDUSA_ID);
  });

  it("creates one chat named after ~/Documents when there is no Medusa session", () => {
    const fixture = botFixture().slice(0, 4);
    writeFixture(fixture);
    const store = new SessionStore(sessionsPath);
    const sessions = store.loadAll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.name).toBe(path.basename(sessions[0]!.workingDir));
  });

  it("writes the marker file", () => {
    writeFixture(botFixture());
    new SessionStore(sessionsPath);
    expect(fs.existsSync(path.join(tmpDir, ".migrated-single-agent"))).toBe(true);
  });

  it("is a no-op on a second load", () => {
    writeFixture(botFixture());
    new SessionStore(sessionsPath);

    // A chat created after migration must survive the next boot.
    const second = new SessionStore(sessionsPath);
    second.save({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Second chat",
      workingDir: os.homedir(),
      createdAt: "2026-09-17T00:00:00.000Z",
      lastActiveAt: "2026-09-17T00:00:00.000Z",
    });

    const backupBefore = fs.readFileSync(
      path.join(tmpDir, "sessions.bots.backup.json"),
      "utf-8"
    );
    const third = new SessionStore(sessionsPath);
    expect(third.loadAll().map((s) => s.name)).toEqual(["Medusa", "Second chat"]);
    // The backup is not overwritten by the post-migration state.
    expect(
      fs.readFileSync(path.join(tmpDir, "sessions.bots.backup.json"), "utf-8")
    ).toBe(backupBefore);
  });

  it("starts a fresh install with zero chats and no default bots", () => {
    const store = new SessionStore(sessionsPath);
    expect(store.loadAll()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(sessionsPath, "utf-8"))).toEqual([]);
  });
});

describe("schema", () => {
  it("round-trips engineId and providerId", () => {
    const store = new SessionStore(sessionsPath);
    store.save({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Medusa",
      workingDir: os.homedir(),
      createdAt: "2026-09-17T00:00:00.000Z",
      lastActiveAt: "2026-09-17T00:00:00.000Z",
      engineId: "kimi",
      providerId: "openrouter",
      model: "sonnet",
    });
    const reloaded = new SessionStore(sessionsPath).loadAll()[0]!;
    expect(reloaded.engineId).toBe("kimi");
    expect(reloaded.providerId).toBe("openrouter");
    expect(reloaded.model).toBe("sonnet");
  });

  it("drops the removed compactSystemPrompt field from old files", () => {
    fs.writeFileSync(
      sessionsPath,
      JSON.stringify([
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          name: "Medusa",
          workingDir: os.homedir(),
          createdAt: "2026-09-17T00:00:00.000Z",
          lastActiveAt: "2026-09-17T00:00:00.000Z",
          compactSystemPrompt: "old field",
        },
      ]),
      "utf-8"
    );
    const store = new SessionStore(sessionsPath);
    expect(store.loadAll()[0]).not.toHaveProperty("compactSystemPrompt");
  });

  it("setEngine and setProvider persist", () => {
    const store = new SessionStore(sessionsPath);
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    store.save({
      id,
      name: "Medusa",
      workingDir: os.homedir(),
      createdAt: "2026-09-17T00:00:00.000Z",
      lastActiveAt: "2026-09-17T00:00:00.000Z",
    });
    store.setEngine(id, "code-puppy");
    store.setProvider(id, "kimi");
    expect(new SessionStore(sessionsPath).loadAll()[0]).toMatchObject({
      engineId: "code-puppy",
      providerId: "kimi",
    });
    store.setEngine(id, null);
    expect(store.get(id)!.engineId).toBeUndefined();
  });
});

describe("hasBotMarkers", () => {
  it("detects each marker and the PM wording", () => {
    expect(hasBotMarkers("post via [HUB-POST: hi]")).toBe(true);
    expect(hasBotMarkers("[TASK-DONE: shipped]")).toBe(true);
    expect(hasBotMarkers("[BOT-TASK: @Dev2 do it]")).toBe(true);
    expect(hasBotMarkers("You are Medusa, the PM bot.")).toBe(true);
    expect(hasBotMarkers("Assign tasks to a specific dev.")).toBe(true);
  });

  it("leaves ordinary prompts alone", () => {
    expect(hasBotMarkers(undefined)).toBe(false);
    expect(hasBotMarkers("")).toBe(false);
    expect(hasBotMarkers("Prefer TypeScript and small commits.")).toBe(false);
  });
});
