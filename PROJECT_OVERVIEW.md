# Claude Chat - Multi-Session Chat Web UI

A web-based chat interface that enables multiple concurrent sessions with the Claude CLI (`claude -p`), providing real-time streaming responses via WebSockets.

## Architecture

```
claude-chat/
  .env                  # HOST, PORT, AUTH_TOKEN
  client/               # Frontend (Vite + React, separate build)
  server/               # Backend (Express + Socket.IO + TypeScript)
    src/
      config.ts         # Loads .env, exports typed config object
      auth.ts           # Bearer-token auth middleware for Express
      index.ts          # Entry point: wires Express, Socket.IO, routes
      claude/
        types.ts        # TypeScript types for Claude CLI NDJSON stream
        stream-parser.ts # Incremental NDJSON line parser
        process-manager.ts # Spawns/manages claude CLI child processes per session
      sessions/
        store.ts        # Persists session metadata to ~/.claude-chat/sessions.json
      routes/
        health.ts       # GET /api/health
        sessions.ts     # CRUD for chat sessions
        images.ts       # Image upload via multer
      socket/
        handler.ts      # Socket.IO auth + event handlers for real-time chat
      types/
        socket.io.d.ts  # Ambient type declarations for socket.io
    uploads/            # Uploaded images stored here
```

## Key Technologies

### Server
- **Runtime**: Node.js with TypeScript (ESM)
- **HTTP**: Express 4 with CORS
- **Real-time**: Socket.IO 4 (10 MB buffer)
- **CLI Integration**: Spawns `claude -p --output-format stream-json --verbose --include-partial-messages`
- **Storage**: JSON file at `~/.claude-chat/sessions.json` (atomic writes)
- **Auth**: Bearer token from .env, applied to both HTTP and WebSocket

### Client
- **Framework**: React 19 with TypeScript
- **Build Tool**: Vite 7 (dev proxy to server on port 3456)
- **State Management**: Zustand (sessionStore + chatStore)
- **Real-time**: Socket.IO Client (websocket transport)
- **Markdown**: react-markdown + remark-gfm + rehype-highlight
- **Theme**: Dark Discord-like UI with CSS custom properties

### Client Components
| Component | Path | Responsibility |
|---|---|---|
| `LoginScreen` | `components/Auth/` | Token-based authentication |
| `Sidebar` | `components/Sidebar/` | Session list, create/rename/delete sessions |
| `ChatPane` | `components/Chat/` | Main chat area with message list and input |
| `MessageBubble` | `components/Chat/` | Individual message rendering (markdown, tool use) |
| `ChatInput` | `components/Input/` | Text input with image paste, send/abort controls |

## Hub (Shared Awareness Feed)

Bots can coordinate and flag uncertainties via a shared Hub feed, without constant chatter.

### Architecture
- **Storage**: `~/.claude-chat/hub.json` — 200-message FIFO, loaded into memory on startup
- **Server**: `server/src/hub/store.ts` (HubStore), `server/src/hub/mention-router.ts` (MentionRouter)
- **Client**: `client/src/stores/hubStore.ts` (Zustand), `client/src/components/Hub/` (HubFeed, HubMessage)

### How Hub Posts Work
1. Bot includes `[HUB-POST: message here]` in its response
2. `HubPostDetector` (in socket handler) detects the marker mid-stream, strips it from chat output
3. Message is stored, broadcast to all clients via `hub:message` socket event
4. If the post contains `@BotName`, MentionRouter sends an auto-message to that bot's session

### @Mention Routing
- `@BotName` in hub messages triggers automatic message delivery to the named bot
- Idle bots receive immediately; busy bots get the mention when they become idle
- Guards: self-mention prevention, 60s cooldown, max 1 pending mention per bot

### System Prompt Injection
Every outbound message to Claude includes the last 20 hub messages and the list of active bots, so each bot has awareness of the team's state.

## How It Works

1. Client creates a session via `POST /api/sessions`
2. Client connects to Socket.IO and joins the session room
3. Client sends `message:send` with text (and optional image paths)
4. Server spawns `claude` CLI, pipes NDJSON stdout through StreamParser
5. Parsed events stream back to the client room as `message:stream:*` events
6. On process exit, session status transitions from busy to idle
