import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response } from "express";
import { createProvidersRouter } from "../providers.js";
import { _clearModelCache } from "../../settings/providers.js";

/** Find a route handler on the router by method + path, without needing supertest. */
function findHandler(router: ReturnType<typeof createProvidersRouter>, method: string, path: string) {
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

describe("GET /api/providers", () => {
  it("lists the registered providers without secrets", () => {
    const router = createProvidersRouter();
    const handler = findHandler(router, "get", "/");
    const res = mockRes();
    handler({} as Request, res);
    const body = res.body as { providers: Array<{ id: string }> };
    const ids = body.providers.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["claude", "kimi", "openrouter"]));
    expect(JSON.stringify(body)).not.toContain("test-openrouter-key");
  });
});

describe("GET /api/providers/:id/models", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    _clearModelCache();
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    _clearModelCache();
  });

  it("returns 404 for an unknown provider", async () => {
    const router = createProvidersRouter();
    const handler = findHandler(router, "get", "/:id/models");
    const res = mockRes();
    await handler({ params: { id: "does-not-exist" } } as unknown as Request, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns the live model list from a mocked fetch for openrouter", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "google/gemini-3-pro", name: "Gemini 3 Pro" }] }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const router = createProvidersRouter();
    const handler = findHandler(router, "get", "/:id/models");
    const res = mockRes();
    await handler({ params: { id: "openrouter" } } as unknown as Request, res);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer test-openrouter-key" } })
    );
    const body = res.body as { providerId: string; models: Array<{ id: string }> };
    expect(body.providerId).toBe("openrouter");
    expect(body.models).toEqual([{ id: "google/gemini-3-pro", displayName: "Gemini 3 Pro" }]);
  });

  it("returns the static list for claude", async () => {
    const router = createProvidersRouter();
    const handler = findHandler(router, "get", "/:id/models");
    const res = mockRes();
    await handler({ params: { id: "claude" } } as unknown as Request, res);
    const body = res.body as { models: Array<{ id: string }> };
    expect(body.models.length).toBeGreaterThan(0);
  });
});
