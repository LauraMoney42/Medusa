## 2026-08-05 18:21
- Feature: Human-in-the-loop approval guardrail (Features.md #4) — bot escalations become actionable Approve/Deny requests instead of a plain hub message the user could miss
- New hub/approval-store.ts (mirrors quick-task-store.ts: Zod schema, atomic JSON writes) persisting ApprovalRequest { from, description, sessionId, hubMessageId, status, createdAt, resolvedAt }
- Detection: extractApprovalRequest() in post-processor.ts parses `[HUB-POST: @You APPROVAL NEEDED: <what>]` (the existing bot-escalation convention already in the system prompt); wired into the bot-stream path (processHubPosts, threaded through autonomous-deliver/mention-router/poll-scheduler/dev-control/socket-handler) AND the external POST /api/hub path, so it fires regardless of source
- New GET/POST /api/approvals routes; resolving an approval posts a reply to the Hub as an @mention to the bot ("@BotName ✅ APPROVED: ..." / "❌ DENIED: ..."), reusing the existing mention-routing pipeline — zero new bot-side plumbing
- Client: ApprovalBanner.tsx — amber card(s) with Approve/Deny buttons, self-contained socket subscription (mirrors CoworkPane), mounted in both the Hub and Medusa Chat views so a request can't be missed regardless of which tab is open
- Unit tests for extractApprovalRequest (5 new, 175 total passing)
- Validated end-to-end via a subagent + direct verification: both Approve and Deny paths, live socket push of new requests, correct Hub reply posted and routed to the target bot, no false-positive detection on ordinary hub messages, and approvals persist correctly across a server restart
- Files affected: server/src/hub/approval-store.ts (new), server/src/routes/approvals.ts (new), client/src/components/Hub/ApprovalBanner.tsx (new), client/src/types/approval.ts (new), server/src/hub/post-processor.ts, server/src/config.ts, server/src/index.ts, server/src/routes/hub.ts, server/src/claude/autonomous-deliver.ts, server/src/hub/mention-router.ts, server/src/hub/poll-scheduler.ts, server/src/dev-control/controller.ts, server/src/socket/handler.ts, client/src/api.ts, client/src/components/Hub/HubFeed.tsx, client/src/components/Hub/MedusaChat.tsx

## 2026-08-05 17:05
- Feature: Voice settings — Settings modal has a "Voice" section with on/off, a voice picker, and a speed slider
- New shared client store (stores/ttsStore.ts, localStorage-backed) keeps the header speaker toggle and Settings in sync
- Server: /api/tts/status now returns a curated Kokoro voice list + default; /api/tts accepts a speed param (0.5–2.0×); local Kokoro server updated to pass speed through to the pipeline
- Settings > Voice: toggle, voice `<select>` (12 Kokoro voices), speed slider with live ×, and a "Test voice" button that plays a sample with the current settings
- Verified end-to-end: voice list loads, custom voice + speed both apply, header/Settings toggles stay in sync
- Files affected: client/src/stores/ttsStore.ts (new), server/src/routes/tts.ts, server/src/routes tts speed passthrough, client/src/api.ts, client/src/components/Hub/MedusaChat.tsx, client/src/components/Sidebar/SettingsModal.tsx, ~/.medusa-tts/server.py

## 2026-08-05 16:46
- Feature: Voice-out — Medusa speaks her replies aloud, completing the voice loop with STT (Features.md #6/#7)
- Local Kokoro TTS server (~/.medusa-tts, OpenAI-compatible /v1/audio/speech); Medusa auto-starts/adopts it on boot (server/src/tts/tts-manager.ts, mirrors whisper-manager); new /api/tts + /api/tts/status routes; pluggable to ElevenLabs/OpenAI via TTS_API_BASE_URL/KEY/MODEL/VOICE
- Client: speaker toggle in the Medusa Chat header that auto-speaks each completed reply, plus a per-message play button; strips markdown + caps length for snappy speech; playback via Audio()
- Verified end-to-end: /api/tts returns WAV over bearer + cookie auth; toggle renders when a TTS backend is available
- Files affected: server/src/tts/tts-manager.ts (new), server/src/routes/tts.ts (new), server/src/config.ts, server/src/index.ts, client/src/api.ts, client/src/components/Hub/MedusaChat.tsx, .env.example

## 2026-08-05 16:06
- Feature: Supervised take-over in the Browser view — click, scroll, and type in the live browser (Features.md #2)
- CoworkPane captures mouse (down/up/move), wheel, and keyboard on the frame, maps to normalized [0,1] coords (accounting for object-fit letterboxing), and emits cowork:input
- screencast.ts tracks frame metadata and dispatches CDP Input.dispatchMouseEvent / mouseWheel / insertText / dispatchKeyEvent (sendCoworkInput); scales normalized coords to CSS pixels
- Clean shutdown: stopScreencast() wired into gracefulShutdown so restarts don't leave stale CDP connections
- Verified end-to-end: clicking a link in the pane navigated the real Chrome (example.com → iana.org)
- Files affected: server/src/cowork/screencast.ts, client/src/components/Cowork/CoworkPane.tsx, server/src/socket/handler.ts, server/src/index.ts

## 2026-08-05 15:41
- Feature: Live computer-use "Browser" view — watch the CDP-controlled Chrome inside Medusa (Features.md #2, Cowork parity)
- Server cowork/screencast.ts: connects to Chrome DevTools Protocol on :9222, runs Page.startScreencast, and broadcasts JPEG frames over Socket.IO (cowork:frame / cowork:status); adopts the first page target; fails safe when no automation browser is running
- Client Cowork/CoworkPane.tsx + a "Browser" sidebar view (activeView 'cowork'): renders the live frames; shows a "launch Chrome with --remote-debugging-port=9222" placeholder otherwise
- Socket handler wires cowork:start/stop. Read-only for now (take-over/input forwarding is a follow-up)
- Polish: chat reply bubbles now show the selected agent's name instead of always "Medusa"
- Verified end-to-end via the in-app browser: the Browser view streamed a live Chrome tab (example.com)
- Files affected: server/src/cowork/screencast.ts (new), client/src/components/Cowork/CoworkPane.tsx (new), server/src/socket/handler.ts, client/src/App.tsx, client/src/components/Sidebar/Sidebar.tsx, client/src/stores/sessionStore.ts, client/src/components/Hub/MedusaChat.tsx

## 2026-08-05 15:25
- Feature: Cowork-like UI overhaul — token-usage ring, provider+model selector, agent selector (Features.md #6)
- TokenRing widget in the sidebar header: circular spend gauge (today vs a soft daily budget from localStorage medusa-daily-budget, default $20); click-expands a popover with Today/Week/Month cost + top bots
- ChatHeaderControls in the Medusa Chat header: agent selector (defaults to Medusa, switches which bot the chat targets and loads its history), provider selector (Anthropic/Kimi), per-bot model selector (Auto/Haiku/Sonnet/Opus/Fable)
- MedusaChat generalized from the hardwired Medusa session to a selectable active session
- New components scaffolded via parallel subagents, then integrated + verified
- Files affected: client/src/components/Usage/TokenRing.tsx (new), client/src/components/Hub/ChatHeaderControls.tsx (new), client/src/components/Hub/MedusaChat.tsx, client/src/components/Sidebar/Sidebar.tsx

## 2026-08-05 15:13
- Feature: Search box to filter the chat/bot list in the sidebar (Features.md #6, UI overhaul)
- Filters bots by name as you type; drag-reorder disabled while a query is active; "No chats match" empty state. (Rename was already available via right-click → Rename and the pencil → editor.)
- Files affected: client/src/components/Sidebar/SessionList.tsx

## 2026-08-05 15:10
- Feature: Medusa auto-starts the local Whisper STT server on boot
- New supervised side-process (server/src/stt/whisper-manager.ts) mirroring the Headroom proxy: spawns ~/.medusa-stt/run.sh on startup when STT_API_BASE_URL is loopback, health-checks /v1/models, adopts an already-running server, auto-restarts on crash (max 5), kills it on graceful shutdown
- Config: STT_AUTOSTART (default true), STT_RUN_SCRIPT (default ~/.medusa-stt/run.sh)
- Files affected: server/src/stt/whisper-manager.ts (new), server/src/config.ts, server/src/index.ts, .env.example

## 2026-08-05 14:23
- Feature: Speech-to-text mic button in the chat input (Features.md #7)
- Client records via MediaRecorder (works in Chrome and the packaged WKWebView app, unlike the SpeechRecognition API) and POSTs to a new /api/stt; the returned transcript is appended to the message input
- Server /api/stt forwards audio to any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, or a local whisper.cpp / faster-whisper server); the mic button stays hidden until configured (GET /api/stt/status)
- macOS app: added NSMicrophoneUsageDescription + a WKUIDelegate media-capture grant so the mic works inside WKWebView (requires an app rebuild via app/build-app.sh)
- Config: STT_ENABLED, STT_API_BASE_URL, STT_API_KEY, STT_MODEL (documented in .env.example)
- Files affected: server/src/routes/stt.ts (new), server/src/config.ts, server/src/index.ts, client/src/components/Input/MicButton.tsx (new), client/src/components/Input/ChatInput.tsx, client/src/api.ts, app/Sources/WebViewController.swift, app/Resources/Info.plist, .env.example

## 2026-08-05 14:12
- Feature: Test suite + CI (GitHub Actions) with coverage and a status badge
- Extended vitest config with v8 coverage (text + json-summary + html reporters); excluded entry points, socket wiring, and process spawning that need a live Claude CLI
- New unit tests: StreamParser (NDJSON stream parsing), selectModel (tiered model routing), extractQuickTask (hub [QUICK-TASK] markers) — 31 new tests, 170 passing across 9 files
- New CI workflow (.github/workflows/ci.yml): server typecheck + vitest --coverage, client typecheck, on push/PR to main. Lint intentionally not gated (23 pre-existing client eslint errors) to keep the badge honest and green
- CI badge added to README
- Files affected: server/vitest.config.ts, server/src/claude/__tests__/stream-parser.test.ts, server/src/claude/__tests__/model-router.test.ts, server/src/hub/__tests__/post-processor.test.ts, server/package.json, package.json, .github/workflows/ci.yml, README.md

## 2026-07-03 15:52
- Feature: macOS app now writes server logs to a file (previously stdout → /dev/null, unviewable)
- Server stdout + stderr → ~/Library/Logs/Medusa/server.log (view live: `tail -f ~/Library/Logs/Medusa/server.log`)
- stderr still teed to a rolling 8KB buffer for the crash dialog; log handle reopened on each (re)start
- Requires an app rebuild (app/build-app.sh — done) + relaunch
- Files affected: app/Sources/ServerManager.swift

## 2026-07-03 15:34
- Feature: Live Headroom compression panel in the Settings modal
- Shows Active/Starting/Off status badge + a 2×2 stat grid (avg compression %, tokens saved, est. $ saved, requests compressed), polled every 5s while the modal is open
- New endpoint GET /api/headroom/stats → { enabled, ready, port, stats }; server fetches the proxy's /stats and normalizes it (getHeadroomStats in proxy-manager)
- Files affected: server/src/headroom/proxy-manager.ts, server/src/routes/headroom.ts (new), server/src/index.ts, client/src/api.ts, client/src/components/Sidebar/SettingsModal.tsx

## 2026-07-03 15:10
- Feature: Headroom context-compression proxy integrated for token savings across all bots
- Works with Max-plan subscription auth (NO API key): the local Headroom proxy forwards Claude Code's own OAuth bearer token to Anthropic. Verified with `claude -p` through the proxy returning correctly.
- New supervised side-process: server spawns `headroom proxy --port 8787` on startup, health-checks /livez, auto-restarts on crash (max 5), reuses an existing proxy if one is already running, and kills it on graceful shutdown.
- Bot `claude` spawns (and the summarizer) get ANTHROPIC_BASE_URL + ENABLE_TOOL_SEARCH injected only when the proxy is ready AND provider is Claude (not Kimi) — otherwise {} → direct Anthropic. Fails safe; bots never break if Headroom is absent/down.
- Config: HEADROOM_ENABLED (default true), HEADROOM_PORT (default 8787).
- Prereqs installed on this machine: Homebrew python@3.13 + pipx; `pipx install "headroom-ai[all]"` (v0.29.0) at ~/.local/bin/headroom.
- Files affected: server/src/headroom/proxy-manager.ts (new), server/src/config.ts, server/src/claude/process-manager.ts, server/src/chat/conversation-summarizer.ts, server/src/index.ts

## 2026-07-03 12:43
- Feature: Per-bot model selector in the "Edit Bot" modal
- Model dropdown (Auto / Haiku / Sonnet / Opus / Fable) persists via existing PATCH /api/sessions/:id (model field)
- On save, if the model changed, a confirm popup ("Must restart server to implement the model change. Restart now?") offers a server restart (exit 75 → macOS app auto-relaunch)
- Removed the bottom "⚠️ Offline — reconnecting…" banner from both the Medusa chat and Hub feed input areas (was displaying incorrectly); dropped now-unused `connected` destructure + `offlineBanner` styles
- Files affected: client/src/types/session.ts, client/src/api.ts, client/src/stores/sessionStore.ts, client/src/components/Sidebar/SessionEditor.tsx, client/src/components/Hub/MedusaChat.tsx, client/src/components/Hub/HubFeed.tsx

## 2026-04-05
- Feature: Microsoft OneNote integration for Medusa Mac desktop app (mu-onenote-001)
- OAuth 2.0 device code flow — no redirect URI needed, works in desktop context
- Token persistence in ~/.claude-chat/settings.json (access + refresh + expiry)
- Auto-refresh tokens before 1h expiry; creates "Medusa" notebook + "General" section if missing
- Settings modal: Azure Client ID input field + Connect/Disconnect flow with live device code UI
- Files modified: server/src/onenote/service.ts (new), server/src/routes/onenote.ts (new), server/src/settings/store.ts, server/src/index.ts, client/src/api.ts, client/src/components/Sidebar/SettingsModal.tsx

## 2026-03-09
- Fix: Claude account login status always showing "Not logged in"
- Root cause 1: server set CLAUDECODE="" instead of unsetting it — now properly deleted from child env
- Root cause 2: macOS app doesn't include ~/.local/bin in PATH — auth functions now resolve claude binary path like process-manager does
- Root cause 3: Login button used execFile which can't open browser from server context — now uses spawn to capture OAuth URL and opens it via macOS `open`
- Redesign Settings modal: per-account cards with individual Login/Logout buttons
- Account switching no longer auto-logs-out the previous account
- Files modified: server/src/settings/store.ts, client/src/components/Sidebar/SettingsModal.tsx

## 2026-02-28
- Remove Medusa chat icon/button from sidebar; clicking Medusa bot name in session list now opens Medusa chat
- Medusa session row highlights green when active, name turns accent green
- Auto-scroll Medusa chat to most recent messages on open and when new messages arrive
- Files modified: client/src/components/Sidebar/Sidebar.tsx, client/src/components/Sidebar/SessionList.tsx, client/src/components/Hub/MedusaChat.tsx

- Add bash-style input history navigation (Up/Down arrow keys) to Hub and ChatInput textareas
- Up arrow at cursor start recalls previous sent messages; Down arrow moves forward or restores unsent draft
- History persisted to localStorage (50 entries per scope), scoped per session and Hub
- Files added: client/src/stores/inputHistoryStore.ts, docs/INPUT_HISTORY_IMPLEMENTATION.md
- Files modified: client/src/components/Hub/HubFeed.tsx, client/src/components/Input/ChatInput.tsx

## 2026-02-26
- Add TicTalk proxy endpoint: POST /api/tictalk forwards iOS app messages to Anthropic Claude API
- Auth: Bearer token (AUTH_TOKEN), rate limit: 20 req/min per IP, error codes: 401/429/500
- Files modified: server/src/routes/tictalk.ts (new), server/src/index.ts

## 2026-02-25 11:45
- Fix: Medusa not responding to unaddressed Hub messages from user
- Root cause: bot [HUB-POST] messages without @mentions were also default-routed to Medusa, burning the 60s cooldown before user messages arrived
- Fix: restrict default-Medusa routing to user-originated messages only (from === "User" or "You")
- Files modified: server/src/hub/mention-router.ts

## 2026-02-25 11:30
- Bot status indicator redesign: swap busy/pending visuals for more intuitive mapping
- Busy state now shows blinking green dot (was spinning cog) — clearer "thinking" feedback
- Pending task state now shows spinning green cog (was pulsing dot) — indicates queued work
- Added statusBlink keyframe animation (fast 0.8s on/off blink)
- Files modified: client/src/components/Sidebar/SessionList.tsx, client/src/styles/global.css

## 2026-02-25 09:00
- Medusa as default Hub responder: unaddressed Hub messages (no @mention) auto-route to Medusa bot
- System messages and Medusa's own messages are excluded from auto-routing
- Files modified: server/src/hub/mention-router.ts

## 2026-02-24 12:00
- File drag-and-drop support: accept any file type (not just images) via drag-and-drop
- New fileDropStore replaces imageDropStore with FileEntry type (file, preview, isImage)
- New AttachmentPreview component: thumbnails for images, file icon + name for non-images
- New server route /api/files for uploading any file type (20MB limit, no extension filter)
- ChatInput splits uploads into images[] and files[] arrays for socket emit
- process-manager prepends "Please read this file: <path>" for non-image attachments
- Fix: Hub @mention routing now passes images to bots (was previously text-only)
- autonomousDeliver accepts images param, sanitizes paths, forwards to sendMessage
- Exported sanitizeImagePaths from handler.ts for reuse
- HubFeed now accepts all file types (not just images) via drop/paste/send
- Hub posts carry both `images` and `files` arrays through socket → HubStore → mention-router → autonomousDeliver → sendMessage
- Drop overlay updated: generic file icon + "Drop files here" text
- Files created: client/src/stores/fileDropStore.ts, client/src/components/Input/AttachmentPreview.tsx, server/src/routes/files.ts
- Files modified: client/src/App.tsx, client/src/components/Input/ChatInput.tsx, client/src/components/Hub/HubFeed.tsx, client/src/api.ts, client/src/types/message.ts, server/src/index.ts, server/src/socket/handler.ts, server/src/claude/process-manager.ts, server/src/claude/autonomous-deliver.ts, server/src/hub/mention-router.ts
- Files deleted: client/src/stores/imageDropStore.ts, client/src/components/Input/ImagePreview.tsx

## 2026-02-22 20:15
- P0 bot visibility fix: startup announce + heartbeat + stale detection
- Server now posts "bots online" System message to Hub on every restart
- Heartbeat tracking: records last activity per bot, flags stale bots (10min silence) in Hub
- Files modified: server/src/index.ts, server/src/hub/poll-scheduler.ts

## 2026-02-22 20:00
- TC-7: Added comprehensive unit tests for CLI token compressor (139 tests across 6 files)
- Added vitest test framework with config to exclude dist/
- Full coverage: whitespace, dedup, boilerplate strategies + engine integration + config loader + security content protection
- Files created: server/src/compressor/__tests__/*.test.ts, server/vitest.config.ts
- Files modified: server/package.json

## 2026-02-21 12:00
- Simplified Settings modal: replaced complex account cards with a single toggle button to switch between Account 1 and Account 2
- Removed per-account login/logout buttons, status pills, refresh button, and terminal command hints
- Added "Restart App" button in Settings for applying login/logout changes
- New server endpoint: POST /api/health/restart — exits with code 75 for auto-restart
- macOS app: ServerManager detects exit code 75 and auto-relaunches the server + reloads WebView
- Files modified: client/src/components/Sidebar/SettingsModal.tsx, client/src/api.ts, server/src/routes/health.ts, app/Sources/ServerManager.swift, app/Sources/main.swift

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
