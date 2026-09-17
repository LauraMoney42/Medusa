# Medusa

[![CI](https://github.com/LauraMoney42/Medusa/actions/workflows/ci.yml/badge.svg)](https://github.com/LauraMoney42/Medusa/actions/workflows/ci.yml)

Medusa is a single-agent, model-agnostic desktop AI interface. Each chat is one session with its own project folder, provider, model, and engine; Medusa orchestrates any parallel work herself by spawning subagents through her own MCP tool server, so the same capabilities show up no matter which engine is driving that chat.

> ## 🎙️ Talk to Medusa, hands-free
> Hit the mic and start talking. Your words stream into the message box **live as you speak**, transcribed on-device by a free, fully offline local Whisper server. No API keys, nothing leaves your Mac.

## What It Does

Medusa gives you one chat per project folder, backed by whichever engine and model you pick for that chat. Ask her to write code, fix bugs, ship a feature, or review a diff, and she uses her own tools (files, shell, Browser, Simulator) to do the work directly. When work can run in parallel, she spawns subagents herself; each subagent shows up as a collapsible card in the same conversation.

**Key features:**
- **One chat = one session** - its own folder, provider, model, and engine, kept together
- **Subagent orchestration** - Medusa spawns focused subagents for parallel or read-heavy work and folds their results back into the conversation
- **Engine-agnostic** - the same chat experience and tool set on top of Anthropic (via the `claude` CLI), Kimi, OpenRouter, or Code Puppy (via ACP)
- **Real-time streaming** - responses stream token-by-token via Socket.IO
- **Multi-account support** - switch between two Claude accounts (e.g. Personal / Work)
- **Browser and Simulator** - CDP-driven Chrome control and iOS Simulator control, available from the chat header
- **Desktop app** - a Tauri v2 shell (`desktop/`) with a Node sidecar, system tray, global hotkey, and screen/window/region capture pickers; the older Swift/WKWebView wrapper in `app/` still works and is being retired once `desktop/` reaches parity

## Engines

Medusa's chat, tools, and subagent orchestration work the same way regardless of which engine is running underneath a given chat:

- **Anthropic**, via the `claude` CLI
- **Kimi** (Moonshot), via the `kimi` CLI
- **OpenRouter** models, routed through the `claude` CLI harness
- **Code Puppy**, via the Agent Client Protocol (ACP)

## Prerequisites

- **macOS** (desktop app is Mac-only)
- **Node.js** v18+ (with npm)
- **Xcode Command Line Tools** - `xcode-select --install`
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
  - Requires a Claude Max subscription or API key configured in the CLI

## Quick Start

**Desktop app (Mac):**
```bash
git clone https://github.com/LauraMoney42/Medusa.git
cd Medusa
bash app/build-app.sh
open app/Medusa.app
```

That's it. On first launch the app automatically installs dependencies, builds the client and server, generates an auth token, and logs you in. Just wait for the loading screen to finish.

A Tauri v2 shell also exists in `desktop/` (Node sidecar, tray, global hotkey, screen/window/region capture) and is the direction the desktop app is migrating to; see `desktop/README.md` for its build steps.

**Dev / headless setup (all platforms):**
```bash
git clone https://github.com/LauraMoney42/Medusa.git
cd Medusa
bash scripts/setup.sh
```

`setup.sh` installs npm dependencies, builds the TypeScript server, copies `.env.example` → `.env`, and registers the **Playwright MCP** tool with Claude Code so Medusa can control a browser out of the box. Edit `.env` before starting the server.

## Providers

A chat normally runs on native Claude (or Kimi). You can also point a chat at **any OpenRouter model** (GPT-5.x, Gemini, DeepSeek, Claude via OpenRouter, etc.): the `claude` CLI is still the harness, so tool use, streaming, and sessions all work the same way.

**To add an OpenRouter key:**

1. Get an API key from [openrouter.ai](https://openrouter.ai).
2. Either set the `OPENROUTER_API_KEY` environment variable before starting the server, or add it to `~/.claude-chat/settings.json`:
   ```json
   {
     "providers": {
       "openrouter": {
         "apiKey": "sk-or-..."
       }
     }
   }
   ```
   (Create the file/`providers` object if it doesn't exist yet.) The key is never written back out by the app, only read.
3. In the app, switch a chat's provider to **OpenRouter** and pick a model from the picker (it lists OpenRouter's live catalog, cached for 10 minutes, with a static fallback if the request fails).

Headroom (the local context-compression proxy) only applies to the native Claude provider: it's automatically skipped when a chat is running on OpenRouter, since OpenRouter traffic is already going to a different base URL.

## How It Works

### One chat, one session

Each chat has its own working directory, provider, model, and engine (`server/src/engine/`: a registry over the `claude` CLI, `kimi` CLI, OpenRouter, and Code Puppy via ACP). Send a message and Medusa spawns the underlying CLI process for that session, streams its output back over Socket.IO, and keeps the conversation attached to that folder.

### Subagents

When a task is independent and read-heavy, or several things can happen in parallel, Medusa spawns a subagent to do it rather than doing it inline. A subagent is a fresh agent instance with its own context; it works the task and reports its result back into the parent chat as a collapsible card. Medusa decides when to delegate; you never manage subagents directly.

### Projects pane

A per-chat scratchpad for structured plans:
- Priority levels (P0-P3)
- Task status tracking (pending → in progress → done)
- Progress visualization in the sidebar

### Target layout (planned, spec addendum)

Per `docs/2026-09-17_ui_and_layer_addendum.md`, the redesigned window is three columns: a collapsible left rail with just the chat list, New Chat, Tools, and Settings; a center chat column with the model selector moved directly under the input instead of the header; and a right panel with Browser and Simulator tabs, toggled from header icons, that can widen to slim/wide/full. A collapsible Activity Log sits at the far right showing the full raw stream (tool calls, subagent activity, token counts) for the current chat. This layout is not built yet in this checkout.

## Security

- Auth token auto-generated on first run and injected into the desktop app automatically
- Settings file (`~/.claude-chat/settings.json`) is `chmod 600` - contains API keys
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
        providers.ts       # Provider registry (claude/kimi/openrouter) + live model listing
      socket/
        handler.ts         # Socket.IO event handlers
        error-policy.ts    # Auth-error detection + consecutive-error dedupe
      routes/
        health.ts          # GET /api/health
        sessions.ts        # CRUD for sessions
        settings.ts        # Account switching, login status, LLM config
        providers.ts       # GET /api/providers, GET /api/providers/:id/models
        projects.ts        # Project & task management
        images.ts          # Image upload handling
      engine/              # Engine registry: types.ts, registry.ts, claude-cli-engine.ts,
                           # kimi-cli-engine.ts, acp-engine.ts, code-puppy-engine.ts
      subagents/           # planned, spec Section A - SubagentManager
      mcp/                 # planned, spec Section A - the `medusa` MCP server + shim
  client/                  # React + Vite frontend
    src/
      components/
        Chat/              # Message display + streaming
        Sidebar/           # Chat list, project cards, settings
      stores/              # Zustand state management
      api.ts               # REST + Socket.IO client
  docs/                    # Architecture and design docs (bot-era docs in docs/archive/)
  ios-bot/                 # iOS build automation (xcodebuild wrapper)
  desktop/                 # Tauri v2 desktop shell (Node sidecar, tray, hotkey, capture pickers)
  app/                     # legacy macOS app (Swift/SwiftUI + WKWebView), being retired
                           # once desktop/ reaches parity
```

## Tech Stack

- **Server**: Node.js, Express, Socket.IO, TypeScript, Zod
- **Client**: React, Vite, TypeScript, Zustand
- **Desktop**: Tauri v2 (Rust shell + Node sidecar), replacing the legacy Swift/SwiftUI/WKWebView app
- **AI**: `claude` CLI, Kimi CLI, OpenRouter (via the `claude` CLI), Code Puppy (via ACP) - spawned as child processes per session
- **Data**: JSON file storage (no database required)
