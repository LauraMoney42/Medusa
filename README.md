# Claude Chat

A multi-session Claude Code chat UI that lets you run multiple Claude Code conversations from a web browser — including on your phone over your local network or remotely via Tailscale / Cloudflare Tunnel.

Built with Express + Socket.IO on the backend and React (Vite) on the frontend, it spawns real `claude` CLI processes per session and streams responses in real time.

## Prerequisites

- **Node.js** v18+ (with npm)
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
  - Requires a Claude Max subscription or API key configured in the CLI

## Setup

```bash
# Clone the repo
git clone <your-repo-url> claude-chat
cd claude-chat

# Install server dependencies
cd server && npm install && cd ..

# Install client dependencies
cd client && npm install && cd ..

# Create your environment file
cp .env.example .env
```

Edit `.env` and set a strong `AUTH_TOKEN`:

```
HOST=0.0.0.0
PORT=3456
AUTH_TOKEN=pick-a-random-secret-here
```

The `AUTH_TOKEN` is used as a Bearer token for HTTP requests and Socket.IO authentication. If left empty, auth is disabled (not recommended for remote access).

## Running

### Development

```bash
./scripts/dev.sh
# or
npm run dev
```

This starts both the Express server (port 3456, with hot-reload via `tsx watch`) and the Vite dev server (port 5173) concurrently. It also uses `caffeinate` to prevent your Mac from sleeping.

- Server API: `http://localhost:3456`
- Client (Vite): `http://localhost:5173`

### Production

```bash
npm run build    # builds client + copies to server/dist/public
npm start        # starts server on port 3456, serves client as static files
```

## Remote Access

### Same Wi-Fi (LAN)

Find your Mac's local IP:

```bash
ipconfig getifaddr en0
```

Then open `http://<your-mac-ip>:3456` from any device on the same network.

### Tailscale (recommended for mobile)

[Tailscale](https://tailscale.com/) creates a secure private network between your devices with zero port forwarding or firewall configuration.

1. Install Tailscale on your Mac: `brew install tailscale` or download from [tailscale.com/download](https://tailscale.com/download)
2. Install Tailscale on your phone (iOS / Android app)
3. Sign in on both devices with the same account
4. Find your Mac's Tailscale IP: `tailscale ip -4`
5. Open `http://<tailscale-ip>:3456` on your phone

Traffic is encrypted end-to-end and works from anywhere (not just your home Wi-Fi).

### Cloudflare Tunnel (quick public URL)

For temporary public access without Tailscale:

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Create a temporary tunnel
cloudflared tunnel --url http://localhost:3456
```

Cloudflared prints a public `https://....trycloudflare.com` URL you can open from any device. The tunnel closes when you stop cloudflared.

## Security

- **Always set `AUTH_TOKEN`** in `.env` before exposing the server to any network. Without it, anyone who can reach your server can run Claude commands on your machine.
- The token is sent as `Authorization: Bearer <token>` on HTTP requests and via `socket.handshake.auth.token` on WebSocket connections.
- The `/api/health` endpoint is unauthenticated (for monitoring/load balancer checks).

## Project Structure

```
claude-chat/
  .env                  # Environment config (HOST, PORT, AUTH_TOKEN)
  package.json          # Root scripts (dev, build, start)
  scripts/
    dev.sh              # Start dev servers concurrently
    build.sh            # Build client + copy to server
  server/
    src/
      index.ts          # Express + Socket.IO entry point
      config.ts         # Env var loading
      auth.ts           # Bearer token auth middleware
      claude/
        process-manager.ts  # Spawns and manages claude CLI processes
        stream-parser.ts    # Parses NDJSON stream from claude CLI
        types.ts            # Shared type definitions
      sessions/
        store.ts         # Persistent session metadata (JSON file)
      socket/
        handler.ts       # Socket.IO event handlers
      routes/
        health.ts        # GET /api/health
        sessions.ts      # CRUD for sessions
        images.ts        # Image upload handling
  client/               # React + Vite frontend
```
