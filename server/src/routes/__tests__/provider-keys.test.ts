import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Request, Response } from "express";

/**
 * Provider-keys routes (W8): GET /api/providers/keys, PUT/DELETE
 * /api/providers/:id/key, POST /api/providers/:id/verify.
 *
 * `settings/providers.ts` computes its settings-file path from
 * process.env.HOME at module load, so each test gets its own temp HOME and a
 * fresh module instance (vi.resetModules + dynamic import) rather than ever
 * touching the real ~/.claude-chat/settings.json.
 */

let home: string;
let prevHome: string | undefined;
const envKeys = ["OPENROUTER_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "DEEPGRAM_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string>> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let providersMod: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let routerMod: any;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findHandler(router: any, method: string, routePath: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === routePath && l.route?.methods?.[method]
  );
  if (!layer) throw new Error(`No route registered for ${method.toUpperCase()} ${routePath}`);
  // The verify route's stack is [handler] (no extra middleware layers), same
  // shape as the other routes, so the last handle is always the real one.
  const stack = layer.route.stack as Array<{ handle: (req: Request, res: Response) => unknown }>;
  return stack[stack.length - 1].handle;
}

beforeEach(async () => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-provider-keys-"));
  process.env.HOME = home;

  for (const k of envKeys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  vi.resetModules();
  providersMod = await import("../../settings/providers.js");
  routerMod = await import("../providers.js");
  routerMod._clearVerifyRateLimit();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("GET /api/providers/keys", () => {
  it("reports every managed provider as not set when nothing is configured", () => {
    const router = routerMod.createProvidersRouter();
    const handler = findHandler(router, "get", "/keys");
    const res = mockRes();
    handler({} as Request, res);
    const body = res.body as { providers: Array<{ id: string; hasKey: boolean; source: string }> };
    const ids = body.providers.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["openrouter", "gemini", "openai", "deepgram"]));
    for (const p of body.providers) {
      expect(p.hasKey).toBe(false);
      expect(p.source).toBe("none");
    }
  });

  it("reports source=env and a last4 when only an env var is set", () => {
    process.env.GEMINI_API_KEY = "env-key-secret-6789";
    const router = routerMod.createProvidersRouter();
    const handler = findHandler(router, "get", "/keys");
    const res = mockRes();
    handler({} as Request, res);
    const body = res.body as { providers: Array<{ id: string; hasKey: boolean; source: string; last4?: string }> };
    const gemini = body.providers.find((p) => p.id === "gemini")!;
    expect(gemini.hasKey).toBe(true);
    expect(gemini.source).toBe("env");
    expect(gemini.last4).toBe("6789");
    expect(JSON.stringify(body)).not.toContain("env-key-secret-6789");
  });
});

describe("PUT/DELETE /api/providers/:id/key", () => {
  it("stores a key in settings.json with 600 permissions, masked in the response", () => {
    const router = routerMod.createProvidersRouter();
    const putHandler = findHandler(router, "put", "/:id/key");
    const res = mockRes();
    putHandler({ params: { id: "gemini" }, body: { apiKey: "AIza-super-secret-1234" } } as unknown as Request, res);

    expect(res.statusCode ?? 200).toBe(200);
    const body = res.body as { hasKey: boolean; source: string; last4?: string };
    expect(body.hasKey).toBe(true);
    expect(body.source).toBe("settings");
    expect(body.last4).toBe("1234");
    expect(JSON.stringify(body)).not.toContain("AIza-super-secret-1234");

    const settingsPath = path.join(home, ".claude-chat", "settings.json");
    const stat = fs.statSync(settingsPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(settingsPath, "utf-8");
    expect(raw).toContain("AIza-super-secret-1234"); // it does live in the file itself
    expect(providersMod.resolveManagedProviderKey("gemini", "GEMINI_API_KEY")).toBe("AIza-super-secret-1234");
  });

  it("rejects an empty key", () => {
    const router = routerMod.createProvidersRouter();
    const putHandler = findHandler(router, "put", "/:id/key");
    const res = mockRes();
    putHandler({ params: { id: "gemini" }, body: { apiKey: "   " } } as unknown as Request, res);
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unmanaged provider id", () => {
    const router = routerMod.createProvidersRouter();
    const putHandler = findHandler(router, "put", "/:id/key");
    const res = mockRes();
    putHandler({ params: { id: "claude" }, body: { apiKey: "x" } } as unknown as Request, res);
    expect(res.statusCode).toBe(404);
  });

  it("removes a stored key", () => {
    providersMod.setProviderApiKey("openai", "sk-remove-me-0000");
    const router = routerMod.createProvidersRouter();
    const delHandler = findHandler(router, "delete", "/:id/key");
    const res = mockRes();
    delHandler({ params: { id: "openai" } } as unknown as Request, res);
    const body = res.body as { hasKey: boolean; source: string };
    expect(body.hasKey).toBe(false);
    expect(body.source).toBe("none");
    expect(providersMod.resolveManagedProviderKey("openai", "OPENAI_API_KEY")).toBeUndefined();
  });
});

describe("POST /api/providers/:id/verify", () => {
  it("reports ok and liveAudioModel for Gemini when a native-audio model is listed", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "models/gemini-2.5-flash-native-audio-latest" }] }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const router = routerMod.createProvidersRouter();
    const handler = findHandler(router, "post", "/:id/verify");
    const res = mockRes();
    await handler(
      { params: { id: "gemini" }, body: { apiKey: "test-gemini-key" }, ip: "1.2.3.4" } as unknown as Request,
      res
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com/v1beta/models?key=test-gemini-key")
    );
    const body = res.body as { ok: boolean; message: string; liveAudioModel?: boolean };
    expect(body.ok).toBe(true);
    expect(body.liveAudioModel).toBe(true);
    expect(body.message).toContain("Live audio model available");
  });

  it("reports failure when the upstream call is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;
    const router = routerMod.createProvidersRouter();
    const handler = findHandler(router, "post", "/:id/verify");
    const res = mockRes();
    await handler(
      { params: { id: "openrouter" }, body: { apiKey: "bad-key" }, ip: "1.2.3.4" } as unknown as Request,
      res
    );
    const body = res.body as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("401");
  });

  it("400s when there is no key to verify", async () => {
    const router = routerMod.createProvidersRouter();
    const handler = findHandler(router, "post", "/:id/verify");
    const res = mockRes();
    await handler({ params: { id: "deepgram" }, body: {}, ip: "9.9.9.9" } as unknown as Request, res);
    expect(res.statusCode).toBe(400);
  });

  it("rate limits after 10 calls per minute from the same caller", async () => {
    const router = routerMod.createProvidersRouter();
    const handler = findHandler(router, "post", "/:id/verify");
    const req = { params: { id: "deepgram" }, body: {}, ip: "5.5.5.5" } as unknown as Request;

    let lastStatus: number | undefined;
    for (let i = 0; i < 11; i++) {
      const res = mockRes();
      await handler(req, res);
      lastStatus = res.statusCode ?? 200;
    }
    expect(lastStatus).toBe(429);
  });
});
