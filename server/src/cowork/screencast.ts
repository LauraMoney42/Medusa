// screencast.ts
// -----------------------------------------------------------------------------
// Live, READ-ONLY screencast of a CDP-controlled Chrome to Socket.IO clients.
//
// Powers the "watch the browser" pane (Claude Cowork style). We connect to a
// Chrome instance started with `--remote-debugging-port=9222`, drive it over the
// Chrome DevTools Protocol (CDP) via WebSocket, and forward JPEG frames from
// `Page.startScreencast` to Socket.IO clients as base64 strings.
//
// This version is strictly read-only: we never forward mouse/keyboard input to
// the browser. We only observe and relay frames.
//
// Node 22 / ESM. Uses the GLOBAL `fetch` and GLOBAL `WebSocket` that Node 22
// provides, so there are NO npm dependencies and no local imports here.
//
// Socket.IO events emitted:
//   - "cowork:status" { available: boolean; message?: string }
//   - "cowork:frame"  string  (base64-encoded JPEG frame data)
// -----------------------------------------------------------------------------

import type { Server as IOServer } from "socket.io";

// --- Module state ------------------------------------------------------------
// The live CDP WebSocket, or null when we are not connected.
let ws: WebSocket | null = null;
// Whether a screencast session is currently active (open + streaming).
let active = false;
// Monotonic CDP message id counter. Each CDP command must carry a unique id.
let messageId = 0;
// Reference to the active socket's send() helper, for forwarding user input.
let sendCmd: ((method: string, params?: Record<string, unknown>) => void) | null = null;
// Last screencast frame metadata — used to map normalized input coords to CSS px.
let lastMeta: { deviceWidth: number; deviceHeight: number; offsetTop: number } | null = null;

// --- Types describing the small slices of CDP data we actually read ----------

// Shape of an entry returned by GET /json (the CDP target list).
interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

// Shape of the CDP events we care about coming back over the WebSocket.
interface CdpMessage {
  method?: string;
  params?: {
    data?: string;
    sessionId?: number;
    metadata?: {
      deviceWidth?: number;
      deviceHeight?: number;
      offsetTop?: number;
      pageScaleFactor?: number;
    };
  };
}

// Input forwarded from a client's Cowork pane for supervised take-over.
// Coordinates are normalized [0,1] against the visible frame content.
export type CoworkInput =
  | {
      kind: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved";
      nx: number;
      ny: number;
      button?: "left" | "right" | "middle" | "none";
      clickCount?: number;
    }
  | { kind: "wheel"; nx: number; ny: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | {
      kind: "key";
      type: "keyDown" | "keyUp";
      key: string;
      code?: string;
      windowsVirtualKeyCode?: number;
    };

/**
 * Start streaming a live read-only view of the CDP-controlled Chrome.
 *
 * Never throws: any failure (browser not running, bad target, connection error)
 * is reported to clients via a "cowork:status" event with `available: false`.
 */
export async function startScreencast(io: IOServer): Promise<void> {
  // 1. If we are already streaming, do nothing.
  if (active) {
    return;
  }

  try {
    // 2. Discover the CDP page target we want to attach to.
    //    GET /json returns the list of debuggable targets (tabs, workers, etc).
    const res = await fetch("http://127.0.0.1:9222/json");
    const targets = (await res.json()) as CdpTarget[];

    // Find the first actual page target that exposes a debugger WebSocket URL.
    const target = targets.find(
      (t) => t.type === "page" && Boolean(t.webSocketDebuggerUrl)
    );

    // 3. No suitable target => report unavailable and bail (do NOT throw).
    if (!target || !target.webSocketDebuggerUrl) {
      io.emit("cowork:status", {
        available: false,
        message:
          "Automation browser not running on :9222. Launch Chrome with --remote-debugging-port=9222.",
      });
      return;
    }

    // 4. Open the CDP WebSocket and reset the message id counter.
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    ws = socket;
    messageId = 0;

    // Helper: send a CDP command with a fresh id.
    const send = (method: string, params?: Record<string, unknown>): void => {
      socket.send(JSON.stringify({ id: ++messageId, method, params }));
    };

    // 5. Once the socket is open, enable the Page domain and start the
    //    screencast. Then tell clients the view is available.
    socket.onopen = (): void => {
      try {
        active = true;
        sendCmd = send;
        send("Page.enable");
        send("Page.startScreencast", {
          format: "jpeg",
          quality: 60,
          maxWidth: 1280,
          maxHeight: 720,
          everyNthFrame: 1,
        });
        io.emit("cowork:status", { available: true });
        console.log("[cowork] Screencast started.");
      } catch (err) {
        console.error("[cowork] Failed during screencast open handler:", err);
        io.emit("cowork:status", {
          available: false,
          message: "Browser view disconnected.",
        });
      }
    };

    // 6. On each incoming message, relay screencast frames to clients and ack
    //    them so Chrome keeps sending more. `ev.data` is a string in Node's ws.
    socket.onmessage = (ev: { data: unknown }): void => {
      try {
        // Cast to string defensively before parsing.
        const msg = JSON.parse(String(ev.data)) as CdpMessage;

        if (msg.method === "Page.screencastFrame" && msg.params?.data) {
          // Track frame metadata so input coords can be mapped to CSS pixels.
          const m = msg.params.metadata;
          if (m && m.deviceWidth && m.deviceHeight) {
            lastMeta = {
              deviceWidth: m.deviceWidth,
              deviceHeight: m.deviceHeight,
              offsetTop: m.offsetTop ?? 0,
            };
          }
          // Forward the base64 JPEG frame to all connected clients.
          io.emit("cowork:frame", msg.params.data);
          // Acknowledge so Chrome sends the next frame.
          send("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
        }
      } catch (err) {
        console.error("[cowork] Failed to handle CDP message:", err);
      }
    };

    // 7. On error or close, tear down state and notify clients.
    socket.onerror = (): void => {
      console.error("[cowork] Screencast WebSocket error.");
      active = false;
      ws = null;
      sendCmd = null;
      lastMeta = null;
      io.emit("cowork:status", {
        available: false,
        message: "Browser view disconnected.",
      });
    };

    socket.onclose = (): void => {
      console.log("[cowork] Screencast WebSocket closed.");
      active = false;
      ws = null;
      sendCmd = null;
      lastMeta = null;
      io.emit("cowork:status", {
        available: false,
        message: "Browser view disconnected.",
      });
    };
  } catch (err) {
    // 8. Any synchronous/await failure (e.g. fetch threw) lands here.
    console.error("[cowork] Failed to start screencast:", err);
    io.emit("cowork:status", {
      available: false,
      message:
        "Automation browser not running on :9222. Launch Chrome with --remote-debugging-port=9222.",
    });
  }
}

/**
 * Stop the current screencast (if any) and clean up module state.
 * Best-effort: swallows errors from the socket teardown.
 */
export function stopScreencast(): void {
  if (ws) {
    try {
      // Ask Chrome to stop sending frames, then close the socket.
      ws.send(
        JSON.stringify({ id: ++messageId, method: "Page.stopScreencast" })
      );
      ws.close();
    } catch (err) {
      console.error("[cowork] Failed to stop screencast cleanly:", err);
    }
  }
  active = false;
  ws = null;
  sendCmd = null;
  lastMeta = null;
}

/** Whether a screencast session is currently active. */
export function isScreencastActive(): boolean {
  return active;
}

/**
 * Forward a user input event from the Cowork pane to the live browser
 * (supervised take-over). No-op unless a screencast is active. Never throws.
 */
export function sendCoworkInput(input: CoworkInput): void {
  if (!active || !sendCmd || !lastMeta) return;
  try {
    if (input.kind === "mouse") {
      const x = Math.round(input.nx * lastMeta.deviceWidth);
      const y = Math.round(input.ny * lastMeta.deviceHeight);
      const moving = input.type === "mouseMoved";
      sendCmd("Input.dispatchMouseEvent", {
        type: input.type,
        x,
        y,
        button: input.button ?? (moving ? "none" : "left"),
        buttons: input.type === "mousePressed" ? 1 : 0,
        clickCount: moving ? 0 : input.clickCount ?? 1,
      });
    } else if (input.kind === "wheel") {
      sendCmd("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(input.nx * lastMeta.deviceWidth),
        y: Math.round(input.ny * lastMeta.deviceHeight),
        deltaX: input.dx,
        deltaY: input.dy,
      });
    } else if (input.kind === "text") {
      sendCmd("Input.insertText", { text: input.text });
    } else if (input.kind === "key") {
      sendCmd("Input.dispatchKeyEvent", {
        type: input.type,
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: input.windowsVirtualKeyCode,
      });
    }
  } catch (err) {
    console.error("[cowork] input dispatch failed:", err);
  }
}
