import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import {
  createScreenshotRouter,
  pngDimensions,
  ScreenshotError,
  type CaptureFn,
} from "../screenshot.js";
import config from "../../config.js";

/**
 * Route tests for POST /api/screenshot. `screencapture` itself is never
 * spawned here: a fake `CaptureFn` is injected instead, so these tests are
 * fast and work in CI with no Screen Recording permission at all. The real
 * `screencapture` invocation is covered by the manual end-to-end check
 * described in CHANGELOG.md.
 */

let tmpDir: string;
let server: Server;
let baseUrl: string;
let originalUploadsDir: string;

// A minimal but valid 1x1 PNG (the smallest real PNG file), used so
// pngDimensions() has real bytes to parse.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function startServer(capture: CaptureFn): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api/screenshot", createScreenshotRouter({ capture }));
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/screenshot`;
      resolve();
    });
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-screenshot-test-"));
  originalUploadsDir = config.uploadsDir;
  config.uploadsDir = path.join(tmpDir, "uploads");
});

afterEach(async () => {
  config.uploadsDir = originalUploadsDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe("pngDimensions", () => {
  it("reads width and height from the IHDR chunk", () => {
    expect(pngDimensions(ONE_PIXEL_PNG)).toEqual({ width: 1, height: 1 });
  });

  it("rejects a buffer that is not a PNG", () => {
    expect(() => pngDimensions(Buffer.from("not a png"))).toThrow("Not a PNG file");
  });
});

describe("POST /api/screenshot", () => {
  it("captures fullscreen by default, saves to uploadsDir, and reports dimensions", async () => {
    const capture = vi.fn<CaptureFn>(async (_target, destPath) => {
      fs.writeFileSync(destPath, ONE_PIXEL_PNG);
    });
    await startServer(capture);

    const res = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      filePath: string;
      absolutePath: string;
      width: number;
      height: number;
      target: string;
      format: string;
    };
    expect(body.width).toBe(1);
    expect(body.height).toBe(1);
    expect(body.target).toBe("fullscreen");
    expect(body.format).toBe("png");
    expect(body.filePath).toMatch(/^\/uploads\/.+\.png$/);
    expect(fs.existsSync(body.absolutePath)).toBe(true);
    expect(capture).toHaveBeenCalledWith("fullscreen", expect.any(String));
  });

  it("passes target through to the capture function", async () => {
    const capture = vi.fn<CaptureFn>(async (_target, destPath) => {
      fs.writeFileSync(destPath, ONE_PIXEL_PNG);
    });
    await startServer(capture);

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "window" }),
    });
    expect(res.status).toBe(200);
    expect(capture).toHaveBeenCalledWith("window", expect.any(String));
  });

  it("rejects an invalid target", async () => {
    await startServer(async () => {});
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "not-a-real-target" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns a clear 403 permission message when screencapture writes nothing", async () => {
    // The classic signature of a missing Screen Recording grant: the command
    // exits without error but produces no file at all.
    const capture: CaptureFn = async () => {};
    await startServer(capture);

    const res = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; kind: string };
    expect(body.kind).toBe("permission");
    expect(body.error).toContain("Screen Recording permission needed for medusa-server");
    expect(body.error).toContain("System Settings");
  });

  it("surfaces a ScreenshotError from the capture function with its own status", async () => {
    const capture: CaptureFn = async () => {
      throw new ScreenshotError("Timed out waiting for the interactive selection.", "cancelled");
    };
    await startServer(capture);

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "region" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; kind: string };
    expect(body.kind).toBe("cancelled");
    expect(body.error).toContain("Timed out");
  });

  it("reports unsupported platforms distinctly (501)", async () => {
    const capture: CaptureFn = async () => {
      throw new ScreenshotError(
        "screencapture is not available (this is a macOS-only tool).",
        "unsupported"
      );
    };
    await startServer(capture);

    const res = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(501);
  });
});
