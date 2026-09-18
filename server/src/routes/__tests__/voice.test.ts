import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../voice/providers.js", () => ({
  listProviders: () => [
    { id: "whisper", role: "stt", enabled: true, ready: true },
    { id: "kokoro", role: "tts", enabled: true, ready: true },
  ],
  // S16 added a live-mode section to the same payload; the route calls this
  // unconditionally, so the mock has to answer it too.
  listRealtimeProviders: () => [{ id: "openai-realtime", enabled: false, ready: false }],
  // S17: the route also asks which tier a new voice session would get, which
  // means resolving realtime providers. No key in a test run, so none resolve
  // and the reported tier is the local pipeline.
  getRealtimeProvider: () => null,
}));

const fakeEvents = [{ ts: 1, type: "barge-in", detail: { energy: 5000, ms: 300 } }];

vi.mock("../../socket/voice-handlers.js", () => ({
  listVoiceSessions: () => [{ sessionId: "s1", state: "listening", mode: "always-on" }],
  getVoiceSession: (id: string) =>
    id === "s1" ? { getEvents: () => fakeEvents } : undefined,
}));

/** Find a route handler on the router by method + path, without needing supertest. */
function findHandler(router: unknown, method: string, path: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.[method]
  );
  if (!layer) throw new Error(`No route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle as (req: Request, res: Response) => unknown;
}

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as Response;
  }) as unknown as Response["json"];
  return res as Response & { statusCode?: number; body?: unknown };
}

describe("GET /api/voice/status", () => {
  it("reports the barge-in defaults alongside the VAD defaults", async () => {
    const router = (await import("../voice.js")).default;
    const handler = findHandler(router, "get", "/status");
    const res = mockRes();
    handler({ query: {} } as unknown as Request, res);
    const body = res.body as { defaults: { bargeIn: { bargeInEnergyThreshold: number } } };
    expect(body.defaults.bargeIn.bargeInEnergyThreshold).toBe(2000);
    expect(body).not.toHaveProperty("events");
  });

  it("includes the per-session event ring buffer only when ?events=1", async () => {
    const router = (await import("../voice.js")).default;
    const handler = findHandler(router, "get", "/status");
    const res = mockRes();
    handler({ query: { events: "1" } } as unknown as Request, res);
    const body = res.body as { events: Record<string, unknown> };
    expect(body.events.s1).toEqual(fakeEvents);
  });
});
