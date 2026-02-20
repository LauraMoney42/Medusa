# Medusa

Multi-bot AI orchestration platform — run parallel Claude sessions with real-time Hub coordination, @mention routing, and project management.

![Architecture](docs/medusa_architecture.png)

## What It Does

Medusa lets you run multiple Claude Code bots simultaneously, each with their own working directory and system prompt. Bots communicate through a central **Hub** using @mentions, enabling coordinated multi-agent workflows.

**Key features:**
- **Multi-bot sessions** — Spawn as many Claude CLI processes as you need, each with independent context
- **Hub & @mention routing** — Bots talk to each other via `@BotName` mentions in a shared Hub channel
- **Project management** — Create projects with prioritized tasks and assign them to bots
- **Real-time streaming** — Responses stream token-by-token via Socket.IO
- **Multi-account support** — Switch between two Claude accounts (e.g. Personal / Work)
- **macOS desktop app** — Native Swift wrapper with auto-managed server lifecycle
- **Remote access** — Use from your phone over LAN, Tailscale, or Cloudflare Tunnel

## Prerequisites

- **Node.js** v18+ (with npm)
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
  - Requires a Claude Max subscription or API key configured in the CLI

## Quick Start

```bash
git clone https://github.com/LauraMoney42/Medusa.git
cd Medusa
cd server && npm install && cd ..
cd client && npm install && cd ..
npm run build
npm start
```

That's it. On first run, Medusa auto-generates a `.env` file with a random auth token. The token is printed to the console — use it to log in at `http://localhost:3456`.

To customize settings later, edit `.env` in the project root.

## Running

### Production (recommended)

```bash
npm run build    # builds client + copies to server/dist/public
npm start        # starts server on port 3456
```

### Development

```bash
npm run dev      # starts server (hot-reload) + Vite dev server concurrently
```

- Server API: `http://localhost:3456`
- Client (Vite): `http://localhost:5173`

### macOS Desktop App (optional)

Build a native Medusa.app that auto-manages the server — no terminal needed after setup:

```bash
bash app/build-app.sh    # compiles with swiftc (no Xcode project needed)
open app/Medusa.app       # launch — server starts automatically
```

Requires Xcode Command Line Tools (`xcode-select --install`). The app:
- Starts the Node.js server on launch, kills it on quit
- Loads the UI in a native window with auto-login
- Handles port cleanup and auto-build if dependencies are missing

## How It Works

### Hub & @Mention Flow

1. You send a message in the Hub (or a bot session)
2. If the message contains `@BotName`, the server routes it to that bot's Claude CLI process
3. The bot processes the message and responds
4. If the bot's response contains `@AnotherBot`, the cycle continues — enabling bot-to-bot conversations

### Bots

Each bot is a Claude CLI process with:
- A **name** (used for @mention routing)
- A **system prompt** (defines its personality and capabilities)
- A **working directory** (where it can read/write files)
- An **assigned model** (Claude model to use)

Default bots include general assistants, code reviewers, and specialized agents. You can create custom bots from the UI.

### Projects

Create projects with tasks that can be assigned to bots:
- Priority levels (P0–P3)
- Task status tracking (pending → in progress → done)
- Assignment to specific bots
- Progress visualization in the sidebar

## Remote Access

### Same Wi-Fi (LAN)

```bash
ipconfig getifaddr en0
```

Open `http://<your-mac-ip>:3456` from any device on the same network.

### Tailscale (recommended for mobile)

1. Install Tailscale on your Mac and phone
2. Sign in on both devices
3. Find your Mac's Tailscale IP: `tailscale ip -4`
4. Open `http://<tailscale-ip>:3456` on your phone

### Cloudflare Tunnel (quick public URL)

```bash
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel --url http://localhost:3456
```

## Security

- **Always set `AUTH_TOKEN`** in `.env` before exposing the server to any network
- Token is sent as `Authorization: Bearer <token>` on HTTP and via `socket.handshake.auth.token` on WebSocket
- `/api/health` is unauthenticated (for monitoring)
- Settings file (`~/.claude-chat/settings.json`) is `chmod 600` — contains API keys
- API keys are masked in all API responses (only last 4 chars shown)

## Project Structure

```
Medusa/
  .env                     # Environment config (HOST, PORT, AUTH_TOKEN)
  package.json             # Root scripts (dev, build, start)
  scripts/
    dev.sh                 # Start dev servers concurrently
    build.sh               # Build client + copy to server
  server/
    src/
      index.ts             # Express + Socket.IO entry point
      config.ts            # Env var loading
      auth.ts              # Bearer token + cookie auth middleware
      claude/
        process-manager.ts # Spawns and manages Claude CLI processes
        stream-parser.ts   # Parses NDJSON stream from Claude CLI
      sessions/
        store.ts           # Persistent session metadata
      settings/
        store.ts           # Multi-account & LLM provider settings
      socket/
        handler.ts         # Socket.IO event handlers (chat, hub, @mentions)
      routes/
        health.ts          # GET /api/health
        sessions.ts        # CRUD for sessions
        settings.ts        # Account switching, login status, LLM config
        bots.ts            # Bot CRUD
        projects.ts        # Project & task management
        images.ts          # Image upload handling
  client/                  # React + Vite frontend
    src/
      components/
        ChatWindow/        # Message display + streaming
        Sidebar/           # Session list, bot list, project cards, settings
        Hub/               # Multi-bot coordination view
      stores/              # Zustand state management
      api.ts               # REST + Socket.IO client
  docs/                    # Internal bot specs and architecture docs
  ios-bot/                 # iOS build automation (xcodebuild wrapper)
  app/                     # macOS desktop app (Swift/SwiftUI + WKWebView)
```

## Tech Stack

- **Server**: Node.js, Express, Socket.IO, TypeScript, Zod
- **Client**: React, Vite, TypeScript, Zustand
- **Desktop**: Swift, SwiftUI, WKWebView
- **AI**: Claude Code CLI (spawned as child processes)
- **Data**: JSON file storage (no database required)

## Features Coming Soon

- Voice input (Wispr integration or similar)
- Token usage meter
- Updated projects pane
- Easy LLM swapping
