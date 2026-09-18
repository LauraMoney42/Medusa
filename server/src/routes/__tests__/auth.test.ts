import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import http from "http";

/**
 * These tests exercise the real /api/auth/login route (including its
 * express-rate-limit middleware) over an actual HTTP server, rather than
 * calling the handler function directly, because the behavior under test
 * (skipSuccessfulRequests, the loopback+correct-token skip()) lives in the
 * middleware, not the handler.
 */
async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  // createAuthRouter is re-imported fresh per test (see beforeEach) so each
  // test gets its own rate-limit counters instead of sharing state.
  const { createAuthRouter } = await import("../auth.js");
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter());
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function postLogin(url: string, token: string) {
  return fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

describe("POST /api/auth/login rate limiting", () => {
  const originalEnvToken = process.env.AUTH_TOKEN;

  beforeEach(() => {
    // config.ts reads AUTH_TOKEN from process.env at module-eval time and its
    // own dotenv.config() call never overrides an already-set env var, so
    // setting this before the fresh import below is what actually reaches
    // the freshly re-evaluated config module (mutating a stale `config`
    // object reference would not, since resetModules gives auth.ts its own
    // new copy of config.js). resetModules also gives each test its own
    // rate-limiter instance, so attempt counts never bleed across tests.
    process.env.AUTH_TOKEN = "correct-token-abc123";
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnvToken === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = originalEnvToken;
  });

  it("does not count a successful login against the attempt budget", async () => {
    const { url, close } = await startServer();
    try {
      // 5 successful logins in a row must all succeed -- none of them should
      // be counted toward the 5-per-window limit (skipSuccessfulRequests).
      for (let i = 0; i < 5; i++) {
        const res = await postLogin(url, "correct-token-abc123");
        expect(res.status).toBe(200);
      }
      // A 6th correct login should still succeed -- if successful logins
      // were being counted, this would already be throttled (429).
      const res = await postLogin(url, "correct-token-abc123");
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("still throttles repeated wrong-token attempts", async () => {
    const { url, close } = await startServer();
    try {
      let last: Response | undefined;
      for (let i = 0; i < 6; i++) {
        last = await postLogin(url, "wrong-token");
      }
      expect(last!.status).toBe(429);
    } finally {
      await close();
    }
  });

  it("never throttles a loopback request presenting the correct token, even after failures exhaust the budget", async () => {
    const { url, close } = await startServer();
    try {
      // Burn through the whole failed-attempt budget from the same (loopback) IP.
      for (let i = 0; i < 5; i++) {
        const res = await postLogin(url, "wrong-token");
        expect(res.status).toBe(401);
      }
      // Confirm the budget really is exhausted for a subsequent wrong attempt.
      const throttled = await postLogin(url, "wrong-token");
      expect(throttled.status).toBe(429);

      // But the desktop shell's own correct-token login (loopback + right
      // token) must still get through -- this is the skip() path.
      const correct = await postLogin(url, "correct-token-abc123");
      expect(correct.status).toBe(200);
    } finally {
      await close();
    }
  });
});
