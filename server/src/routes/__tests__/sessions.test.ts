import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createSessionsRouter } from "../sessions.js";
import { SessionStore } from "../../sessions/store.js";
import { ProcessManager } from "../../claude/process-manager.js";
import { ChatStore } from "../../chat/store.js";

/**
 * Route tests for POST/PATCH /api/sessions (spec B.2). The store is pointed at a
 * temp file, so the real ~/.claude-chat/sessions.json is never touched.
 */

let tmpDir: string;
let projectDir: string;
let server: Server;
let baseUrl: string;
let store: SessionStore;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-routes-"));
  // A real folder inside $HOME, because the router rejects anything outside it.
  projectDir = fs.mkdtempSync(path.join(os.homedir(), ".medusa-test-"));

  store = new SessionStore(path.join(tmpDir, "sessions.json"));
  const app = express();
  app.use(express.json());
  app.use(
    "/api/sessions",
    createSessionsRouter(store, new ProcessManager(), new ChatStore(tmpDir))
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions`;
});

afterEach(async () => {
  // Always tear the temp folders down, even if setup threw halfway.
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function post(body: unknown) {
  return fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(id: string, body: unknown) {
  return fetch(`${baseUrl}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/sessions", () => {
  it("requires workingDir", async () => {
    const res = await post({ name: "No folder" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/workingDir/);
  });

  it("rejects a folder outside the home directory", async () => {
    const res = await post({ workingDir: "/etc" });
    expect(res.status).toBe(400);
  });

  it("rejects a folder that does not exist", async () => {
    const res = await post({ workingDir: path.join(projectDir, "nope") });
    expect(res.status).toBe(400);
  });

  it("defaults the title to 'Chat' for the first auto-named chat", async () => {
    const res = await post({ workingDir: projectDir });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Chat");
    expect(body.autoNamed).toBe(true);
  });

  it("numbers subsequent auto-named chats sequentially", async () => {
    await post({ workingDir: projectDir });
    const second = await post({ workingDir: projectDir });
    expect((await second.json()).name).toBe("Chat 1");
    const third = await post({ workingDir: projectDir });
    expect((await third.json()).name).toBe("Chat 2");
  });

  it("does not mark an explicitly-titled chat as auto-named", async () => {
    const res = await post({ workingDir: projectDir, name: "My project" });
    const body = await res.json();
    expect(body.name).toBe("My project");
    expect(body.autoNamed).toBeUndefined();
  });

  it("does not count a manually-titled chat toward the running number", async () => {
    await post({ workingDir: projectDir, name: "Custom" });
    const res = await post({ workingDir: projectDir });
    expect((await res.json()).name).toBe("Chat");
  });

  it("stores engine, provider and model", async () => {
    const res = await post({
      workingDir: projectDir,
      name: "Medusa",
      engineId: "kimi",
      providerId: "openrouter",
      model: "sonnet",
    });
    const body = await res.json();
    expect(body).toMatchObject({
      name: "Medusa",
      workingDir: projectDir,
      engineId: "kimi",
      providerId: "openrouter",
      model: "sonnet",
    });
    expect(store.get(body.id)).toMatchObject({ engineId: "kimi", providerId: "openrouter" });
  });

  it("rejects an unknown engine", async () => {
    const res = await post({ workingDir: projectDir, engineId: "gpt-cli" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/engine/);
  });

  it("rejects an unknown provider", async () => {
    const res = await post({ workingDir: projectDir, providerId: "hal9000" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/provider/);
  });
});

describe("PATCH /api/sessions/:id", () => {
  async function makeSession(): Promise<string> {
    const res = await post({ workingDir: projectDir, name: "Medusa" });
    return (await res.json()).id as string;
  }

  it("requires at least one field", async () => {
    const res = await patch(await makeSession(), {});
    expect(res.status).toBe(400);
  });

  it("404s for an unknown chat", async () => {
    const res = await patch("does-not-exist", { name: "x" });
    expect(res.status).toBe(404);
  });

  it("renames a chat", async () => {
    const id = await makeSession();
    const res = await patch(id, { name: "Renamed" });
    expect((await res.json()).name).toBe("Renamed");
    expect(store.get(id)!.name).toBe("Renamed");
  });

  it("permanently clears autoNamed once a chat is manually renamed", async () => {
    // Create with no explicit title so it starts out auto-named.
    const created = await post({ workingDir: projectDir });
    const { id } = await created.json();
    expect(store.get(id)!.autoNamed).toBe(true);

    await patch(id, { name: "My renamed chat" });
    expect(store.get(id)!.autoNamed).toBeUndefined();

    // It must not count toward the running "Chat N" number afterward: with
    // zero auto-named chats left, the next one starts back at "Chat".
    const next = await post({ workingDir: projectDir });
    expect((await next.json()).name).toBe("Chat");
  });

  it("updates engine and provider", async () => {
    const id = await makeSession();
    const res = await patch(id, { engineId: "code-puppy", providerId: "kimi" });
    expect(await res.json()).toMatchObject({ engineId: "code-puppy", providerId: "kimi" });
  });

  it("clears engine and provider with null", async () => {
    const id = await makeSession();
    await patch(id, { engineId: "kimi", providerId: "kimi" });
    await patch(id, { engineId: null, providerId: null });
    expect(store.get(id)!.engineId).toBeUndefined();
    expect(store.get(id)!.providerId).toBeUndefined();
  });

  it("rejects an unknown engine", async () => {
    const res = await patch(await makeSession(), { engineId: "gpt-cli" });
    expect(res.status).toBe(400);
  });

  it("changes the folder and rejects a bad one", async () => {
    const id = await makeSession();
    const ok = await patch(id, { workingDir: os.homedir() });
    expect((await ok.json()).workingDir).toBe(os.homedir());
    const bad = await patch(id, { workingDir: "/etc" });
    expect(bad.status).toBe(400);
  });

  it("sets and clears the per-session model", async () => {
    const id = await makeSession();
    await patch(id, { model: "opus" });
    expect(store.get(id)!.model).toBe("opus");
    await patch(id, { model: null });
    expect(store.get(id)!.model).toBeUndefined();
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("removes the chat and 404s when it is gone", async () => {
    const id = (await (await post({ workingDir: projectDir })).json()).id as string;
    const res = await fetch(`${baseUrl}/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(store.get(id)).toBeUndefined();
    const again = await fetch(`${baseUrl}/${id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });
});

describe("GET /api/sessions", () => {
  it("lists the chats", async () => {
    await post({ workingDir: projectDir, name: "Medusa" });
    const body = await (await fetch(baseUrl)).json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Medusa");
  });
});
