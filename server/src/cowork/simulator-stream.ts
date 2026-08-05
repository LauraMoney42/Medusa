// simulator-stream.ts
// -----------------------------------------------------------------------------
// Live view of a booted iOS Simulator, streamed to Socket.IO clients, with
// input take-over (tap/swipe/text/hardware-button), using Facebook's `idb` CLI.
//
// This is the iOS-Simulator sibling of `screencast.ts` (which streams a
// CDP-controlled Chrome tab). Where screencast.ts speaks CDP over a WebSocket,
// this module shells out to the `idb` binary (already installed at
// /opt/homebrew/bin/idb on this machine) and polls for screenshots, since idb
// has no push-based frame stream of its own.
//
// Node 22 / ESM. No npm dependencies — only Node builtins (`child_process`,
// `fs/promises`, `os`, `path`) plus the `socket.io` TYPE import (type-only,
// erased at build time, so it does not count as a runtime dependency here).
//
// Socket.IO events emitted:
//   - "simulator:status" SimulatorStatus
//   - "simulator:frame"  string  (base64-encoded PNG frame data)
//
// -----------------------------------------------------------------------------
// IMPORTANT — POINT SPACE vs PIXEL SPACE
// -----------------------------------------------------------------------------
// `idb screenshot` produces a PNG whose dimensions are the simulator's PIXEL
// resolution (e.g. 1320x2868 on an iPhone with a 3x Retina display). But
// `idb ui tap` / `idb ui swipe` take coordinates in POINT space (e.g.
// 440x956 for that same device) — the same logical coordinate space UIKit
// and Xcode work in. Points are pixels divided by the device's scale factor
// (`density` in `idb describe`'s JSON, e.g. 3.0).
//
// If we naively multiplied normalized [0,1] client coordinates by the
// screenshot's pixel dimensions and fed that straight to `idb ui tap`, every
// tap would land at 3x the intended position (off the bottom-right of the
// screen for most taps). So everywhere in this file that converts a
// normalized coordinate to a device coordinate for TAP/SWIPE, we must use
// `width_points` / `height_points` (from `idb describe --json`), never the
// raw screenshot's pixel width/height. The pixel dimensions are only
// relevant to how the PNG frame is rendered in the client's <img>/<canvas>,
// not to where idb should touch the screen.
// -----------------------------------------------------------------------------

import type { Server as IOServer } from "socket.io";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// Path to the `idb` CLI binary. Confirmed installed at this fixed path.
const IDB_BIN = "/opt/homebrew/bin/idb";

// Reused temp file for every screenshot poll — no need for a fresh path each
// tick, we just overwrite it and read it back.
const FRAME_PATH = join(tmpdir(), "medusa-sim-frame.png");

// How often to poll for a fresh screenshot.
const POLL_INTERVAL_MS = 900;

// How many consecutive failed poll iterations before we give up and report
// the simulator as disconnected.
const MAX_CONSECUTIVE_FAILURES = 5;

// --- Public types --------------------------------------------------------

export interface SimulatorStatus {
  available: boolean;
  message?: string;
  deviceName?: string;
}

// Input forwarded from a client's Cowork pane for supervised take-over of the
// simulator. Tap/swipe coordinates are normalized [0,1] against the visible
// frame content — see the point-vs-pixel note at the top of this file for how
// they get converted to real device coordinates before being sent to idb.
export type SimulatorInput =
  | { kind: "tap"; nx: number; ny: number }
  | { kind: "swipe"; nx1: number; ny1: number; nx2: number; ny2: number }
  | { kind: "text"; text: string }
  | { kind: "button"; name: "HOME" | "LOCK" | "SIRI" | "SIDE_BUTTON" };

// --- Module state ----------------------------------------------------------
// Whether a stream session is currently active (booted device found + polling).
let active = false;
// UDID of the simulator we are streaming/controlling, or null when inactive.
let udid: string | null = null;
// Human-readable device name, for status messages.
let deviceName: string | null = null;
// POINT-space screen dimensions (NOT pixels — see note above). Needed to
// convert normalized tap/swipe coordinates to device coordinates.
let widthPoints: number | null = null;
let heightPoints: number | null = null;
// Handle for the setInterval driving the screenshot poll loop.
let pollHandle: ReturnType<typeof setInterval> | null = null;
// Count of consecutive failed poll iterations, reset to 0 on any success.
let consecutiveFailures = 0;

// --- Shape of the `idb describe --json` output we actually read ------------
interface IdbScreenDimensions {
  width_points: number;
  height_points: number;
}

interface IdbDescribeResult {
  screen_dimensions: IdbScreenDimensions;
}

// Narrow an `unknown` (from JSON.parse) into IdbDescribeResult, without `any`.
function parseIdbDescribe(json: unknown): IdbDescribeResult | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  const dims = obj.screen_dimensions;
  if (typeof dims !== "object" || dims === null) return null;
  const d = dims as Record<string, unknown>;
  if (typeof d.width_points !== "number" || typeof d.height_points !== "number") {
    return null;
  }
  return { screen_dimensions: { width_points: d.width_points, height_points: d.height_points } };
}

// Parsed row from `idb list-targets` output.
interface IdbTarget {
  name: string;
  udid: string;
  state: string;
  targetType: string;
}

// Parse one line of `idb list-targets` output, e.g.:
//   "Narrator Test | 4A53565B-... | Booted | simulator | iOS 26.2 | x86_64 | No Companion Connected"
function parseTargetLine(line: string): IdbTarget | null {
  const fields = line.split("|").map((f) => f.trim());
  if (fields.length < 4) return null;
  const [name, targetUdid, state, targetType] = fields;
  if (!name || !targetUdid || !state || !targetType) return null;
  return { name, udid: targetUdid, state, targetType };
}

/**
 * Reset all module state to "inactive". Shared by stopSimulatorStream() and
 * internal error paths so we never leave stale udid/dimensions lying around.
 */
function resetState(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
  }
  active = false;
  udid = null;
  deviceName = null;
  widthPoints = null;
  heightPoints = null;
  pollHandle = null;
  consecutiveFailures = 0;
}

/**
 * Start streaming a live view of the currently booted iOS Simulator.
 *
 * Never throws: any failure (idb missing, no booted simulator, describe
 * failing) is reported to clients via a "simulator:status" event with
 * `available: false`, and the function simply returns.
 */
export async function startSimulatorStream(io: IOServer): Promise<void> {
  // 1. If we're already streaming, do nothing (matches screencast.ts's guard).
  if (active) {
    return;
  }

  try {
    // 2. Discover booted simulators via `idb list-targets`.
    const { stdout } = await execFileAsync(IDB_BIN, ["list-targets"]);
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);

    // Find the first booted simulator target (in list order). Multiple
    // booted devices (e.g. an iOS sim + a paired watchOS sim) can appear;
    // we deliberately don't filter by os_version, just target_type, per spec.
    let target: IdbTarget | null = null;
    for (const line of lines) {
      const parsed = parseTargetLine(line);
      if (parsed && parsed.state === "Booted" && parsed.targetType === "simulator") {
        target = parsed;
        break;
      }
    }

    // 3. No booted simulator => report unavailable and bail (do NOT throw).
    if (!target) {
      io.emit("simulator:status", {
        available: false,
        message: "No booted iOS Simulator found. Boot one via Xcode or the Simulator app.",
      });
      return;
    }

    // 4. Fetch the device's screen dimensions (pixel + POINT space) so we can
    //    later convert normalized tap/swipe coordinates to POINT coordinates
    //    (see the point-vs-pixel note at the top of this file).
    const { stdout: describeOut } = await execFileAsync(IDB_BIN, [
      "describe",
      "--udid",
      target.udid,
      "--json",
    ]);
    const parsedJson: unknown = JSON.parse(describeOut);
    const describe = parseIdbDescribe(parsedJson);

    if (!describe) {
      io.emit("simulator:status", {
        available: false,
        message: "Could not read simulator screen dimensions from idb describe.",
      });
      return;
    }

    // 5. Commit module state and tell clients the view is available.
    udid = target.udid;
    deviceName = target.name;
    widthPoints = describe.screen_dimensions.width_points;
    heightPoints = describe.screen_dimensions.height_points;
    active = true;
    consecutiveFailures = 0;

    io.emit("simulator:status", { available: true, deviceName: target.name });
    console.log(`[simulator] Stream started for "${target.name}" (${target.udid}).`);

    // 6. Poll for screenshots on a fixed interval and relay them as base64 PNG
    //    frames. A single failed iteration is skipped (device briefly busy);
    //    MAX_CONSECUTIVE_FAILURES in a row means the simulator likely
    //    shut down or disconnected, so we stop the stream entirely.
    pollHandle = setInterval(() => {
      void (async (): Promise<void> => {
        if (!udid) return;
        try {
          await execFileAsync(IDB_BIN, ["screenshot", FRAME_PATH, "--udid", udid]);
          const buf = await readFile(FRAME_PATH);
          io.emit("simulator:frame", buf.toString("base64"));
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures += 1;
          console.warn(
            `[simulator] Screenshot poll failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
            err
          );
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error("[simulator] Too many consecutive failures, stopping stream.");
            resetState();
            io.emit("simulator:status", {
              available: false,
              message: "Simulator disconnected.",
            });
          }
        }
      })();
    }, POLL_INTERVAL_MS);
  } catch (err) {
    // 7. Any synchronous/await failure (e.g. idb not found, bad JSON) lands
    //    here. Never throw out of this function.
    console.error("[simulator] Failed to start simulator stream:", err);
    io.emit("simulator:status", {
      available: false,
      message: "Could not query the iOS Simulator via idb. Is idb installed and a simulator running?",
    });
  }
}

/**
 * Stop the current simulator stream (if any) and clean up module state.
 * Best-effort: never throws.
 */
export function stopSimulatorStream(): void {
  resetState();
  console.log("[simulator] Stream stopped.");
}

/** Whether a simulator stream session is currently active. */
export function isSimulatorStreamActive(): boolean {
  return active;
}

/**
 * Forward a user input event from the Cowork pane to the live simulator
 * (supervised take-over). No-op unless a stream is active and we have a
 * UDID + POINT-space dimensions on hand. Fire-and-forget: callers do not
 * need to await this or handle rejections — failures are logged internally.
 */
export function sendSimulatorInput(input: SimulatorInput): void {
  if (!active || !udid || widthPoints === null || heightPoints === null) {
    return;
  }
  // Fire-and-forget: dispatch async, swallow/log any failure ourselves so
  // this function never throws synchronously nor returns a rejected promise
  // for the caller to deal with.
  void dispatchInput(input).catch((err: unknown) => {
    console.error("[simulator] Input dispatch failed:", err);
  });
}

/**
 * Actually run the idb command for a given input event. Coordinates are
 * converted from normalized [0,1] client space to POINT space (NOT pixel
 * space — see the note at the top of this file) using the widthPoints /
 * heightPoints captured from `idb describe` at stream-start time.
 */
async function dispatchInput(input: SimulatorInput): Promise<void> {
  if (!udid || widthPoints === null || heightPoints === null) return;
  const targetUdid = udid;

  try {
    if (input.kind === "tap") {
      const x = Math.round(input.nx * widthPoints);
      const y = Math.round(input.ny * heightPoints);
      await execFileAsync(IDB_BIN, ["ui", "tap", String(x), String(y), "--udid", targetUdid]);
    } else if (input.kind === "swipe") {
      const x1 = Math.round(input.nx1 * widthPoints);
      const y1 = Math.round(input.ny1 * heightPoints);
      const x2 = Math.round(input.nx2 * widthPoints);
      const y2 = Math.round(input.ny2 * heightPoints);
      await execFileAsync(IDB_BIN, [
        "ui",
        "swipe",
        String(x1),
        String(y1),
        String(x2),
        String(y2),
        "--udid",
        targetUdid,
      ]);
    } else if (input.kind === "text") {
      // Pass input.text as its own array element (never interpolated into a
      // shell string) so arbitrary characters — quotes, backticks, `$(...)`,
      // etc. — can never be interpreted as shell syntax. execFile does not
      // spawn a shell, so this is safe by construction.
      await execFileAsync(IDB_BIN, ["ui", "text", input.text, "--udid", targetUdid]);
    } else if (input.kind === "button") {
      await execFileAsync(IDB_BIN, ["ui", "button", input.name, "--udid", targetUdid]);
    }
  } catch (err) {
    console.error(`[simulator] idb ui command failed for input kind "${input.kind}":`, err);
  }
}
