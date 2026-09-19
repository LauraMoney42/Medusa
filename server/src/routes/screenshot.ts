import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import config from "../config.js";

/**
 * The HTTP surface the `medusa` MCP shim calls for `take_screenshot`.
 *
 * The capture itself runs `screencapture` (a stock macOS CLI, no extra
 * native deps) directly from this server process. That is the same
 * per-process permission model the codebase already uses for microphone
 * input: whichever process invokes `screencapture` needs Screen Recording
 * permission granted to it once in System Settings > Privacy & Security >
 * Screen Recording, exactly like the mic prompt. The alternative (proxy
 * through the Tauri shell over a new IPC path) adds a whole extra hop and a
 * new desktop <-> server protocol for no real benefit: this server process
 * already runs on the user's machine as the Tauri sidecar, so it can call
 * `screencapture` itself, and manual testing in this environment (see
 * CHANGELOG) confirms a plain Node/Bun child process can invoke it
 * successfully once the parent process holds the permission.
 */

export type ScreenshotTarget = "fullscreen" | "window" | "region";

export class ScreenshotError extends Error {
  constructor(
    message: string,
    public readonly kind: "permission" | "cancelled" | "unavailable" | "unsupported"
  ) {
    super(message);
    this.name = "ScreenshotError";
  }
}

/** Runs `screencapture`, writing a PNG to `destPath`. Throws ScreenshotError on failure. */
export type CaptureFn = (target: ScreenshotTarget, destPath: string) => Promise<void>;

function argsFor(target: ScreenshotTarget, destPath: string): string[] {
  switch (target) {
    // Interactive window picker: the caller (a human at the machine) must
    // click a window. Best-effort, per the tool's contract.
    case "window":
      return ["-i", "-w", destPath];
    // Interactive drag-to-select region. Same caveat as window.
    case "region":
      return ["-i", destPath];
    case "fullscreen":
    default:
      // -x: silent, no camera-shutter sound, no cursor.
      return ["-x", destPath];
  }
}

/** Real capture: shells out to the macOS `screencapture` CLI. */
export const realCapture: CaptureFn = (target, destPath) =>
  new Promise((resolve, reject) => {
    // fullscreen must always work and never blocks on user input, so it gets
    // a short timeout. window/region wait on an interactive click/drag, so
    // they get a longer one before we give up and report a clear timeout.
    const timeout = target === "fullscreen" ? 10_000 : 30_000;
    execFile("screencapture", argsFor(target, destPath), { timeout }, (err) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new ScreenshotError(
              "screencapture is not available (this is a macOS-only tool).",
              "unsupported"
            )
          );
          return;
        }
        if (err.killed || (err as { signal?: string }).signal === "SIGTERM") {
          reject(
            new ScreenshotError(
              target === "fullscreen"
                ? "screencapture timed out."
                : "Timed out waiting for the interactive selection.",
              "cancelled"
            )
          );
          return;
        }
        reject(new ScreenshotError(`screencapture failed: ${err.message}`, "unavailable"));
        return;
      }
      resolve();
    });
  });

/** Minimal PNG IHDR reader: width/height live at fixed byte offsets. */
export function pngDimensions(buf: Buffer): { width: number; height: number } {
  const isPng =
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;
  if (!isPng) throw new Error("Not a PNG file");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export interface ScreenshotRouterDeps {
  capture?: CaptureFn;
}

export function createScreenshotRouter(deps: ScreenshotRouterDeps = {}): Router {
  const capture = deps.capture ?? realCapture;
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { target?: unknown };
    const rawTarget = typeof body.target === "string" ? body.target : "fullscreen";
    if (!["fullscreen", "window", "region"].includes(rawTarget)) {
      res.status(400).json({ error: `Invalid target: ${rawTarget}` });
      return;
    }
    const target = rawTarget as ScreenshotTarget;

    if (!fs.existsSync(config.uploadsDir)) {
      fs.mkdirSync(config.uploadsDir, { recursive: true });
    }

    const tmpPath = path.join(os.tmpdir(), `medusa-screenshot-${uuidv4()}.png`);

    try {
      await capture(target, tmpPath);

      if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
        // screencapture can exit 0 while writing nothing at all: the classic
        // signature of a Screen Recording permission that was never granted.
        throw new ScreenshotError(
          "Screen Recording permission needed for medusa-server. Open System " +
            "Settings > Privacy & Security > Screen Recording, enable it for " +
            "medusa-server (or the app running this server), then try again.",
          "permission"
        );
      }

      const bytes = fs.readFileSync(tmpPath);
      let width: number;
      let height: number;
      try {
        ({ width, height } = pngDimensions(bytes));
      } catch {
        throw new ScreenshotError(
          "screencapture produced a file that is not a valid PNG.",
          "unavailable"
        );
      }

      const filename = `${uuidv4()}.png`;
      const destPath = path.join(config.uploadsDir, filename);
      fs.copyFileSync(tmpPath, destPath);
      fs.unlinkSync(tmpPath);

      res.json({
        filePath: `/uploads/${filename}`,
        absolutePath: destPath,
        width,
        height,
        target,
        format: "png",
      });
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      if (err instanceof ScreenshotError) {
        const status = err.kind === "permission" ? 403 : err.kind === "unsupported" ? 501 : 502;
        res.status(status).json({ error: err.message, kind: err.kind });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}

export default createScreenshotRouter;
