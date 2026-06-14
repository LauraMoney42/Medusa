import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

/**
 * Returns a singleton Socket.IO client.
 * Auth is handled via the httpOnly cookie (browser) OR via the auth payload
 * (macOS app — WKWebView WebSocket doesn't reliably send injected cookies).
 * The macOS app injects the token into localStorage; if present, we pass it
 * in the Socket.IO auth payload so the server can validate it.
 */
export function getSocket(_token?: string): Socket {
  if (socket) return socket;

  // WKWebView's WebSocket upgrade doesn't always include httpOnly cookies.
  // Read the token the macOS app injects into localStorage and pass it in the
  // Socket.IO auth payload as a fallback.
  const storedToken = localStorage.getItem('auth-token') ?? undefined;

  socket = io(window.location.origin, {
    // withCredentials ensures the auth cookie is sent with the WS upgrade request
    withCredentials: true,
    // Pass token in auth payload for WKWebView compatibility
    auth: storedToken ? { token: storedToken } : undefined,
    // Prefer websocket but fall back to polling so sleep/wake and network
    // hiccups don't leave the client permanently disconnected.
    transports: ['websocket', 'polling'],
    // Reconnect aggressively after network interruptions (e.g. sleep/wake)
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    // Detect dead connections faster (default 25s is too long for laptop sleep)
    timeout: 10000,
  });

  return socket;
}

/**
 * Tears down the existing socket connection, if any.
 */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
