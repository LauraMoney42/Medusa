import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

/**
 * Returns a singleton Socket.IO client.
 * Auth is handled via the httpOnly cookie — the browser sends it automatically
 * in the WebSocket upgrade request. No token parameter needed.
 *
 * The `token` parameter is kept for backward-compat but ignored.
 */
export function getSocket(_token?: string): Socket {
  if (socket) return socket;

  socket = io(window.location.origin, {
    // withCredentials ensures the auth cookie is sent with the WS upgrade request
    withCredentials: true,
    transports: ['websocket'],
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
