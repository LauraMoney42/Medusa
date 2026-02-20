## 2026-02-19 22:00
- Updated README.md: renamed from "Claude Chat" to "Medusa", added architecture diagram, documented Hub, @mention routing, multi-bot orchestration, project management, macOS desktop app, updated project structure, tech stack
- Files modified: README.md

## 2026-02-19 19:00
- Fixed desktop app auto-login: WebViewController now pre-seeds httpOnly auth cookie into WKWebView cookie store before loading the page
- Eliminates login screen on every app launch/server restart — cookie is set from .env AUTH_TOKEN
- No XSS risk: cookie is httpOnly so JS can't read it
- Files modified: app/Sources/WebViewController.swift

## 2026-02-19 15:00
- Settings modal: live login status per Claude account (green/red/grey pills with email + subscription type)
- Login/logout buttons per account — triggers `claude login` or `claude logout` via server
- Dynamic hint section: only shows terminal login commands for accounts that aren't logged in, with correct CLAUDE_CONFIG_DIR
- New server endpoints: GET /api/settings/login-status, POST /api/settings/account/:id/login, POST /api/settings/account/:id/logout
- Server: checkAccountLoginStatus(), loginAccount(), logoutAccount() via `claude auth status --json` / `claude login` / `claude logout`
- Note in modal: "Switching accounts affects new messages only"
- Files modified: server/src/settings/store.ts, server/src/routes/settings.ts, client/src/api.ts, client/src/components/Sidebar/SettingsModal.tsx

## 2026-02-18 00:00
- Removed localStorage.getItem('auth-token') reads and token guards across 5 client files; getSocket() now called with no arguments
- Files affected: client/src/components/Sidebar/SessionEditor.tsx, client/src/components/Chat/ChatPane.tsx, client/src/components/Input/ChatInput.tsx, client/src/components/Hub/HubFeed.tsx, client/src/hooks/useSocket.ts

## 2026-02-17 12:00
- Created docs/persistent_draft_messages_spec.md: P1 spec for per-bot localStorage draft persistence with Zustand store, debounced auto-save, sidebar draft indicator, and QA task breakdown
- Files affected: docs/persistent_draft_messages_spec.md

## 2026-02-17 00:00
- Updated docs/ios_testing_screenshot_bot_spec.md: switched tool stack from XcodeBuildMCP + Xcode 26.3 to xcrun simctl + ios-simulator-mcp + xcodebuild CLI (Xcode 26.1.1 confirmed sufficient)
- Updated: header, Architecture Decision, Proposed Solution, Scope In, Acceptance Criteria (MCP Integration), Task Breakdown (IT1/IT2), Open Questions (Xcode version resolved), Architecture Sketch, Notes
- Files affected: docs/ios_testing_screenshot_bot_spec.md

## 2026-02-15 20:15
- PH1-PH5: Project/Devlog Hygiene automation — devs post [TASK-DONE:], projects auto-update
- Created TaskSyncManager: listens for `task:done` socket events, fuzzy-matches to project assignments
- Fuzzy matching: exact owner name match + Jaccard token overlap (60% threshold)
- Assignment now has `id` field (UUID), generated on creation if not provided
- Extended io.emit intercept to handle task:done → calls TaskSyncManager.handleTaskDone()
- Logging for matches (with score), low-confidence matches, and misses
- Files created: server/src/projects/task-sync.ts
- Files modified: server/src/projects/store.ts, server/src/routes/projects.ts, server/src/index.ts

## 2026-02-15 19:30
- POST /api/health/shutdown endpoint for graceful shutdown via UI button
- Refactored health.ts to factory function, added shutdown handler with async graceful drain
- Notifies clients of shutdown via `server:shutting-down` socket event (includes busy session names)
- Files modified: server/src/routes/health.ts, server/src/index.ts

## 2026-02-15 18:45
- TO4: Conversation summarization — auto-compress chat history after N messages to reduce token usage
- Created `conversation-summarizer.ts` — one-shot Haiku calls for cheap summaries (<200 words)
- Config: `summarizationEnabled` (default true), `summarizationThreshold` (default 30)
- ChatStore extended: `loadSummary()`, `saveSummary()` (stored in `.summary.txt` files)
- Handler: post-message check → summarize + trim to last 5 + reset session if threshold reached
- Summary injected into system prompt before Hub context on subsequent messages
- Files created: server/src/chat/conversation-summarizer.ts
- Files modified: server/src/config.ts, server/src/chat/store.ts, server/src/socket/handler.ts

## 2026-02-15 08:00
- TO1: Tiered model routing — `selectModel()` classifies interactions into haiku/sonnet/opus
- Created `model-router.ts` with pattern-based classification: poll/nudge → haiku, mentions → haiku/sonnet, user msgs → sonnet/opus
- Added `--model` flag passthrough in ProcessManager (new `model` param on sendMessage + spawnClaude)
- Wired routing into all 4 sendMessage call sites (handler, poll-scheduler x2, mention-router)
- Files created: server/src/claude/model-router.ts
- Files modified: server/src/claude/process-manager.ts, server/src/socket/handler.ts, server/src/hub/poll-scheduler.ts, server/src/hub/mention-router.ts

## 2026-02-15 07:15
- TO6: Added Token Efficiency block to `buildHubPromptSection()` — under 50 tokens, no pleasantries, terse bot-to-bot comms
- TO7: Poll prompt already structured (confirmed matching PM2's template)
- TO8: Added `compactMode` parameter to `buildHubPromptSection()` — compact mode uses 5 messages (vs 20), minimal instructions, under 100 tokens. Poll-scheduler uses compact mode for all polls/nudges.
- Files modified: server/src/socket/handler.ts, server/src/hub/poll-scheduler.ts

## 2026-02-15 06:30
- TO2: Hub filtering — bots now only receive relevant hub messages in their system prompt
- Added `getRecentForSession()` to HubStore: filters by @mentions, self-authored, System, @You, broadcasts
- `buildHubPromptSection()` now accepts optional session context for filtered delivery
- Poll scheduler `tick()` updated: bots only polled when relevant new messages exist
- Files modified: server/src/hub/store.ts, server/src/socket/handler.ts, server/src/hub/poll-scheduler.ts, server/src/hub/mention-router.ts

## 2026-02-15 05:15
- Graceful Shutdown: SIGTERM/SIGINT handler with configurable drain period (default 30s)
- Server stops accepting connections, waits for active Claude sessions to finish, force kills on timeout
- Client receives `server:shutting-down` event with list of busy sessions
- `getBusySessions()` helper on ProcessManager checks for active child processes
- Config: `gracefulTimeoutMs` (env: GRACEFUL_TIMEOUT_MS, default 30000)
- Files modified: server/src/config.ts, server/src/claude/process-manager.ts, server/src/index.ts, client/src/stores/sessionStore.ts, client/src/hooks/useSocket.ts

## 2026-02-15 03:30
- Bot Accountability: auto-continuation + escalation instructions added to Hub system prompt
- System prompt now tells bots to check Hub for next assignment after finishing a task, pick up idle assigned work, and escalate with @You 🚨🚨🚨 APPROVAL NEEDED format when blocked
- Poll prompt already updated (Change 2 done by Backend Dev): asks about assigned tasks + escalation format
- Stale assignment tracking already wired (Change 3 done by Backend Dev): 10-min threshold, auto-nudge, Hub warning, io.emit intercept in index.ts
- Files modified: server/src/socket/handler.ts (buildHubPromptSection)

## 2026-02-15 00:30
- Task Completion Notifications — Phase 1 (Server): [TASK-DONE:] detection + 4-state bot status support
- Added CompletedTask type (client/src/types/task.ts) shared between server and client
- HubStore: added task tracking with persistence to ~/.claude-chat/tasks.json (addCompletedTask, getUnacknowledged, acknowledgeAll)
- extractTaskDone() function detects [TASK-DONE: description] markers in hub messages
- [TASK-DONE:] detection wired into all 3 hub post pipelines: handler.ts, mention-router.ts, poll-scheduler.ts
- MentionRouter emits session:pending-task events (true on queue/deliver, false on completion/error)
- Added GET /api/hub/tasks and POST /api/hub/tasks/ack endpoints
- POST /tasks/ack broadcasts tasks:acknowledged to all clients (for clearing checkmarks)
- Files created: client/src/types/task.ts
- Files modified: server/src/hub/store.ts, server/src/socket/handler.ts, server/src/hub/mention-router.ts, server/src/hub/poll-scheduler.ts, server/src/routes/hub.ts

## 2026-02-14 23:30
- Hub Auto Check-In: 5 fixes from PM plan
- Fix 1: Enabled HUB_POLLING=true in .env (scheduler was built but never turned on)
- Fix 2: Multi-word bot name matching — extractMentions() now scans against known session names (longest-first) instead of regex. @UI Dev, @Full Stack Dev, @Product Manager all work now
- Fix 3: Last-seen tracking per bot — poll scheduler skips bots with no new hub messages since last check
- Fix 4: Self-authored message filtering — bots don't get polled about their own hub posts
- Fix 5: [NO-ACTION] marker — empty check-in responses silently discarded from chat history (both user prompt and assistant response)
- Files modified: .env, server/src/hub/mention-router.ts (extractMentions), server/src/hub/poll-scheduler.ts (major update)

## 2026-02-14 23:00
- Hub Live Communications: Fixed @mention responses being invisible (MentionRouter now streams to session rooms with full HubPostDetector pipeline)
- MentionRouter rewrite: real streaming, chat persistence, chain routing up to depth 3, busy/idle status management
- Added POST /api/hub endpoint for external tools to post to Hub (validates input, broadcasts, routes @mentions)
- Added HubPollScheduler: background polling nudges idle bots to check Hub (disabled by default, enable via HUB_POLLING=true)
- Added hubPolling + hubPollIntervalMs config (env vars: HUB_POLLING, HUB_POLL_INTERVAL_MS)
- Exported HubPostDetector and buildHubPromptSection from handler.ts for reuse
- Files created: server/src/hub/poll-scheduler.ts
- Files modified: server/src/hub/mention-router.ts (major rewrite), server/src/routes/hub.ts, server/src/config.ts, server/src/index.ts, server/src/socket/handler.ts (exports)

## 2026-02-13 20:00
- Added Hub feature: shared awareness feed for bot-to-bot coordination
- Bots can post to hub via [HUB-POST: ...] markers (auto-detected and stripped from chat stream)
- @mention routing: bots tag each other, server auto-sends messages to idle bots (60s cooldown, busy queueing)
- System prompt injection: last 20 hub messages + active bot list injected on every message send
- Hub UI: sidebar toggle with unread badge, scrollable feed, text input for user posts
- Hub storage: ~/.claude-chat/hub.json, 200-message FIFO with in-memory cache
- Files created: server/src/hub/store.ts, server/src/hub/mention-router.ts, server/src/routes/hub.ts, client/src/types/hub.ts, client/src/stores/hubStore.ts, client/src/components/Hub/HubMessage.tsx, client/src/components/Hub/HubFeed.tsx
- Files modified: server: config.ts, socket/handler.ts, index.ts, types/socket.io.d.ts; client: api.ts, stores/sessionStore.ts, hooks/useSocket.ts, components/Sidebar/Sidebar.tsx, App.tsx

## 2026-02-13 18:45
- Redesigned UI from Discord-like dark theme to dark Apple glassmorphism aesthetic
- Semi-transparent backgrounds with backdrop-filter blur on sidebar, modals, input bar, scroll buttons, and message bubbles
- Luminous white-alpha borders, soft layered shadows, rounder corners (12px/6px/16px)
- Accent color shifted to Apple system blue (#0a84ff), body background solid #0e0e10 behind glass layers
- New CSS glass tokens: --glass-bg, --glass-bg-heavy, --glass-shadow, --glass-shadow-modal, --border-light
- Sidebar widened to 260px with heavy 40px blur vibrancy
- Files modified: styles/global.css, all 14 component files (Chat/, Sidebar/, Input/, Auth/)

## 2026-02-13 18:30
- Added OmniClaude.png app icon from ~/Pictures, auto-generated icns in build script
- Created Desktop symlink for quick launch
- Files modified: app/build-app.sh, app/Resources/Info.plist

## 2026-02-11 19:30
- Consolidated session settings into SessionEditor modal (gear icon in sidebar, replaces scattered controls)
- SessionEditor: edit instructions/personality, working directory, YOLO toggle, delete session — all in one modal
- Removed Instructions button and YOLO button from chat header (now in SessionEditor)
- Added server socket events: session:set-yolo (explicit boolean), session:update-working-dir
- Files created: client/src/components/Sidebar/SessionEditor.tsx
- Files modified: server: sessions/store.ts, socket/handler.ts; client: stores/sessionStore.ts, hooks/useSocket.ts, components/Sidebar/SessionList.tsx, components/Chat/ChatPane.tsx, styles/global.css

## 2026-02-11 18:30
- Renamed project from "Claude Chat" to "OmniClaude" across all files
- Files modified: app/Sources/*.swift, app/Resources/Info.plist, app/build-app.sh, client components, server/src/index.ts, scripts/build.sh, index.html

## 2026-02-11 18:00
- Fixed production mode: auth middleware now skips non-API routes, static file path corrected
- Added auto-build on app launch: detects missing node_modules/dist, runs npm install + build
- Fixed black screen on app launch: proper NSView hierarchy, deferred auth token injection
- Files modified: server/src/auth.ts, server/src/index.ts, app/Sources/*.swift

## 2026-02-11 17:45
- Added native macOS desktop app (Swift + WKWebView) — 152KB .app bundle
- App starts the Node.js server automatically, polls health endpoint, loads web UI in native window
- Auth token injected into WKWebView localStorage at document-start (skips login screen)
- Loading overlay with spinner while server boots, error display on failure
- Full menu bar: Quit (Cmd+Q), Cut/Copy/Paste, Reload (Cmd+R), Minimize/Zoom
- Build with: bash app/build-app.sh → produces app/ClaudeChat.app
- Files created: app/Sources/ServerManager.swift, app/Sources/WebViewController.swift, app/Sources/main.swift, app/Resources/Info.plist, app/build-app.sh

## 2026-02-11 17:15
- Added Skills feature: attach skills from awesome-claude-skills GitHub repo to sessions
- Server: SkillCatalog service fetches/caches 940+ skill definitions from GitHub, builds skill prompts appended to system prompt at message-send time
- Client: SkillPicker modal with search, Add/Remove toggles; skill badge pills in chat header with X to remove; book icon with count badge
- Disk caching: catalog JSON + individual SKILL.md files with 24h TTL in ~/.claude-chat/
- Files created: server/src/skills/catalog.ts, server/src/routes/skills.ts, client/src/components/Chat/SkillPicker.tsx
- Files modified: server: sessions/store.ts, config.ts, index.ts, socket/handler.ts; client: types/session.ts, api.ts, stores/sessionStore.ts, hooks/useSocket.ts, components/Chat/ChatPane.tsx

## 2026-02-11 16:30
- Added per-session custom instructions / system prompt feature
- New textarea in session creation form for setting personality/instructions
- Pencil icon in chat header to view/edit system prompt after creation (turns accent when set)
- Server passes --system-prompt flag to Claude CLI when configured
- Files modified: client: types/session.ts, api.ts, stores/sessionStore.ts, hooks/useSocket.ts, components/Sidebar/NewSessionButton.tsx, components/Chat/ChatPane.tsx; server: sessions/store.ts, routes/sessions.ts, claude/process-manager.ts, socket/handler.ts

## 2026-02-11 16:00
- Added screenshot capture feature to chat input (camera icon with Region Select + Full Screen modes)
- Uses getDisplayMedia API for screen capture; region selector overlay with drag-to-crop, dimming mask, and confirm/retry/cancel buttons
- Feature-detected: hidden on mobile/unsupported browsers
- Files created: client/src/components/Input/captureScreen.ts, client/src/components/Input/ScreenshotButton.tsx, client/src/components/Input/RegionSelector.tsx
- Files modified: client/src/components/Input/ChatInput.tsx

## 2026-02-11 15:30
- Created complete React client for multi-session Claude Chat web UI (22 source files)
- Files affected: client/src/types/session.ts, client/src/types/message.ts, client/src/socket.ts, client/src/api.ts, client/src/stores/sessionStore.ts, client/src/stores/chatStore.ts, client/src/hooks/useSocket.ts, client/src/hooks/useAutoScroll.ts, client/src/styles/global.css, client/src/components/Auth/LoginScreen.tsx, client/src/components/Sidebar/Sidebar.tsx, client/src/components/Sidebar/SessionList.tsx, client/src/components/Sidebar/NewSessionButton.tsx, client/src/components/Chat/ChatPane.tsx, client/src/components/Chat/MessageList.tsx, client/src/components/Chat/MessageBubble.tsx, client/src/components/Chat/ToolUseBlock.tsx, client/src/components/Chat/JumpToStartButton.tsx, client/src/components/Input/ChatInput.tsx, client/src/components/Input/ImagePreview.tsx, client/src/App.tsx, client/src/main.tsx
- Updated: client/vite.config.ts (dev proxy), client/index.html (title)

## 2026-02-11 15:23
- Built complete server backend with 11 source files
- Files affected: server/src/config.ts, server/src/auth.ts, server/src/claude/types.ts, server/src/claude/stream-parser.ts, server/src/claude/process-manager.ts, server/src/sessions/store.ts, server/src/routes/health.ts, server/src/routes/sessions.ts, server/src/routes/images.ts, server/src/socket/handler.ts, server/src/index.ts, server/src/types/socket.io.d.ts
