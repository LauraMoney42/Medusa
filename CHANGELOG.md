## 2026-09-17 (S4)
- Docs: rewrote README.md, PROJECT_OVERVIEW.md, CLAUDE.md, and Features.md for the single-orchestrator redesign (spec: docs/2026-09-17_medusa_only_orchestrator_spec.md, docs/2026-09-17_ui_and_layer_addendum.md)
- README.md: new lead, "Engines" section (Anthropic via claude CLI, Kimi, OpenRouter, Code Puppy via ACP), a "Providers" section, and removed all bot/Hub instructions; kept the CI badge and the existing install/dev/build steps (verified against package.json scripts)
- PROJECT_OVERVIEW.md: rewritten around the six-layer target architecture (client, server, desktop shell, engine layer, MCP tools layer, sessions), with a component table pointing at real current paths; paths owned by in-flight workstreams S1-S3 (medusa MCP server, subagent manager) are marked "planned, spec Section X" where they do not exist in this checkout yet; the engine registry (server/src/engine/) itself already exists on main and is marked current
- CLAUDE.md: replaced the bot/Hub/PM persistent instructions with the Medusa single-orchestrator persona, the spawn_agent subagent protocol, the rescoped Projects-pane instructions, a Models/providers section, and a Browser automation (CDP) section
- Features.md: added a "Redesign roadmap" section covering workstreams S1-S12 and the three-layer "Medusa layer" vision (persona/rules, tools, engine) as the forward roadmap; marked the superseded LiteLLM gateway plan as superseded; left the already-dated, already-done items in the historical Priority order list as-is
- Archived the bot-era docs to docs/archive/ with git mv: BOT_SYSTEM_GUIDE.md, HUB_BOT_COORDINATION.md, MEDUSA_PROJECT_MANAGEMENT_GUIDE.md, BOT_STATUS_SYMBOLS_IMPLEMENTATION_GUIDE.md, and the docs/*hub*, *bot*, *kanban*, and stop_all_button_spec.md files; added docs/archive/README.md explaining the retired multi-bot era
- Regenerated docs/medusa_architecture.md as a Mermaid diagram of the target architecture (client, server, engines, medusa MCP server, subagents, desktop shell) and deleted the stale docs/medusa_architecture.png and docs/medusa_architecture.html renderings
- Files affected: README.md, PROJECT_OVERVIEW.md, CLAUDE.md, Features.md, CHANGELOG.md, docs/medusa_architecture.md, docs/archive/README.md (new), docs/medusa_architecture.png (deleted), docs/medusa_architecture.html (deleted), plus the git-mv archival of the bot-era docs listed above

## 2026-09-17 18:15
- Fix: when the `claude` CLI failed (not logged in, prompt too long, etc.), the user saw an empty assistant bubble followed later by the same error text concatenated two or three times. Root cause 1: engine errors reached the client via `message:error` but chatStore.setError appended the raw string onto `message.text`, so nothing rendered until the append happened, and streaming deltas/typing dots gave no visual cue an error was already in flight. Root cause 2: tier escalation in server/src/socket/handler.ts (haiku -> sonnet -> opus) reused the same assistantMsgId across retries and re-emitted the identical error on every failed tier, so the client appended it repeatedly.
- Server: added server/src/socket/error-policy.ts with `isAuthError` (matches "Not logged in" / "/login"), `ConsecutiveErrorDeduper` (suppresses an immediate repeat of the same error text), and `buildAllTiersFailedMessage` (one summary line with the exact `CLAUDE_CONFIG_DIR=... claude /login` command). handler.ts now dedupes consecutive identical error emits, skips all tier escalation once an auth error is seen (a different model tier cannot fix "not logged in"), and emits one "All models failed: ..." summary line once every attempt is exhausted.
- Client: message.errors (client/src/types/message.ts) now holds distinct, already-deduped error lines separate from message.text. chatStore.setError appends to that array (skipping an exact repeat of the last entry) instead of concatenating into text. MessageBubble.tsx renders each error as its own line styled with var(--danger) on a tinted background, and shows a muted "No response" placeholder (chosen over removing the bubble, since it needs no extra store logic) when a finished message has no text, no tool cards, and no errors.
- Config dir used by the native Anthropic provider: server/src/settings/store.ts `getActiveConfigDir()` returns `undefined` (i.e. the CLI's own default `~/.claude`) unless `config.claudeConfigDir` (from `CLAUDE_CONFIG_DIR` env, server/src/config.ts) is set to something other than `~/.claude`. To fix "Not logged in" for whichever config dir Medusa is actually using, run: if `CLAUDE_CONFIG_DIR` is unset, `claude /login`; if it is set (e.g. for a second account), `CLAUDE_CONFIG_DIR=<that path> claude /login`.
- Tests: server/src/socket/__tests__/error-policy.test.ts (new, 11 cases) covers isAuthError, consecutive dedupe, and the summary-line builder. `cd server && npx tsc --noEmit && npx vitest run` stays green (264 tests, up from 253). `cd client && npx tsc -b --noEmit` clean. `cd client && npm run build` succeeds.
- Files affected: server/src/socket/handler.ts, server/src/socket/error-policy.ts (new), server/src/socket/__tests__/error-policy.test.ts (new), client/src/types/message.ts, client/src/stores/chatStore.ts, client/src/components/Chat/MessageBubble.tsx

## 2026-09-17 17:50
- QA fix: Medusa Chat and the Hub feed each called useSocket() a second time even though App.tsx already owns the single shared socket connection for the whole authenticated session. Every call registers its own listener set on the same underlying socket, so each server event (message:user, deltas, tool events) fired twice, producing duplicate "You" bubbles and doubled tool cards. Removed the redundant calls; the connection is now established exactly once.
- QA fix: MedusaChat.tsx defined its own stale local MessageBubble component instead of using the shared client/src/components/Chat/MessageBubble.tsx, so none of today's tool_use/tool_result rendering (ToolUseBlock, markdown, streaming dots) ever showed up in Medusa Chat — replies always looked plain-text-or-blank with no tool cards, regardless of engine. Switched MedusaChat.tsx to the shared component (which gained an optional onSpeak prop to keep the "play aloud" button) and deleted the duplicate.
- QA fix: switching provider in the header (ChatHeaderControls) did not update the bottom-bar model picker in MedusaChat.tsx until a full reload, because each component kept its own local activeProvider state populated once from fetchSettings() with no shared source of truth. Moved activeProviderId into the shared providerStore so both pickers agree immediately.
- QA note (no code change): the Kimi engine itself parses tool_calls/tool results/plain-string content correctly (verified against real `kimi` CLI 1.47 output). The blank-reply reports traced to the two rendering bugs above, plus the "Medusa" bot's own configured system prompt, which routes all replies through [HUB-POST: ...] and legitimately leaves the direct chat bubble empty for that bot; other bots (e.g. Dev1) return normal non-empty text with a rendered ReadFile tool card under Kimi.
- Server: `cd server && npx tsc --noEmit && npx vitest run` stays green (253 tests). Client: `cd client && npx tsc -b --noEmit` clean.
- Files affected: client/src/components/Hub/MedusaChat.tsx, client/src/components/Hub/HubFeed.tsx, client/src/components/Chat/MessageBubble.tsx, client/src/components/Hub/ChatHeaderControls.tsx, client/src/stores/providerStore.ts

## 2026-09-17 17:29
- Fix: Kimi sessions showed blank replies. Kimi CLI 1.47 emits the final answer as a plain string `content`, which the engine ignored (it only read block arrays). Also maps Kimi `tool_calls` and `role:"tool"` lines to tool_use_start / tool_result so tool cards render for Kimi too. Real 1.47 output saved as a scrubbed fixture
- Files affected: server/src/engine/kimi-cli-engine.ts, server/src/engine/__tests__/kimi-cli-engine.test.ts (new), server/src/engine/__tests__/fixtures/kimi-1.47-stream.jsonl (new)

## 2026-09-17 17:05
- Desktop (Tauri): removed the entry.mjs fs-shim hack. server/src/config.ts now
  resolves .env/uploads/default-bots.json/static-client-dir through explicit
  overrides (MEDUSA_ENV_FILE, MEDUSA_DATA_DIR, MEDUSA_STATIC_DIR), defaulting
  to the prior __dirname-relative behavior when unset. desktop/src-tauri/src/main.rs
  now passes those three env vars to the sidecar directly, and
  desktop/scripts/build-sidecar.sh compiles server/dist/index.js straight
  into the sidecar binary (desktop/src-tauri/sidecar-src/entry.mjs deleted).
  `cd server && npx vitest run` stays green (175 tests).
- Desktop: ported the screen/window/region capture pickers to Tauri. New
  `capture_screen` Rust command (desktop/src-tauri/src/main.rs) shells out to
  macOS `screencapture` (-x full screen, -i region, -i -w window) and returns
  base64 PNG. client/src/components/Input/captureScreen.ts gained a Tauri
  path (window.__TAURI__.core.invoke) tried before the legacy WKWebView
  bridge, so the same capture buttons work in both shells.
- Desktop: added a system tray (Show/Hide/Quit), close-to-tray instead of
  quit (window close now hides; only the tray Quit item kills the sidecar
  and exits), a global Cmd+Shift+M hotkey to show/focus the window, the
  notification plugin, and an updater plugin config with a placeholder
  endpoint/pubkey (no real signing keys generated or committed).
- Desktop: ported app/Resources/Medusa.entitlements into
  desktop/src-tauri/Medusa.entitlements (referenced from tauri.conf.json's
  bundle.macOS.entitlements) and added desktop/src-tauri/Info.plist with the
  NSScreenCaptureUsageDescription / NSMicrophoneUsageDescription strings.
- Files affected: server/src/config.ts, server/src/index.ts,
  server/src/sessions/store.ts, desktop/src-tauri/src/main.rs,
  desktop/src-tauri/Cargo.toml, desktop/src-tauri/tauri.conf.json,
  desktop/src-tauri/capabilities/default.json,
  desktop/src-tauri/Medusa.entitlements (new), desktop/src-tauri/Info.plist
  (new), desktop/scripts/build-sidecar.sh,
  desktop/src-tauri/sidecar-src/entry.mjs (deleted),
  client/src/components/Input/captureScreen.ts, desktop/README.md

## 2026-09-17 16:40
- Fix: Parse the real `stream-json` contract (cowork parity audit gaps 1 and 2). Tool cards now show input and output, assistant text streams token by token, and subagent activity is attributed.
- server/src/claude/types.ts: added the `stream_event` envelope (`StreamEventEnvelope`, `RawApiEvent`), `UserMessage` (how `tool_result` blocks actually arrive), `ContentBlockThinking`, `ThinkingDelta`, message_start/delta/stop events, `is_error` on tool results, and `parentToolUseId` on every parsed event. All previously exported names kept.
- server/src/claude/stream-parser.ts: unwraps `stream_event.event` (the CLI never emits `content_block_delta` at the top level, so both streaming branches were dead code); parses `assistant` content into `assistant_complete` plus one `tool_use_start` per `tool_use` block; parses `type:"user"` messages into `tool_result` events with `is_error`; flattens array-shaped tool results; carries `parent_tool_use_id` through; dedupes a tool that appears both streamed and completed. `result` parsing (usage, cost, session_id) unchanged.
- server/src/engine/claude-cli-engine.ts: pass `--include-partial-messages`, without which no `stream_event` lines are emitted at all.
- server/src/socket/handler.ts and server/src/claude/autonomous-deliver.ts: emit `tool_use` with its id and input, pair `tool_result` to its call by id instead of by arrival order (parallel calls interleave), forward `is_error` and `parent_tool_use_id`, and keep subagent text out of the hub-marker buffer. HubPostDetector behavior is unchanged.
- client: `ToolUse` gained `id`, `isError`, `parentToolUseId`; chatStore gained `setToolResult` (pairs by id); useSocket listens for `message:stream:tool_result`; ToolUseBlock shows pretty-printed input, output truncated to 20 lines with an expand control, a `--danger` error style, and a subtle "subagent" badge.
- Tests: 14 new parser tests over a new fixture. `cd server && npx tsc --noEmit && npx vitest run` -> 12 files, 206 tests passing; `cd client && npx tsc -b --noEmit` clean.
- Note: `server/src/claude/__tests__/fixtures/stream-tool-use.jsonl` is SYNTHETIC. The CLI is installed here but the capture environment had no usable credentials ("Not logged in"), so the fixture was hand-built from the documented shapes and the real lines in docs/stream-format-example.jsonl. See the README beside it. Live UI verification was not possible for the same reason.
- Files affected: server/src/claude/types.ts, server/src/claude/stream-parser.ts, server/src/claude/autonomous-deliver.ts, server/src/claude/__tests__/stream-parser.test.ts, server/src/claude/__tests__/stream-parser-real-shape.test.ts (new), server/src/claude/__tests__/fixtures/stream-tool-use.jsonl (new), server/src/claude/__tests__/fixtures/README.md (new), server/src/chat/store.ts, server/src/engine/claude-cli-engine.ts, server/src/engine/__tests__/claude-cli-engine.test.ts, server/src/socket/handler.ts, client/src/types/message.ts, client/src/stores/chatStore.ts, client/src/hooks/useSocket.ts, client/src/components/Chat/ToolUseBlock.tsx, client/src/components/Chat/MessageBubble.tsx

## 2026-09-17 00:00
- Feature: OpenRouter support, letting a bot run on any OpenRouter model (GPT-5.x, Gemini, DeepSeek, Claude via OpenRouter, etc.) using the existing `claude` CLI as the harness, with a dynamic model picker instead of the old hardcoded lists
- New server/src/settings/providers.ts: a provider registry (native "claude", "kimi", and "openrouter") with a `listModels()` that GETs `<baseUrl>/v1/models` for Anthropic-compatible providers (cached 10 minutes, static fallback on any failure) and `getAnthropicCompatibleEnv()` that builds the `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` env for spawning `claude` against OpenRouter. API keys come only from `~/.claude-chat/settings.json` (`providers.<id>.apiKey`) or that provider's env var, never hardcoded
- engine/claude-cli-engine.ts now picks either the Headroom compression-proxy env or the Anthropic-compatible provider env when spawning `claude`: the two are mutually exclusive (Headroom only applies to the native Claude provider); its `listModels()` is provider-aware too (live OpenRouter list, static Anthropic tiers otherwise). ProcessManager itself is unchanged; Kimi's spawn path is untouched
- socket/handler.ts: when the active provider is Anthropic-compatible (OpenRouter, etc.), the haiku/sonnet/opus tier router and its failure-escalation ladder are skipped since OpenRouter models are full ids, not tiers; the session's chosen model (or the provider's default) is used directly. Usage log entries are now tagged with `provider`/`model`
- New GET /api/providers and GET /api/providers/:id/models routes
- Client: new client/src/stores/providerStore.ts (Zustand) backing the provider dropdown in ChatHeaderControls and the model dropdown in MedusaChat's bottom toolbar; both now render from the live provider/model lists (falling back to a bundled static list offline) instead of a hardcoded 2-provider / 4-tier array
- TokenUsageEntry gained `provider`/`model` fields; UsageSummary (and the /api/metrics/token-usage response, and the token-report.ts CLI) gained a `byModel` breakdown alongside the existing byBot/bySource
- Tests: 4 new test files (env construction for openrouter/claude/kimi, the models route with a mocked fetch, byModel aggregation); server test suite green (12 files / 192 tests), `tsc --noEmit` clean on server and client
- Files affected: server/src/settings/providers.ts (new), server/src/routes/providers.ts (new), server/src/settings/store.ts, server/src/routes/settings.ts, server/src/engine/claude-cli-engine.ts, server/src/headroom/proxy-manager.ts, server/src/socket/handler.ts, server/src/metrics/token-logger.ts, server/src/routes/metrics.ts, server/src/utils/token-report.ts, server/src/index.ts, server/src/settings/__tests__/providers.test.ts (new), server/src/routes/__tests__/providers.test.ts (new), server/src/metrics/__tests__/token-logger.test.ts (new), server/src/engine/__tests__/claude-cli-engine-provider-env.test.ts (new), client/src/api.ts, client/src/stores/providerStore.ts (new), client/src/components/Hub/ChatHeaderControls.tsx, client/src/components/Hub/MedusaChat.tsx

## 2026-09-17 16:45
- Feature: Added a generic `AcpEngine` so Medusa can drive any agent that speaks the Agent Client Protocol (JSON-RPC over stdio), with Code Puppy registered as the first one. Goose (`goose acp`) and Gemini CLI can be added by changing `command`/`args` only
- server/src/engine/acp-engine.ts (new): hand-rolled line-delimited JSON-RPC client (no new npm dependency; `@agentclientprotocol/sdk` exists but the wire format is ~150 lines of framing). Runs initialize, then session/new or session/load for resume, then session/prompt; translates session/update notifications into ClaudeStreamEvents (agent_message_chunk to text delta, tool_call and tool_call_update to tool_use_start and tool_result carrying title/kind/status/content and rendered diffs, plan to a system/info event, stopReason to a result event) and emits a synthetic init event with the ACP session id, model and cwd since ACP never echoes those in one place
- Client callbacks: session/request_permission is answered non-interactively (auto-allow in YOLO mode, auto-reject with an explanatory tool_result otherwise, since the socket layer has no permission plumbing yet); fs/read_text_file and fs/write_text_file are served against the session working directory with path-escape protection; terminal/* returns JSON-RPC -32601
- Abort sends session/cancel before the shared SIGTERM/SIGKILL teardown. A child that dies mid-prompt produces a failed result event instead of hanging the turn. Malformed and partial stdout lines are skipped rather than killing the stream
- server/src/engine/code-puppy-engine.ts (new): registers `code-puppy --acp`, pre-seeds a minimal puppy.cfg (puppy_name/owner_name/model from CODE_PUPPY_* env vars) so the first-run wizard never blocks on stdin, and exposes a static model list. Never overwrites an existing user config
- server/src/engine/types.ts: added `ParsedSystemInfo` and `EngineStreamEvent` (additive; `ClaudeStreamEvent` is unchanged so existing callbacks still type-check)
- Live smoke test against code-puppy 0.0.839 confirmed the handshake, session id, init event, chunk-to-delta mapping and result event. No API key was available, so the run stopped at model load and the tool_call/permission paths are covered by unit tests only. Written up in docs/code_puppy_stream_format.md under "AcpEngine smoke test", with known limitations
- Server tests: 189 before, 212 after; `tsc --noEmit` clean
- Files affected: server/src/engine/acp-engine.ts (new), server/src/engine/code-puppy-engine.ts (new), server/src/engine/types.ts, server/src/engine/registry.ts, server/src/engine/__tests__/acp-engine.test.ts (new), server/src/engine/__tests__/code-puppy-engine.test.ts (new), docs/code_puppy_stream_format.md, CHANGELOG.md

## 2026-09-15 14:50
- Feature: Scaffolded a Tauri v2 desktop shell in desktop/ to replace the hand-rolled Swift/WKWebView app in app/, so Medusa can ship on macOS now and Windows later from one codebase
- desktop/src-tauri/tauri.conf.json: frontendDist points at client/dist with a beforeBuildCommand that builds the client; server/ is compiled into a single sidecar binary registered via bundle.externalBin, with the client's static build shipped alongside it as a bundle resource (bundle.resources)
- desktop/scripts/build-sidecar.sh: builds server/ and client/, then compiles the server into desktop/src-tauri/binaries/medusa-server-<target-triple> via `bun build --compile` (falls back to `npx pkg`, though pkg cannot actually load this server's ESM build - see desktop/README.md)
- desktop/src-tauri/sidecar-src/entry.mjs: the actual sidecar compile entrypoint (not server/dist/index.js directly) - patches the shared fs module so paths server/src/config.ts and friends derive from import.meta.url (which bun's --compile flattens) redirect to a real per-user data directory and the bundled client instead of crashing on the real, read-only filesystem root
- desktop/src-tauri/src/main.rs: on startup, picks a free port, generates an auth token, creates the main window (about:blank + an initialization_script that seeds localStorage's auth token on every page load, mirroring app/Sources/WebViewController.swift), spawns the medusa-server sidecar with PORT/HOST/AUTH_TOKEN env vars, polls GET /api/health until healthy (30s budget, matching ServerManager.swift), then navigates the window to the sidecar's URL; kills the sidecar on window close and app exit
- Verified end-to-end on this machine: `cd desktop && npm install && bash scripts/build-sidecar.sh && npm run tauri build` produces Medusa.app + a .dmg; launching the built .app shows the real onboarding/login/chat UI (auto-authenticated via the injected token) and `curl 127.0.0.1:<port>/api/health` returns `{"ok":true,...}`
- Files affected: desktop/package.json (new), desktop/README.md (new), desktop/scripts/build-sidecar.sh (new), desktop/src-tauri/tauri.conf.json (new), desktop/src-tauri/Cargo.toml (new), desktop/src-tauri/build.rs (new), desktop/src-tauri/src/main.rs (new), desktop/src-tauri/sidecar-src/entry.mjs (new), desktop/src-tauri/capabilities/default.json (new), desktop/src-tauri/icons/* (new)

## 2026-09-15 14:30
- Extracted an `Engine` abstraction from ProcessManager with no behavior change, so new CLIs (Code Puppy next) can be added without touching the socket/hub layers
- New `server/src/engine/`: `types.ts` (Engine interface, EngineSpawnOptions, EngineSessionState, ModelInfo, shared SIGTERM/SIGKILL abort), `claude-cli-engine.ts` and `kimi-cli-engine.ts` (bodies moved verbatim from spawnClaude/spawnKimi, including the resume and token-limit retry paths), `registry.ts` (provider id to Engine, Claude as the fallback)
- ProcessManager now resolves an engine from the registry and delegates spawn/abort; its public API and emitted event shapes are unchanged
- New tests cover the registry and the exact Claude argv for new session, resume, yolo, custom model and system prompt (child_process.spawn is mocked, no real processes)
- Server tests: 175 before, 189 after; `tsc --noEmit` clean on server and client
- Files affected: server/src/claude/process-manager.ts, server/src/engine/types.ts, server/src/engine/claude-cli-engine.ts, server/src/engine/kimi-cli-engine.ts, server/src/engine/registry.ts, server/src/engine/__tests__/claude-cli-engine.test.ts, server/src/engine/__tests__/registry.test.ts, CHANGELOG.md

## 2026-09-15 13:40
- Docs: added planning doc for Cowork parity, Tauri shell, and model-agnostic engine (Option C: Engine interface with ClaudeCliEngine + open harness engine; OpenRouter first; Tauri sidecar for the Node server). Planning only, no code changed
- Files affected: docs/2026-09-15_cowork_parity_tauri_agnostic_plan.md (new)

## 2026-08-06 16:57
- UI: Extended the same bottom toolbar (compact mic, model picker, token-usage ring) to the Hub input, for consistency with Medusa Chat
- Hub has no single "active bot", so the model picker there controls Medusa's model specifically — she's the default responder for hub posts without an @mention
- Files affected: client/src/components/Hub/HubFeed.tsx

## 2026-08-06 16:23
- UI: Moved the model picker, mic, and token-usage ring into a bottom toolbar under the Medusa Chat input, matching Claude Code's own bar layout (mic bottom-left, model + usage bottom-right) instead of cluttering the top header/sidebar
- MicButton: new `compact` prop — a small, chrome-less icon variant (22px, no circle) for this toolbar, vs the existing 36px circular button still used in the Hub input
- TokenRing: new `popoverDirection` prop (`'up' | 'down'`) so the usage popover opens upward when the ring sits in a bottom bar, instead of running off the bottom of the viewport
- ChatHeaderControls: removed the model select (kept Agent + Provider) — model now lives solely in the new bottom bar to avoid duplicating the control
- Sidebar: removed the token-usage ring from the top header (moved to the chat's bottom bar)
- Verified visually: model select shows the active bot's model, mic still dictates, token popover opens upward and stays fully on-screen
- Files affected: client/src/components/Hub/MedusaChat.tsx, client/src/components/Hub/ChatHeaderControls.tsx, client/src/components/Input/MicButton.tsx, client/src/components/Usage/TokenRing.tsx, client/src/components/Sidebar/Sidebar.tsx

## 2026-08-05 18:59
- Feature: Multi-machine runner protocol MVP — "one brain, many hands" (Features.md #3)
- New server/src/runner/runner-manager.ts: brain-side manager on an io.of("/runner") Socket.IO namespace, gated by the same AUTH_TOKEN (constant-time compare). Tracks connected runners by name; exec(name, command, cwd) dispatches a shell command and awaits the result (30s timeout)
- New server/src/runner/runner-client.ts: standalone daemon (run via `node dist/runner/runner-client.js --name <machine> --brain <url> --token <token>`) that dials OUT to the brain (no inbound port needed on the runner machine), registers under a name, and executes commands via child_process.exec, returning stdout/stderr/exitCode
- New GET/POST /api/runners routes (list connected runners; POST /:name/exec to run a command)
- Note: this ships the exec PRIMITIVE only — bot sessions still always spawn locally (ProcessManager unchanged). Routing an actual bot session to a chosen runner is a larger follow-up once this primitive is proven
- Validated end-to-end locally with two simulated runners ("mac-mini" + "laptop") against the live brain: registration, listing, successful exec with custom cwd, nonzero-exit handling, 404 for an unconnected runner name, clean removal on disconnect, and rejection of a wrong auth token — all confirmed via direct curl + a raw socket.io-client probe
- Files affected: server/src/runner/runner-manager.ts (new), server/src/runner/runner-client.ts (new), server/src/routes/runners.ts (new), server/src/index.ts, server/package.json (added socket.io-client dependency)

## 2026-08-05 18:46
- Feature: Native iOS Simulator live view + take-over (Features.md #5), and installable PWA support (Features.md #8)
- New "Simulator" sidebar view (server/src/cowork/simulator-stream.ts, client SimulatorPane.tsx): streams a booted iOS Simulator's screen via `idb screenshot` polling (~900ms) over Socket.IO (simulator:frame/status), with tap/swipe/text/hardware-button take-over via `idb ui tap/swipe/text/button` (simulator:input). Correctly converts normalized [0,1] coords to the simulator's POINT space (from `idb describe`'s screen_dimensions.width_points/height_points), not pixel space — the two differ by the device's Retina scale factor
- Installable PWA: manifest.json + generated icons (192/512/apple-touch) + a deliberately no-cache service worker (installability only — a live chat/socket app must not risk stale cached responses) + registerServiceWorker.ts wired into main.tsx
- Both features validated end-to-end by a subagent against the REAL running app and a REAL booted simulator ("Narrator Test"): live frame matched an independently-taken idb screenshot, Home button verifiably changed the simulator's screen (cross-checked via idb), a tap opened Settings on the simulator (cross-checked via idb), text input worked without errors; PWA manifest/icons/service-worker/meta-tags all verified live via fetch + serviceWorker.getRegistration()
- Files affected: server/src/cowork/simulator-stream.ts (new), client/src/components/Cowork/SimulatorPane.tsx (new), client/src/registerServiceWorker.ts (new), client/public/manifest.json (new), client/public/sw.js (new), client/public/icon-192.png, icon-512.png, apple-touch-icon.png (new), server/src/socket/handler.ts, server/src/index.ts, client/src/App.tsx, client/src/main.tsx, client/src/stores/sessionStore.ts, client/src/components/Sidebar/Sidebar.tsx, client/index.html

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
