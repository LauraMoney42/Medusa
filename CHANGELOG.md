## 2026-09-18 15:30
- Rebased the S16 "live voice" branch onto main's echo/self-interruption fix. Both behaviors are kept: the `BargeInDetector` path (ignored echo onsets, adaptive floor, dropped echo transcripts, the 200-event ring buffer) and S16's warm engines, streaming partials, speculative start and first-clause audio
- `server/src/voice/session.ts`: the two features are wired together rather than merely coexisting. A new `echoSuspect` getter is true whenever the barge-in detector is armed (thinking, speaking, or the grace window) without having confirmed a real interruption, or the open onset was already written off as echo. It now gates BOTH `handlePartial` (no `voice:partial` for her own voice leaking back) and `checkSpeculation`, so a speculative turn can never start from an echo onset; an echo transcript also clears any standing hypothesis
- `server/src/socket/voice-handlers.ts` keeps the `bargeIn` payload on `voice:start` alongside warm mode and partials; `server/src/routes/voice.ts` returns the barge-in defaults and `?events=1` ring buffer alongside the S16 tuning and live-mode status; Settings > Voice shows the echo guard/barge-in card and the S16 live card as separate sections
- Bug found by the live pass and fixed (pre-existing in S16, not caused by the rebase): when a corrected speculative start aborted its turn, the abandoned turn settled with its own `message:stream:end` (the warm Kimi engine's `session/cancel`), which the stream tap cannot attribute to a turn and which lands AFTER the replacement's `message:stream:start`, so `streamStarted` could not separate them. That event closed the live turn's TTS and the reply was never spoken. `VoiceSession` now counts `abandonedTurns` at the two abort-and-restart sites and consumes the first settle event in `onStreamEnd`/`onStreamError`
- `server/src/routes/__tests__/voice.test.ts`: its `providers.js` mock gained `listRealtimeProviders`, which the merged route now calls
- Verified: `cd server && npx tsc --noEmit` clean, `npx vitest run` 626 passed (560 from main plus S16's 64, plus 2 new: the abandoned-turn settle event, and "never speculates on a partial heard while she is the one talking"); `cd client && npx tsc -b --noEmit && npm run build` clean. Live pass on a throwaway server (PORT=3992, its own scratch HOME, port 3456 and the owner's Whisper/Kokoro untouched except as a read-only HTTP caller), one Kimi turn with warm mode on: `voice: engine kimi-warm (warm)`, one `voice:transcript` ("Count from 1 to 15."), one `voice:latency` (`warm: true, speculative: true`, 4116 ms to first word). Replaying a decoded reply chunk back as mic frames while speaking, attenuated to the 1200 RMS that actually leaks from laptop speakers, logged `ignored echo onset (energy 1477)` with zero barge-ins and zero `voice:stop-audio` before teardown; the same chunk replayed at full scale does barge in, as it should
- Files affected: server/src/voice/session.ts, server/src/socket/voice-handlers.ts, server/src/routes/voice.ts, server/src/routes/__tests__/voice.test.ts, server/src/voice/__tests__/session-speculation.test.ts, client/src/components/Settings/VoiceTab.tsx, CHANGELOG.md

## 2026-09-18 15:05
- Feature (workstream S16 "live" voice, docs/2026-09-18_s14_voice_loop_spec.md section 7b): make speech to speech as live as the local stack allows. The S14 QA pass measured 12.7 s from speech end to first spoken word, 10.5 s of it the Kimi CLI's time to first token, because a CLI was spawned per turn. Measured on this machine after this change: 1.9 to 2.0 s to first token on a warm turn, 2.2 to 2.6 s to the first spoken word
- Warm engines. New `server/src/engine/warm-claude-engine.ts` keeps one `claude` process per chat in the CLI's own long-lived mode (`-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`, verified against the installed CLI and by a live probe), feeding one `{"type":"user"}` line per turn and settling each turn on its `{"type":"result"}` line; flags that are fixed at process start are hashed into a signature so a model or prompt change retires the process. New `server/src/engine/kimi-acp-engine.ts` runs Kimi as `kimi acp` through the existing `AcpEngine`, which gained a `persistent` mode: the child, its connection and its ACP session survive between turns, per-turn callbacks are swapped through one mutable router, and `abort()` is `session/cancel` rather than a kill
- Routing: `ProcessManager.setWarmMode(sessionId, warm)` swaps the harness for the warm variant of the same engine (`warmEngineIdFor` in `engine/registry.ts`) and leaves the provider env alone; `voice:start` turns it on, `voice:stop` turns it off and releases the process, `closeAllWarmProcesses()` runs on shutdown. Cold engines stay registered, stay the default for typed chats, and stay the fallback
- Streaming STT. New `server/src/voice/streaming-stt.ts` defines `StreamingSttProvider` (`push`, `partial`, `final`). The running Whisper server exposes only `/v1/models` and `/v1/audio/transcriptions` (checked against its own OpenAPI document), so `RollingWindowSttProvider` re-transcribes the utterance so far every 700 ms instead, bounded by one request in flight, a 300 ms floor and a 15 s cap, off `Vad.snapshot()` (new). `DeepgramStreamingSttProvider` is the optional cloud implementation behind the same interface, keyed from the providers settings, off by default. `voice:partial` now carries the growing text, about 1.2 s after speech starts
- Speculative start. New `server/src/voice/speculation.ts`: a partial that is stable for 400 ms and ends in sentence punctuation (an ellipsis does not count, since Whisper writes one for every truncated window), or is confirmed by a second identical partial after a 700 ms pause, starts the engine turn early. When the final transcript arrives the turn is kept unless normalized Levenshtein exceeds 0.25 or the guess is a strict prefix of what was actually said; otherwise it is aborted and restarted. The abandoned turn's tail can no longer be spoken or report its latency
- First-clause audio. `sentence-chunker.ts` gained a first-clause mode (comma, semicolon, colon or spaced dash, or 60 characters) for the FIRST chunk of a reply only. Measured on a two-sentence reply, first speakable text to first audio: 1462 and 1185 ms with whole sentences, 566 and 499 ms with clauses
- Live mode, interface plus a documented stub: `server/src/voice/realtime.ts` defines `RealtimeVoiceProvider` and implements `OpenAiRealtimeProvider` over a server-side WebSocket, with every Medusa MCP tool (`spawn_agent`, `agent_status`, `agent_result`, `list_agents`, `cancel_agent`) handed over as a function definition and every call bridged to Medusa's own HTTP API, so orchestration stays here. NOT wired to the socket layer yet: nothing routes `voice:audio` into a realtime session or posts both transcripts into the chat. `GET /api/voice/status` reports `realtime.implemented: false` and Settings disables the toggle with that explanation
- Settings > Voice: "Warm engine (faster replies)" (on by default), "Live transcript while you talk" (local / Deepgram / off), "Answer before you finish" (on), "Speak the first clause early" (on), and a disabled "Live mode (realtime model)" with a provider select. All six persist on the voice pack (`VoiceSchema`) and are read server-side when a voice session is created. `Toggle.tsx` gained an optional `disabled`
- Two loop bugs found and fixed while measuring: an abort that landed during the warm agent's handshake killed the process warm mode had just started (the speculative-start path does this constantly), and a cancelled turn's TTS stream fired `voice:latency` with empty timings, which then suppressed the real turn's numbers
- Verified: `cd server && npx tsc --noEmit` clean, `npx vitest run` 607 passed (543 on main plus 64 new across warm-engine argv/framing, warm routing, partial timing on synthetic PCM, the speculative abort/restart decision, the first-clause chunker and the realtime function-call bridge with a fake WebSocket); `cd client && npx tsc -b --noEmit` clean. Live check on a throwaway server (PORT=3993, its own scratch HOME, port 3456 and the owner's Whisper/Kokoro servers untouched except as read-only HTTP callers) driving the socket contract with `say`-generated WAVs: cold first token 4381/3035/3186 ms against warm 3144 (first turn, process start included)/1969/1936 ms
- Files affected: server/src/engine/{warm-claude-engine,kimi-acp-engine}.ts (new), server/src/engine/{acp-engine,registry}.ts, server/src/claude/process-manager.ts, server/src/voice/{streaming-stt,speculation,realtime}.ts (new), server/src/voice/{session,stt-stream,tts-stream,sentence-chunker,vad,providers}.ts, server/src/socket/voice-handlers.ts, server/src/routes/voice.ts, server/src/packs/schema.ts, server/src/settings/providers.ts, server/src/index.ts, server/src/engine/__tests__/warm-claude-engine.test.ts (new), server/src/claude/__tests__/process-manager-warm.test.ts (new), server/src/voice/__tests__/{streaming-stt,speculation,session-speculation,first-clause,realtime}.test.ts (new), server/src/socket/__tests__/voice-handlers.test.ts, server/src/packs/__tests__/store.test.ts, client/src/components/Settings/{VoiceTab,Toggle}.tsx, client/src/stores/voiceStore.ts, client/src/api.ts, docs/2026-09-18_s14_voice_loop_spec.md, CHANGELOG.md

## 2026-09-18 15:00
- Fix (owner, desktop app, always-on mic, laptop speakers): "sometimes she speaks and sometimes it's just text." Root cause: `server/src/voice/session.ts`'s `handleSpeechStart` stopped playback on any VAD speech onset while state was speaking, and the VAD (`server/src/voice/vad.ts`, energy threshold 500) used the same threshold whether Medusa was silent or talking. Her own reply, coming back through the laptop speakers into the always-on mic, easily cleared that threshold, so the barge-in path fired on her own voice and cut the rest of the reply to text
- New `server/src/voice/barge-in.ts`: `BargeInDetector`, consulted only while thinking, speaking, or for 400 ms after speaking ends (`graceMs`). Requires frame energy above `bargeInEnergyThreshold` (default 2000, 4x the base VAD threshold) sustained for `bargeInMinSpeechMs` (default 300 ms) before it counts as a real interruption; normal listening still uses the plain `Vad`. Adaptive floor: the first 500 ms (`floorMeasureMs`) of each turn's playback measure the incoming echo level, and the threshold is raised to `floorMultiplier` (default 2x) that level when higher than the static default, so loud speaker volume cannot defeat the fix
- `server/src/voice/vad.ts`: added an `onFrame` hook fired for every processed frame with its raw RMS energy, independent of the VAD's own gate, so the barge-in detector can sample the mic continuously without duplicating frame math
- `server/src/voice/session.ts`: `handleSpeechStart` now only opens a barge-in candidate window (`bargeIn.beginOnset()`) instead of stopping playback immediately; the real stop happens from a new `handleVadFrame` once the sustained window passes (about 100 ms after, the cost of the `voice:stop-audio` emit and client flush). A weak or short onset is logged as `voice: ignored echo onset (energy N, ms M)` and its eventual transcript is dropped silently (logged as `voice: dropped echo transcript "..."`) instead of being posted as a user message. A confirmed barge-in logs `voice: barge-in confirmed (energy N, ms M)`. Also added a 200-entry ring buffer of voice events (state changes, ignored onsets, barge-ins, latencies) per session, exposed via `VoiceSession.getEvents()`
- `server/src/routes/voice.ts`: `GET /api/voice/status` now also returns the barge-in defaults; `?events=1` adds each session's event ring buffer so the owner can share it
- `server/src/socket/voice-handlers.ts`: `voice:start` accepts an optional `bargeIn` payload (mirrors the existing `vad` one) and threads it into `VoiceSession.start()`
- Client: `client/src/stores/voiceStore.ts`'s default `echoGuardDuckFactor` lowered from 0.35 to 0.15, plus new persisted `bargeInEnergyThreshold`/`bargeInMinSpeechMs` fields sent on `voice:start`. `client/src/components/Voice/VoiceMicButton.tsx`'s echo guard now holds the duck level for 400 ms after `loopState` leaves "speaking" instead of releasing immediately, matching the server's grace window. `client/src/components/Settings/VoiceTab.tsx` gained an Echo guard card exposing the duck level and both barge-in thresholds with help text
- Tests: `server/src/voice/__tests__/barge-in.test.ts` (new, unit-level: playback leakage in the 800-1500 range never fires, a sustained 5000-energy/400ms burst fires at the 300ms mark, a 60ms loud click doesn't, the adaptive floor raises the threshold, `deactivateAfterGrace`/`deactivate` lifecycle); `server/src/voice/__tests__/vad.test.ts` gained an `onFrame` coverage test; `server/src/voice/__tests__/session.test.ts` gained end-to-end PCM-level coverage for the same scenarios plus the dropped-echo-transcript and barge-in-confirmed Activity Log lines, and one pre-existing test that asserted the old "stop on any onset" behavior was updated to assert the new sustained-threshold behavior instead; `server/src/routes/__tests__/voice.test.ts` (new) covers the `?events=1` status endpoint. `cd server && npx tsc --noEmit && npx vitest run` green (560 tests, up from 543 on main). `cd client && npx tsc -b --noEmit && npm run build` clean
- Files affected: server/src/voice/barge-in.ts (new), server/src/voice/vad.ts, server/src/voice/session.ts, server/src/routes/voice.ts, server/src/socket/voice-handlers.ts, server/src/voice/__tests__/barge-in.test.ts (new), server/src/voice/__tests__/vad.test.ts, server/src/voice/__tests__/session.test.ts, server/src/routes/__tests__/voice.test.ts (new), client/src/stores/voiceStore.ts, client/src/components/Voice/VoiceMicButton.tsx, client/src/components/Settings/VoiceTab.tsx

## 2026-09-18 14:41
- Fix: desktop voice was disabled because STT defaulted to cloud Whisper (https://api.openai.com/v1, whisper-1) when the auto-generated .env had no STT_* keys; the default is now the local faster-whisper server (http://localhost:8000/v1, base.en, key "local"), matching TTS
- Files affected: server/src/config.ts

## 2026-09-18 19:40
- Fix: New Chat modal's folder step was effectively unusable in the built desktop app ("Pick a project folder for this chat" with no way to browse or type one in). Root cause: `tauri.conf.json` sets `withGlobalTauri: true`, but that flag only injects the core `invoke`/`event`/`path`/`window` bindings onto `window.__TAURI__`; the convenience wrappers `window.__TAURI__.dialog.open` and `window.__TAURI__.shell.open` only exist when the matching `@tauri-apps/plugin-dialog` / `@tauri-apps/plugin-shell` npm packages are bundled into the frontend, and this app never added them (only the Rust plugin crates were registered in `desktop/src-tauri/src/main.rs`). So `hasNativePicker` was always false in the packaged app, hiding the Browse button, and the folder text input's own state was fine but there was no way to confirm the picker path worked at all
- `client/src/components/Sidebar/NewChatModal.tsx`: the folder text field is now unconditionally editable/submittable in every environment (this was mostly already true; added a `pickerNotice` line instead of silently failing). Browse now calls, in order: the new Rust `pick_folder` command via `window.__TAURI__.core.invoke('pick_folder', {defaultPath})` (needs no JS plugin package), then falls back to `core.invoke('plugin:dialog|open', {options:{directory:true, multiple:false, defaultPath}})` (verified command name/shape against the tauri-plugin-dialog v2 source). A `cancelled` vs `unavailable` result distinguishes "user backed out of the dialog" from "native picker isn't wired up, type a path" so the notice only shows when genuinely needed
- `desktop/src-tauri/src/main.rs`: added `#[tauri::command] pick_folder(app, default_path)` using `tauri_plugin_dialog::DialogExt`'s `app.dialog().file().set_directory(...).blocking_pick_folder()`, and `reveal_in_finder(path)` shelling out to `open -R`. Both registered in `tauri::generate_handler!`; no capability grant needed since they are plain app commands, not plugin commands
- `client/src/components/Chat/ChatView.tsx`: folder chip's open-in-Finder handler now tries `reveal_in_finder` first, then `plugin:shell|open` through `core.invoke`, then falls back to copying the path to the clipboard (unchanged behavior in a plain browser)
- Verified: `cd client && npx tsc -b --noEmit && npm run build` clean; `cd desktop && PATH="$HOME/.bun/bin:$PATH" bash scripts/build-sidecar.sh && PATH="$HOME/.bun/bin:$PATH" npm run tauri build` succeeded, producing `Medusa.app`. Launched the built app from this worktree (separate port, never touched port 3456 or the owner's running Medusa.app/medusa-server processes, both verified alive throughout and afterward by pid). Confirmed via direct `POST /api/sessions` that a typed absolute path creates a session and an invalid path returns `{"error":"Invalid working directory"}`. Drove the actual built app's New Chat modal end to end (screenshots in the session's scratchpad): typed `/Users/macair/Documents/GIT/Medusa/server` into the folder field, clicked Create chat, and a new "server" chat appeared with `Working in /Users/macair/Documents/GIT/Medusa/server`; deleted that test session and the earlier API test session afterward, leaving the two pre-existing real chats untouched
- Also noted, not fixed (separate from this bug and flagged for follow-up): the server's `resolveWorkingDir` in `server/src/routes/sessions.ts` does not expand a leading `~`, so pasting the field's own placeholder text (`~/Documents/GIT/Medusa`) literally would resolve to a nonexistent `<home>/~/Documents/GIT/Medusa` and fail; only plain absolute or home-relative-without-tilde paths work today
- Files affected: client/src/components/Sidebar/NewChatModal.tsx, client/src/components/Chat/ChatView.tsx, desktop/src-tauri/src/main.rs

## 2026-09-18 14:35
- UI change (owner's request, docs/2026-09-18_s14_voice_loop_spec.md section 4): moved the mic into the text input bar as a single toggle at the far right, immediately left of send. Layout is now [attach] [text field] [mic] [send]. Removed the old `VoiceBar` strip (mode toggle tabs, waveform canvas, state label, mute button, interrupt button, latency badge) and the legacy push-to-talk `MicButton` from the input row
- New `client/src/components/Voice/VoiceMicButton.tsx` (replaces `Voice/VoiceBar.tsx` and `Input/MicButton.tsx`, both deleted, along with the now-unused `hooks/useDictationInsert.ts`): owns the same audio wiring VoiceBar used to (mic capture, playback `AudioContext`, gapless TTS scheduling via the untouched `lib/voice/audioScheduler.ts`/`micCapture.ts`). Click toggles always-on voice on/off; while the assistant is speaking a click sends `voice:interrupt` instead of stopping; a long-press (600ms) or Esc always stops the loop outright. Icon color: muted when off, accent green with a soft CSS pulse ring while listening, amber while thinking, blue with a small animated 3-bar glyph while speaking, danger red with a tooltip on error. A compact 24px waveform renders inside the button while listening/speaking. The text field's placeholder becomes "Listening..." then the live partial transcript while listening, clearing once voice mode goes back to idle
- Push-to-talk stays reachable only through Settings > Voice's existing "Voice mode default" (no push-to-talk affordance in the primary toggle); the hold-Space and Esc shortcuts still work exactly as before when that default is push-to-talk. `voiceStore`'s existing `mode` persistence (localStorage) means a reload with voice left on re-requests the mic and resumes always-on automatically
- Mute-speaker control moved out of the old VoiceBar strip: reused the chat header's existing speaker icon (`ChatView.tsx`'s `toggleSpeak`, now also flips `voiceStore.speakerMuted`) and added a matching toggle to `components/Settings/VoiceTab.tsx`, plus help text there documenting the toggle/interrupt/hold-to-stop behavior
- New keyframes in `client/src/styles/global.css`: `micPulseRing` (`.medusa-mic-listening`) and `micBarBounce` (`.medusa-mic-bars`)
- Did not touch `lib/voice/audioScheduler.ts` or `pcmDownsample.ts` (no algorithm changes needed); their existing `node --test` suite still passes 17/17
- Screenshots at 1440x900: `docs/screenshots/mic-{off,listening,speaking}.png`, replacing the old `voice-*.png` set (deleted: off, push-to-talk, always-on, listening, thinking, speaking). Captured with a throwaway Playwright script against a Vite dev server on port 5195 (this worktree's own port; server/ and port 3456 were never touched). Since there's no backend to log into here, the shots were driven the same way the S14-C agent's were: a temporary, fully-reverted bypass of `App.tsx`'s auth gate for this session only, plus fixture `sessionStore`/`chatStore`/`providerStore`/`voiceStore` state injected through Vite's dev module graph (no `window.__voiceStore` hook left behind, and `App.tsx` has zero net diff)
- Verified: `cd client && npx tsc -b --noEmit && npm run build` clean
- Files affected: client/src/components/Voice/VoiceMicButton.tsx (new), client/src/components/Voice/VoiceBar.tsx (deleted), client/src/components/Input/MicButton.tsx (deleted), client/src/hooks/useDictationInsert.ts (deleted), client/src/components/Chat/ChatView.tsx, client/src/components/Settings/VoiceTab.tsx, client/src/styles/global.css, docs/screenshots/mic-{off,listening,speaking}.png (new), docs/screenshots/voice-*.png (deleted), CHANGELOG.md

## 2026-09-18 14:10
- Feature (workstream S15, docs/2026-09-17_ui_and_layer_addendum.md "Right panel"): a persistent Tasks panel, a third tab next to Browser and Simulator, showing everything Medusa is doing in the background across every chat, not just the current one
- New `client/src/components/Tasks/TasksPanel.tsx`: sections Running and Recent (last 20 finished, collapsible). Each row shows kind (Subagent, Follow-up queued, or Voice turn while the voice loop is not idle), name/task summary, chat title, engine/model, a live elapsed timer, a status pill, a Stop button (hidden once nothing can be cancelled), and click-to-jump: switches to that chat and scrolls its `SubagentCard` into view via a new `id="subagent-card-<agentId>"` anchor added to `client/src/components/Chat/SubagentCard.tsx`. Empty state: "Nothing running. Medusa's subagents and follow-ups will show up here."
- New `client/src/stores/tasksStore.ts`: owns the two things `subagentStore` does not carry, a `hydrated` snapshot from `GET /api/subagents?all=1` (so a reload still shows what is running instead of coming up empty until the next socket event) and `followupQueued`, set by the `followup:queued` / `followup:delivered` handlers already in `useSocket.ts`. `buildTaskRows()` merges live `subagentStore` data with the hydrated snapshot (live wins), adds a follow-up row per pending follow-up and a voice-turn row when `voiceStore.state !== 'idle'`. `countRunningSubagents()` powers the header badge without mounting the panel
- `client/src/components/RightPanel/RightPanel.tsx` and `stores/layoutStore.ts`: `PanelTab` gained `'tasks'`, rendered as a third tab bar entry mounting `TasksPanel`, same always-mounted-but-hidden pattern as Browser/Simulator
- `client/src/components/Chat/ChatHeaderControls.tsx`: a fourth header icon (checklist glyph) with a red badge showing the count of running tasks across every chat; click opens the panel on Tasks. `client/src/App.tsx`: Cmd+Shift+T toggles it (plain Cmd+T is the browser's own new-tab shortcut and never reaches page JS, so Shift avoids that collision) and hydrates `tasksStore` once on mount
- `server/src/routes/subagents.ts`: `GET /?all=1` returns every chat's subagents tagged with `parentSessionId`, for the panel's hydrate-on-load call only (the MCP shim never sets this, so a chat still cannot ask about another chat's subagents through the normal per-parent path). `server/src/subagents/manager.ts` gained `listAll()` to back it, covered by a new test in `manager.test.ts`
- `client/src/api.ts`: new `fetchAllSubagents()` wrapping the route above
- Screenshots at 1440x900: `docs/screenshots/tasks-{empty,running}.png`, taken with Playwright (chromium) driving a throwaway server (its own scratch `HOME`/data dir and port 3999, port 3456 untouched) plus a throwaway Vite on port 5196, since the socket/store wiring is easier to script than to click through by hand. The "running" shot injects fixture subagent records straight into `subagentStore`/`sessionStore` via Vite's dev module graph rather than spawning a real engine process
- Verified: `cd client && npx tsc -b --noEmit && npm run build` clean; `cd server && npx tsc --noEmit && npx vitest run` clean at 543 tests (542 on main plus 1 new)
- Files affected: client/src/components/Tasks/TasksPanel.tsx (new), client/src/stores/tasksStore.ts (new), client/src/components/RightPanel/RightPanel.tsx, client/src/stores/layoutStore.ts, client/src/components/Chat/ChatHeaderControls.tsx, client/src/components/Chat/SubagentCard.tsx, client/src/hooks/useSocket.ts, client/src/App.tsx, client/src/api.ts, server/src/routes/subagents.ts, server/src/subagents/manager.ts, server/src/subagents/__tests__/manager.test.ts, docs/screenshots/tasks-empty.png, docs/screenshots/tasks-running.png

## 2026-09-18 13:57
- QA (S14-QA, docs/2026-09-18_s14_voice_loop_spec.md sections 3/4/7/8): drove the running app's socket contract directly with node scripts (socket.io-client, auth token from `.env`) against session "Medusa 2" (`6894ddfe-...`), plus the Vite client in the Browser pane, per the acceptance script
- Results: 1 basic voice loop PASS (transcript, voice-tagged `message:user`, ordered/WAV-decodable `voice:audio-chunk`s, `voice:speaking-start/end`, `voice:latency`); measured sttMs 303, firstTokenMs 10544, firstAudioMs 1881, totalMs 12730, over the 800 ms target, entirely in the Kimi engine's time-to-first-token (pipeline overhead itself is small: stt 303 ms, audio 1881 ms); not chased, per the QA brief. 2 barge-in PASS: `voice:stop-audio` 141 ms after the first audio chunk, new turn carried the interruption prefix, reply to the new question arrived. 3 follow-up PASS: immediate arithmetic answer while the subagent ran, `followup:queued`/`followup:delivered` fired, the delivered turn was `role: "system", kind: "followup", source: "agent-followup"` (not a user bubble), reply cited the count; confirmed separately that a follow-up reply also produces `voice:audio-chunk`s when voice mode is on. 4 voice-off PASS: a text message with voice previously stopped produced zero voice events
- Found and fixed a real FAIL in acceptance item 5 (Settings > Voice): `PUT /api/medusa/voice` silently dropped `voiceMode`, `vadSensitivity`, `silenceTimeoutMs` and `interruptBehavior` because `server/src/packs/schema.ts`'s `VoiceSchema` never declared them (a zod object schema drops unknown keys), so a saved change never survived even a page reload; separately, `VoiceBar.tsx` never read the saved settings back into the `voice:start {vad}` payload, so even a persisted value would not have reached the running `VoiceSession`'s VAD. Confirmed both independently by direct `curl` PUT/GET round trips and a socket script comparing time-to-`transcribing` under a custom `silenceMs`
- Fix: added the four fields to `VoiceSchema` (with the same ranges the client already enforced) so they persist in `voice.json`; `VoiceBar.tsx` now fetches `/api/medusa/voice` once on mount and sends `vad: {silenceMs, energyThreshold}` (sensitivity mapped linearly, 1500 down to 100 RMS units) on every `voice:start`. `client/src/types/voice.ts`'s `VoiceStartPayload` documents the new `vad` field. Per-chat `voiceModel` via `PATCH /api/sessions/:id` was already correctly wired; re-verified with a PATCH/GET round trip
- Re-verified after the fix: `PUT`/`GET /api/medusa/voice` round-trips all four fields; a `voice:start {vad:{silenceMs:150}}` socket call reached `transcribing` 104 ms after the last speech frame (vs. the 600 ms default), confirming the value reaches the server's `Vad`, not just voice.json
- Not independently verified: the Settings UI itself and the browser console sweep (acceptance items 5's UI half and 6): the app requires an auth-token login, and the task's own instructions prohibit typing the token into any UI field, so this pass relied on direct HTTP/socket calls instead of the logged-in browser for those two checks
- Tests: `cd server && npx tsc --noEmit` clean, `npx vitest run` 542/542 passed (one test literal updated for the new required `Voice` fields); `cd client && npx tsc -b --noEmit` clean, `npm run build` succeeded
- Files affected: server/src/packs/schema.ts, server/src/packs/__tests__/store.test.ts, client/src/components/Voice/VoiceBar.tsx, client/src/types/voice.ts, CHANGELOG.md

## 2026-09-18 13:40
- Feature (workstream S14-C of docs/2026-09-18_s14_voice_loop_spec.md, sections 1/4/6/7): client half of the speech-to-speech conversation loop. Built against the section 7 socket event contract while the server side (S14-A/S14-B) is written in parallel by other agents; no server code was touched
- New `client/src/components/Voice/VoiceBar.tsx`: replaces the mic button in the input bar when voice mode is not "off". Mode toggle (Off / Push to talk / Always on), a live waveform canvas driven by an `AnalyserNode`, a state label (Listening / Thinking / Speaking), a mute-speaker button, and an Interrupt button that emits `voice:interrupt` and stops local playback. Hold-to-talk in push-to-talk mode via mouse/touch or by holding Space (only when the chat input is empty and unfocused, per the spec); Esc always interrupts
- New `client/src/lib/voice/`: `pcmDownsample.ts` (linear-interpolation resample plus float-to-PCM16 requantization, and the echo-guard duck function), `audioScheduler.ts` (`GaplessAudioQueue`, scheduling `voice:audio-chunk` buffers back to back via `AudioBufferSourceNode.start(when)`, buffering out-of-order `seq` until contiguous, `stopAll()` for `voice:stop-audio`), `micWorkletSource.ts` (the inline `AudioWorkletProcessor` source, loaded through a Blob URL, downsampling mic audio to 16 kHz PCM16 in 100 ms frames, no new dependency), `micCapture.ts` (getUserMedia -> AudioWorklet wiring plus a `GainNode` for the echo guard and an `AnalyserNode` for the waveform), and `voiceBus.ts` (a tiny pub/sub seam between `useSocket`, mounted once high in the tree, and VoiceBar's own AudioContext, for the two binary/high-frequency events)
- New `client/src/stores/voiceStore.ts`: mode, loop state, partial transcript, speaker mute, echo-guard settings and last latency reading; mode/mute/echo-guard persist to localStorage like `ttsStore`. Final transcripts are not added locally: they arrive as normal `message:user` events from the server, per the spec, so the store only ever shows the live partial
- `client/src/hooks/useSocket.ts`: added listeners for `voice:state`, `voice:partial`, `voice:transcript`, `voice:audio-chunk`, `voice:stop-audio`, `voice:latency`, `followup:queued` and `followup:delivered`. The 5-state server machine (`idle/listening/transcribing/thinking/speaking`) collapses `transcribing` into the client's `listening` label. `voice:latency` and the two `followup:*` events also push a line into the Activity Log
- `client/src/stores/activityStore.ts` + `components/Activity/ActivityLogPanel.tsx`: new `voice_latency` (distinct purple badge, "voice") and `followup` kinds so both show up at a glance in a busy log
- `client/src/types/message.ts`: `ChatMessage.role` gains `"system"`, plus optional `kind`/`source`/`agentId`. New `isFollowupMessage()` treats `role: "system"`, `kind: "followup"`, or `source: "agent-followup"` as the same thing, since S14-B's follow-up payload shape isn't final until it merges (`FOLLOWUP_CONTRACT.md` doesn't exist yet on main). `client/src/components/Chat/ChatView.tsx` renders a matching message as a compact centered chip instead of a `MessageBubble`, bypassing `MessageBubble.tsx` entirely (S6 still owns that file)
- `client/src/types/session.ts` + `api.ts`: `SessionMeta.voiceModel` (per-chat voice-turn model override) and `updateSession()`'s patch type gained the same field, PATCHed through the existing `/api/sessions/:id` route
- `client/src/api.ts`: `MedusaVoice` gained optional `voiceMode`, `vadSensitivity`, `silenceTimeoutMs`, `interruptBehavior`, round-tripped through the existing `/api/medusa/voice`, tolerant of the server not yet persisting them (S14-A's pack schema isn't final)
- `client/src/components/Settings/VoiceTab.tsx`: new "speech-to-speech loop" card: voice mode default, VAD sensitivity slider, silence timeout slider, interrupt behavior (abort vs queue), and a per-chat voice model override dropdown (reuses `useProviderStore`'s model list for the chat's own provider) that PATCHes `voiceModel` directly
- Contract assumptions made ahead of the server landing (called out since S14-A/B are still in flight): `voice:audio-chunk.data` may be base64 or binary per the spec text, so VoiceBar handles both; `voice:audio-chunk` chunks are assumed to need out-of-order buffering by `seq` (the spec doesn't guarantee order under concurrent sentence synthesis) rather than trusting arrival order; the mic echo guard ducks the sent signal to a configurable factor (default 0.35) rather than muting outright, per the spec's own documented tradeoff
- Tests: no vitest is configured in `client/` (checked `package.json`), so per the quality bar this is a small `node:test` suite instead: `client/src/lib/voice/__tests__/{pcmDownsample,audioScheduler}.test.ts`, runnable with `node --test src/lib/voice/__tests__/*.test.ts` (Node 22.6+/23+ strip the type annotations natively). 17 tests: resampling ratios and edge cases, int16 clamping, echo-guard scaling, and the gapless scheduler's ordering/out-of-order/stale-seq/mute/stopAll behavior against a fake `MinimalAudioContext`. `tsconfig.app.json` excludes `src/**/__tests__/**` so these don't need browser/node type shims to satisfy the app's own strict `tsc -b`
- Verified: `cd client && npx tsc -b --noEmit` clean, `npm run build` succeeds, `node --test src/lib/voice/__tests__/*.test.ts` green (17/17). Manually smoke-tested against a throwaway server (own HOME, PORT=5988, never port 3456) with `npx vite --port 5197`; screenshots of VoiceBar in each state saved via a tiny local `http.createServer` file-save helper plus `html2canvas` (the Browser pane blocks real mic/speaker access, so Listening/Thinking/Speaking were driven through the store directly for the screenshot: a debug-only `window.__voiceStore` hook used solely for that session and reverted before finishing) to `docs/screenshots/voice-off.png`, `voice-push-to-talk.png`, `voice-always-on.png`, `voice-listening.png`, `voice-thinking.png`, `voice-speaking.png`
- Files affected: CHANGELOG.md, client/src/components/Voice/VoiceBar.tsx (new), client/src/lib/voice/{pcmDownsample,audioScheduler,micWorkletSource,micCapture,voiceBus}.ts (new), client/src/lib/voice/__tests__/{pcmDownsample,audioScheduler}.test.ts (new), client/src/stores/voiceStore.ts (new), client/src/types/voice.ts (new), client/src/hooks/useSocket.ts, client/src/stores/activityStore.ts, client/src/components/Activity/ActivityLogPanel.tsx, client/src/types/message.ts, client/src/types/session.ts, client/src/api.ts, client/src/components/Settings/VoiceTab.tsx, client/src/components/Chat/ChatView.tsx, client/tsconfig.app.json, docs/screenshots/voice-*.png (new)

## 2026-09-18 13:45
- S14-A: the server side of the speech-to-speech voice loop (spec `docs/2026-09-18_s14_voice_loop_spec.md`, sections 1, 3, 6, 7). New `server/src/voice/`:
  - `vad.ts`: energy-gate VAD on 16 kHz mono PCM16, 20 ms frames, RMS threshold with a 600 ms silence hangover (per-session configurable via `voice:start {vad}`), 300 ms pre-roll so onsets are not clipped, minimum-speech and max-utterance guards
  - `stt-stream.ts`: socket PCM frames in, whole utterances to Whisper, transcripts out; transcription is serialized per session so a fast second utterance cannot overtake a slow first one. Blank-audio and punctuation-only results are dropped
  - `sentence-chunker.ts`: streaming sentence splitter with an abbreviation table ("Dr.", "e.g.", "U.S.", initials, decimals, filenames never split), a 180-character cap cut on a word boundary, and markdown-to-speech stripping
  - `tts-stream.ts`: assistant deltas in, ordered `voice:audio-chunk` out, synthesized through Kokoro with a lookahead of one sentence (at most two synth requests in flight, chunks always emitted in written order). A line-oriented gate drops fenced code and table rows before chunking. `cancel()` is the barge-in path
  - `providers.ts`: `SttProvider`/`TtsProvider` interfaces with Whisper and Kokoro as defaults, both talking to the same local HTTP servers the mic and speaker buttons already use, plus WAV encode/decode helpers and a swap seam for tests
  - `session.ts`: the `idle -> listening -> transcribing -> thinking -> speaking -> listening` state machine, emitting `voice:state` on every transition and one `voice:latency` per turn (`sttMs`, `firstTokenMs`, `firstAudioMs`, `totalMs`) plus the matching `activity:event` line. Barge-in is two-stage: playback stops the moment the VAD gate opens over her voice (about 100 ms), then the transcript aborts the running turn and re-prompts with the `[You interrupted; the previous reply was cut off after: "..."]` prefix
- `server/src/socket/voice-handlers.ts`: the `voice:start` / `voice:audio` / `voice:stop` / `voice:interrupt` handlers, registered from `handler.ts` with the one line this workstream owns. The assistant text stream is tapped by wrapping the namespace adapter's `broadcast`, so the voice layer sees exactly the `message:stream:*` traffic the browser sees rather than needing a second hook in the send path; the same tap tags the echoed user message with `source: "voice"`
- `server/src/routes/voice.ts`: `GET /api/voice/status` lists both providers, their readiness, the live voice sessions, and the VAD defaults. Mounted in `index.ts` next to `/api/tts` (two lines, next to S14-B's wiring area)
- `SessionMeta.voiceModel` (optional): when set, the voice turn runs on that model. Applied through `SessionStore.overrideModelForTurn()`, which swaps `model` in memory for the duration of the send and restores it afterwards, so a fast voice tier never overwrites the user's chosen model on disk. `PATCH /api/sessions/:id` accepts `voiceModel`
- Tests: 60 new (513 total, up from 453 on main) across `server/src/voice/__tests__/{vad,sentence-chunker,tts-stream,session,providers}.test.ts` and `server/src/socket/__tests__/voice-handlers.test.ts`: VAD segmentation on synthetic PCM (speech, silence, speech gives two utterances; short pauses do not split; pre-roll; unaligned frame sizes), the sentence chunker (abbreviations, decimals, 180-char cap, streaming boundaries), audio chunk ordering under a deliberately slow synth, the barge-in path (stop-audio emitted, abort called, prefixed re-prompt), every state transition, and Whisper/Kokoro request shaping against a fake `fetch`. `cd server && npx tsc --noEmit && npx vitest run` green
- Verified live on a throwaway server on port 3995 (temp HOME, temp .env, the owner's port 3456 and desktop app untouched; the already-running local Whisper and Kokoro servers were adopted read-only, never killed). A `say`-generated WAV of "what files are in this folder" was streamed in as 100 ms PCM16 frames over socket.io: `voice:state` went listening to transcribing to thinking, `voice:transcript` came back as "What files are in this folder?", and the echoed `message:user` carried `source: "voice"`. No engine credentials are available in this sandbox, so the same run was repeated through the real `VoiceSession` with a stubbed engine reply to exercise Kokoro: ordered `voice:audio-chunk` frames (seq 0 then 1, 91 KB and 161 KB of WAV), `voice:speaking-start`/`end`, and a warm `voice:latency` of `sttMs 322, firstTokenMs 123, firstAudioMs 290, totalMs 740`, inside the spec's 800 ms budget to the first spoken word
- Files affected: CHANGELOG.md, server/src/voice/session.ts, server/src/voice/stt-stream.ts, server/src/voice/tts-stream.ts, server/src/voice/vad.ts, server/src/voice/sentence-chunker.ts, server/src/voice/providers.ts, server/src/socket/voice-handlers.ts, server/src/socket/handler.ts, server/src/routes/voice.ts, server/src/routes/sessions.ts, server/src/sessions/store.ts, server/src/index.ts, server/src/voice/__tests__/*.test.ts, server/src/socket/__tests__/voice-handlers.test.ts

## 2026-09-18 13:30
- S14-B: event-driven subagent follow-ups plus the prompt's two-lane rule and voice mode. A finished subagent now starts a new turn in its parent chat instead of the orchestrator having to wait for it
- `server/src/subagents/followups.ts` (new): `FollowupService` owns the policy and is injected with everything it touches, so idle-vs-busy delivery, 2 s coalescing, the one-per-10-s rate cap with merging, restart dedupe, and bounded retry are all testable without a socket or an engine. `createFollowupTurnRunner` owns the mechanism: it spawns the engine first and only emits the chip once the turn is actually under way, so a follow-up that lost a race with a user message leaves no orphan message behind and goes back in the queue. Reported agent ids persist to `~/.claude-chat/followups.json`; a delivery that keeps failing (no provider selected, deleted session) backs off and is dropped with a `warning` Activity Log line after 6 attempts rather than retrying twice a second forever
- Message format: `[Agent <name> <status>] <first 1500 chars of the result, or the error>` plus `Call agent_result('<id>') for the full output.`, one block per merged agent. Socket: `followup:queued`, `followup:delivered`, and an `activity:event` line for each. The turn's `message:user` carries `role: "system"`, `kind: "followup"`, `source: "agent-followup"` and `agentIds`; documented for the client agent in `server/src/subagents/FOLLOWUP_CONTRACT.md` (new)
- `server/src/sessions/orchestrator-prompt.ts`: a "Two lanes" section (anything over a few seconds or two tool calls goes to `spawn_agent`, never hold the conversation open), the follow-up reply style (one or two sentences, the user did not type that message), and a new `voiceMode` option that adds a "## Speaking" section (short sentences, no tables, bullets or code blocks read aloud, say where the code went)
- `server/src/subagents/manager.ts`: `subagent:end` now carries the agent's `name`, since the follow-up service sees only that event. `server/src/chat/store.ts`: optional `source`/`kind` on a persisted message so a reloaded chat still renders the follow-up as a chip. `server/src/index.ts` wires the service to ProcessManager, ChatStore, the socket, and the MCP descriptor, and disposes its timers on shutdown. `socket/handler.ts` was not touched (S14-A owns it)
- Tests: 29 new (482 total, up from 453 on main). 21 in `server/src/subagents/__tests__/followups.test.ts` (idle vs busy, coalescing, the 10 s cap with merging, error and cancelled statuses, per-session isolation, requeue and give-up, restart dedupe against a real state file, a corrupt state file, and the turn runner's payload/streaming), 7 in `orchestrator-prompt.test.ts` (lane rule, follow-up style, voiceMode on and off, no em-dash, no bot-era markers), 1 in `manager.test.ts`. `cd server && npx tsc --noEmit && npx vitest run` green
- Live check on PORT=3994 with a temp HOME (port 3456 and the desktop app untouched): created a session over the API, spawned a subagent via `POST /api/subagents`, and saw `subagent:end` then `followup:queued`, the `message:user` chip with `role: "system"` / `kind: "followup"` / `source: "agent-followup"`, `message:stream:start`, `followup:delivered`, and both Activity Log lines. The first run of this check is what surfaced the infinite retry on a permanent failure, which is now the backoff plus give-up above
- Files affected: CHANGELOG.md, server/src/subagents/followups.ts, server/src/subagents/FOLLOWUP_CONTRACT.md, server/src/subagents/manager.ts, server/src/subagents/__tests__/followups.test.ts, server/src/subagents/__tests__/manager.test.ts, server/src/sessions/orchestrator-prompt.ts, server/src/sessions/__tests__/orchestrator-prompt.test.ts, server/src/chat/store.ts, server/src/index.ts

## 2026-09-18 12:15
- Fixed the desktop app always showing the login screen instead of the chat UI: `main.rs` generated a random `AUTH_TOKEN` and tried to hand it to the web UI purely through `initialization_script("localStorage.setItem('auth-token', ...)")` on the `about:blank` window, then `navigate()`d that window to the sidecar's URL. That init-script-on-navigate handoff is not guaranteed to rerun on every webview engine, so the page sometimes loaded with no token in localStorage at all, `checkAuth()` fell through to `LoginScreen`, and the server's login rate-limit header showed zero attempts because the page never even tried to log in
- Fix, three parts:
  1. `desktop/src-tauri/src/main.rs`: `start_sidecar_and_navigate` now navigates to `http://127.0.0.1:<port>/#medusa-auth=<token>` (URL fragment, never a query string, so the token is never sent to the server or written to any log). The existing `initialization_script` localStorage write stays in place as a secondary path
  2. `client/src/api.ts`: new `consumeAuthTokenFromHash()` reads `location.hash` on boot, pulls `medusa-auth` out of it into localStorage under the existing `auth-token` key, and clears the fragment with `history.replaceState` so it never lingers in the address bar or history. `checkAuth()` calls it first, then keeps its existing fallback: if `/api/auth/me` fails and a token is present in localStorage, it POSTs `/api/auth/login` once and only surfaces `LoginScreen` if that also fails. `client/src/socket.ts` needed no change, it already reads the same `auth-token` localStorage key and runs after `checkAuth()` has populated it
  3. `server/src/routes/auth.ts`: the 5-per-15-minute login rate limiter already had `skipSuccessfulRequests: true` (a successful login never counted), but a loopback request presenting the *correct* token could still be throttled if earlier wrong attempts from the same IP had already exhausted the window. Added a `skip()` that bypasses the limiter entirely for a loopback request whose token matches `config.authToken`; wrong-token attempts from loopback still count and can still be throttled. Also added a one-line `console.log` on successful login (`[auth] successful login from <ip>`), there was no server-side evidence of a successful login before this
- Tests: 3 new in `server/src/routes/__tests__/auth.test.ts` (453 total, up from 450 on main): successful logins never consume the rate-limit budget, wrong-token attempts still get throttled at 429, and a loopback request with the correct token gets through even after wrong attempts from the same IP have exhausted the budget. `cd server && npx tsc --noEmit && npx vitest run` green (453 passed); `cd client && npx tsc -b --noEmit && npm run build` green
- Verified end to end: `bash desktop/scripts/build-sidecar.sh` then `npm run tauri build`, launched the packaged `Medusa.app/Contents/MacOS/medusa-desktop` directly, waited 15s, found the sidecar's ephemeral port (57822) via `lsof` on the pid this run started, and confirmed the server log already showed `[auth] successful login from 127.0.0.1` with no interaction from me, i.e. the webview logged itself in through the fragment handoff. `curl -X POST .../api/auth/login` with a wrong token then showed `RateLimit: limit=5, remaining=4`, reduced only by that one deliberate wrong attempt, not by the webview's earlier successful login. `screencapture` plus reading the image back confirmed the window showed the "Welcome to Medusa" chat UI, not the login screen. Killed only the processes this run started (the main process and its child sidecar); the owner's own running instance was left untouched
- Files affected: CHANGELOG.md, desktop/src-tauri/src/main.rs, client/src/api.ts, server/src/routes/auth.ts, server/src/routes/__tests__/auth.test.ts

## 2026-09-18 12:00
- Fixed a production bug where the desktop app's whole chat turn failed silently: Kimi (and every other engine) logged "Failed to connect MCP servers: {'medusa': McpError('Connection closed')}" and the user saw no reply at all. Root cause: `server/src/mcp/descriptor.ts` `resolveShimPath()` locates the compiled shim relative to `import.meta.url`, which works under `tsx`/`node` but resolves inside the bun binary's own virtual filesystem once the server is compiled into a single `bun build --compile` sidecar for the desktop app, so `node <that path>` could never find a real file and the shim never started
- Fix, three parts:
  1. Ship the shim as its own sidecar binary. `desktop/scripts/build-sidecar.sh` now also compiles `server/dist/mcp/medusa-mcp-shim.js` with `bun build --compile --target=bun` into `desktop/src-tauri/binaries/medusa-mcp-shim-<triple>`, registered in `tauri.conf.json`'s `bundle.externalBin` alongside `medusa-server`. `main.rs` resolves the bundled shim's path the same way Tauri resolves the server sidecar (`Shell::sidecar()`, read back via `Command::into::<std::process::Command>().get_program()` without ever spawning it) and passes it to the server sidecar as `MEDUSA_MCP_SHIM_BIN`. `descriptor.ts`'s resolution order is now: `MEDUSA_MCP_SHIM_BIN` set -> run that binary directly (`command: <path>, args: []`); else `MEDUSA_MCP_SHIM_PATH` set -> `node <path>`; else the existing `resolveShimPath()` lookup
  2. Graceful degradation. `server/src/mcp/config.ts` `descriptorForSession` now verifies the resolved shim target actually exists on disk (and that `node` is resolvable on PATH, for the `node <script>` shape) before handing a descriptor to the caller; when it doesn't, it logs one clear warning, calls an optional `onWarning` callback, and returns null so `server/src/socket/handler.ts` spawns engines without `--mcp-config` instead of failing the whole turn. The handler turns that callback into an `activity:event` of the new `"warning"` kind so the Activity Log shows exactly why subagent tools are off for that session
  3. Error copy. `server/src/socket/error-policy.ts` `buildAllTiersFailedMessage` no longer appends the `claude /login` hint to every failure, only when `isAuthError()` recognizes the error (no model tier or MCP fix helps "not logged in", but the reverse doesn't hold either); a non-auth error that mentions MCP now instead ends with "Subagent tools failed to start; see the Activity Log."
- Tests: 13 new (450 total, up from 437 on main): shim resolution order in `server/src/mcp/__tests__/descriptor-resolution.test.ts`, `descriptorForSession`'s null-on-missing-shim path (mocked `fs`) in `server/src/mcp/__tests__/descriptor-for-session.test.ts`, and the new error-policy copy cases in `server/src/socket/__tests__/error-policy.test.ts`. `cd server && npx tsc --noEmit && npx vitest run` green
- Verified end to end: built both sidecars, piped an `initialize` + `tools/list` JSON-RPC pair into the standalone `medusa-mcp-shim` binary against a server on `PORT=3996` with a temp `MEDUSA_DATA_DIR` and got back all 5 subagent tools; then `npm run tauri build`, launched the packaged `Medusa.app/Contents/MacOS/medusa-desktop` directly, confirmed the sidecar came up healthy on its ephemeral port with `MEDUSA_MCP_SHIM_BIN=<app>/Contents/MacOS/medusa-mcp-shim` in its environment and no shim warning in the log, then killed only the processes this test started
- Files affected: CHANGELOG.md, desktop/README.md, desktop/scripts/build-sidecar.sh, desktop/src-tauri/tauri.conf.json, desktop/src-tauri/src/main.rs, server/src/mcp/descriptor.ts, server/src/mcp/config.ts, server/src/socket/activity.ts, server/src/socket/handler.ts, server/src/socket/error-policy.ts, server/src/socket/__tests__/error-policy.test.ts, server/src/mcp/__tests__/descriptor-resolution.test.ts, server/src/mcp/__tests__/descriptor-for-session.test.ts

## 2026-09-17 21:40
- Workstream S13 (`docs/2026-09-17_ui_and_layer_addendum.md`, "Persona, theme, voice editor and shareable packs" plus "The Medusa layer"): everything that makes Medusa yours is now editable in the UI and shareable as one file
- Server: new `server/src/packs/{schema,store,routes,registry}.ts`. `schema.ts` is the zod contract for the `.medusa-pack` manifest and every part (persona, rules, theme, voice, toolbox), with rule names constrained so a pack cannot write outside `~/.medusa/rules` and avatars limited to base64 raster data URLs (an `image/svg+xml` avatar is refused because SVG can carry script). `store.ts` owns the `~/.medusa/` layout: `MEDUSA.md` with `name`/`greeting` front matter, `rules/*.md`, `rules.json`, `theme.json`, `voice.json`, `toolbox.json`, `packs/` and `backups/`
- Routes: `GET/PUT /api/medusa/persona`, `POST /api/medusa/persona/reset`, `GET /api/medusa/preview`, `GET/POST /api/medusa/rules`, `PUT /api/medusa/rules/:name/enabled`, `DELETE /api/medusa/rules/:name`, `GET /api/medusa/rules/effective`, `GET/PUT` for `/api/medusa/theme`, `/voice` and `/toolbox`, `GET /api/medusa/registry`, plus `GET /api/packs`, `POST /api/packs/export`, `POST /api/packs/import`, `POST /api/packs/validate`, `POST /api/packs/:id/apply` and `DELETE /api/packs/:id`. These two routers get their own 8mb body parser because a pack carries an embedded avatar; the 1mb default stays for every other route
- `orchestrator-prompt.ts` now reads the layer through `packs/store.ts` instead of the filesystem directly, so it strips persona front matter and appends only the rules enabled in `rules.json`. A rule with no entry there counts as enabled, which is how rules behaved before the toggle existed. Nothing in this work is engine specific: the same composed prompt still goes to every engine
- Client: Settings gained Persona, Theme, Voice, Toolbox and Packs tabs (`client/src/components/Settings/*`). Persona edits name, avatar (a file input, stored as a data URL), personality and greeting with a live preview of the composed prompt from the preview route, and resets to the bundled default. Theme's pickers write through `client/src/theme.ts`, which rewrites the CSS variables under a `data-theme` style block so the app repaints as a color changes, with light/dark, density and JSON export/import. Voice lists the TTS manager's voices, previews a sample through the existing `POST /api/tts`, and has speed/pitch sliders and a default on/off. Toolbox lists MCP servers and skills with on/off and a read/write/shell scope; "Search registry" only opens a modal of candidates from a static list, and Add is always a click
- Packs: export the current setup with a name, author and description, import by file picker, or drop a `.medusa-pack` anywhere on the window (`App.tsx` routes those to the importer instead of treating them as attachments). Installed packs list with Apply and Remove. Import always snapshots the current setup under `~/.medusa/backups/` first
- `ToolsView.tsx`'s rule toggles were placeholders in localStorage; they now read `GET /api/medusa/rules` and write `PUT /api/medusa/rules/:name/enabled`, optimistically with a rollback on failure. The saved theme and voice are fetched and applied when the app loads
- Tests: 432 server tests pass (393 on main plus 39 new) across `packs/__tests__/schema.test.ts` (good and bad packs, theme/voice/toolbox token validation), `packs/__tests__/store.test.ts` (front matter round trip, rule toggling, export/import round trip and backup, all under a temp HOME) and new rules-filtering and front-matter cases in `sessions/__tests__/orchestrator-prompt.test.ts`. `cd client && npx tsc -b --noEmit` clean and `npm run build` succeeds
- Docs: `docs/PACKS.md` describes the file format, the `~/.medusa/` layout, the validation rules and the route list
- Files affected: CHANGELOG.md, docs/PACKS.md, server/src/index.ts, server/src/packs/schema.ts, server/src/packs/store.ts, server/src/packs/routes.ts, server/src/packs/registry.ts, server/src/packs/__tests__/schema.test.ts, server/src/packs/__tests__/store.test.ts, server/src/sessions/orchestrator-prompt.ts, server/src/sessions/__tests__/orchestrator-prompt.test.ts, client/src/api.ts, client/src/theme.ts, client/src/packs.ts, client/src/App.tsx, client/src/components/Settings/{settingsStyles.ts,Toggle.tsx,PersonaTab.tsx,ThemeTab.tsx,VoiceTab.tsx,ToolboxTab.tsx,PacksTab.tsx}, client/src/components/Sidebar/SettingsModal.tsx, client/src/components/Tools/ToolsView.tsx

- S9: Tauri folder picker, per `docs/2026-09-17_medusa_only_orchestrator_spec.md` section B.2. Added `tauri-plugin-dialog` to `desktop/src-tauri/Cargo.toml`, registered it in `main.rs`, and granted `dialog:allow-open` in `capabilities/default.json`. `NewChatModal.tsx`'s existing `pickFolderViaTauri` stub now passes `defaultPath` (the current folder field) so the native picker opens where the user last was, and the remembered-folder list grew from 6 to 8 quick picks
- Folder chip in the chat header (`ChatView.tsx`) is now clickable: under Tauri it opens the chat's working directory in Finder via `window.__TAURI__.shell.open`, gated by a new `shell:allow-open` capability alongside the sidecar's existing `shell:allow-execute`/`shell:allow-spawn`; in the browser it copies the path and reuses the message-list "Copied" toast pattern
- `main.rs` now passes `MEDUSA_DESKTOP=1` to the sidecar; `server/src/config.ts` exposes it as `config.isDesktop` so future features can branch on the desktop shell. No behavior change
- Did not add an `@tauri-apps/plugin-dialog` npm dependency: every other Tauri plugin in this repo (shell, notification, global-shortcut, updater) is wired Rust-only and consumed from the client through the `window.__TAURI__` global injected by `withGlobalTauri: true`, and the client's `NewChatModal.tsx` already expected exactly that shape, so the dialog plugin follows the same pattern instead of introducing a new one
- Verified: `cd client && npx tsc -b --noEmit` clean, `cd desktop/src-tauri && cargo check` clean, `cd desktop && npm run tauri build` succeeded
- Files affected: CHANGELOG.md, desktop/README.md, desktop/src-tauri/Cargo.toml, desktop/src-tauri/capabilities/default.json, desktop/src-tauri/src/main.rs, server/src/config.ts, client/src/components/Sidebar/NewChatModal.tsx, client/src/components/Chat/ChatView.tsx

## 2026-09-17 21:35
- QA pass on the new Claude-style layout (spec: `docs/2026-09-17_ui_and_layer_addendum.md`, `docs/2026-09-17_medusa_only_orchestrator_spec.md` Sections E/F.1). Ran the full manual test matrix against the dev server (port 3456) and Vite client (port 5173); fixed every FAIL found in place
- Fix: `Sidebar/NewChatModal.tsx` left the engine dropdown at its "Claude CLI" default no matter what provider was picked, so choosing Kimi as the provider still spawned the (separately authenticated) Claude CLI and produced a confusing "Not logged in" reply plus a "Session ID already in use" retry error. The engine now follows the provider (claude/kimi) until the user picks an engine by hand
- Fix: `server/src/socket/handler.ts`'s `assistant_complete` handler checked the `gotDeltas` guard before appending text but never set it, so a retried/escalated attempt that reuses the same stream closure (e.g. two failed auth attempts) appended its "Not logged in · Please run /login" text a second time with no separator. Now sets `gotDeltas = true` after the first contribution, same as the `delta` case
- Fix: `server/src/index.ts` mounted the 30-requests/15-minutes session-creation rate limiter on the whole `/api/sessions` router, so GET (list), PATCH (rename, provider/model change) and DELETE all counted against the same bucket as POST. A few minutes of normal chat-list use during this QA pass burned through it and returned "Too many session creation requests" for the session list itself. New `server/src/middleware/session-create-gate.ts` scopes the limiter to `POST /` only; covered by `session-create-gate.test.ts` (5 new tests)
- Fix: a React "Removing borderColor border" console warning (mixing a `border` shorthand base style with a `borderColor`-only override on state change) fired on every toggle of the header icon buttons, the Browser/Simulator tabs, the Activity Log badges, the Usage period buttons, and the Settings tabs. Split the shorthand into `borderWidth`/`borderStyle`/`borderColor` in `Chat/ChatHeaderControls.tsx`, `RightPanel/RightPanel.tsx`, `Activity/ActivityLogPanel.tsx`, `Usage/UsagePane.tsx` and `Sidebar/SettingsModal.tsx`
- Hygiene: `devlog_archive.md` at the repo root is generated output from `server/src/utils/devlog-paginator.ts` (it rotates old `devlog.md` entries into a same-directory archive file), not a stray doc — added it to `.gitignore` next to `devlog.md` instead of moving or deleting it
- Verified clean: left rail contents, mic/attach/send in the input bar, model selector persisting across reload, New Chat (folder/provider/engine/model) plus rename/delete, a Kimi chat reading `package.json` with a tool card and working disclosure, two spawned subagents with expandable SubagentCards and correct file counts (MCP shim wiring confirmed working), header icon panel/tab toggles plus Cmd+B/Cmd+L and width persistence, Settings Usage tab (cost by session/subagent/model) and Stop All, and the Tools view. `read_console_messages(onlyErrors)` clean on a fresh load after fixes
- Files affected: CHANGELOG.md, .gitignore, client/src/components/Sidebar/NewChatModal.tsx, client/src/components/Chat/ChatHeaderControls.tsx, client/src/components/RightPanel/RightPanel.tsx, client/src/components/Activity/ActivityLogPanel.tsx, client/src/components/Usage/UsagePane.tsx, client/src/components/Sidebar/SettingsModal.tsx, server/src/socket/handler.ts, server/src/index.ts, server/src/middleware/session-create-gate.ts (new), server/src/middleware/__tests__/session-create-gate.test.ts (new)
- Verified: `cd server && npx tsc --noEmit && npx vitest run` clean at 398 tests (393 existing + 5 new); `cd client && npx tsc -b --noEmit && npm run build` clean

## 2026-09-17 20:25
- Merge: rebased the S5 + S7 client layout onto main (e70cb17), which already carried S6, S8 and S10. Six conflicts. `Activity/ActivityLogPanel.tsx`, `hooks/useSocket.ts`, `Usage/TokenRing.tsx` and `Usage/UsagePane.tsx` took main's versions; `api.ts` kept main's usage types while keeping S5's removal of the hub-era calls (`fetchCompare` and the `ComparePeriod`/`CompareResult` types went with the deleted `ComparisonChart`); the CHANGELOG kept both sides, newest first. `server/` and `package.json` needed no hand-merging
- Re-applied S5's deletion to main's `useSocket.ts`: it still imported `stores/taskStore` and `types/task` and registered `task:done`, `tasks:acknowledged`, `session:pending-task`, `dev-control:*` and `bot:task-*`, all of whose stores and types S5 deleted
- `App.tsx`: S5's placeholder Activity panel accepted `string | null`, main's real one takes `string`, so the mount now passes `activeSessionId ?? ''`
- `Activity/ActivityLogPanel.tsx`: its toolbar reserves the same 104px right clearance `ChatView`'s header does. As the rightmost column it runs under the fixed `CaffeineToggle`, which was covering the Clear button at the 320px default width
- Verified: `cd client && npx tsc -b --noEmit && npm run build` clean, `cd server && npx tsc --noEmit && npx vitest run` clean at 393 tests. Smoke-tested the layout at 1440x900 against a throwaway server (its own HOME and port, never the dev server on 3456) with no console errors: left rail, model selector under the input, the header icons opening the right panel and the real Activity Log, and the Tools view
- `docs/screenshots/*.png` regenerated so the Activity Log shots show S6's real panel rather than the placeholder
- Files affected: CHANGELOG.md, client/src/App.tsx, client/src/api.ts, client/src/hooks/useSocket.ts, client/src/components/Activity/ActivityLogPanel.tsx, docs/screenshots/*.png

## 2026-09-17 19:45
- UI (workstreams S5 and the client half of S7, per `docs/2026-09-17_ui_and_layer_addendum.md` "Target layout" and "Message details"): the client is now the Claude-style three-column layout in Medusa's green-on-charcoal palette. Left rail, centre chat, Browser/Simulator panel, Activity Log
- Left rail (`components/Sidebar/Sidebar.tsx`, new `ChatList.tsx`): app mark plus "Medusa", a search field, a "Recent" chat list showing title and message count with the active chat outlined in the accent, and a per-row menu for Rename / Chat settings / Delete. Bottom group: `+ New Chat`, `Tools`, `Settings`, `Bug / Feature` (opens the repo's GitHub issues page in the system browser). The only status indicator left is the streaming dot; every bot-era symbol is gone
- New chat (`Sidebar/NewChatModal.tsx`, replacing `NewSessionButton.tsx`): a modal asking for folder, title, provider, engine and model, POSTing the S2 shape to `/api/sessions`. The folder field remembers the last six folders as chips, and uses the Tauri dialog plugin when `window.__TAURI__.dialog.open` exists, falling back to the text field otherwise (S9 still owns the Rust side). The title defaults to the folder basename, deduped by the server
- Centre chat (`components/Chat/ChatView.tsx`, the former `Hub/MedusaChat.tsx`): folder chip and panel icons in the header, an input bar with attach / "Ask Medusa..." / mic / send, the abort button rescued from the deleted `ChatInput`, a thin accent progress bar while a turn runs, and the provider plus model selects directly under the input beside the usage ring. Each finished assistant message gets a footer: timestamp, Copy, Regenerate (resends the user message above it) and a "Show tool calls & activity (N lines)" disclosure. `MessageBubble.tsx` is untouched (S6 owns it): the disclosure works by handing it a message with its tool cards withheld while collapsed
- Right panel (`components/RightPanel/RightPanel.tsx`, `DragBar.tsx`, `stores/layoutStore.ts`): Browser and Simulator as tabs over the unchanged `CoworkPane` and `SimulatorPane`, in states hidden / slim / wide / full, with a drag bar whose double-click flips slim and wide. Both panes stay mounted so switching tabs does not drop the live CDP or idb stream. Widths persist per state in localStorage; Cmd+B toggles the panel and Cmd+L the Activity Log
- Far-right Activity Log: its own drag bar, a `<` collapse handle, remembered width, and `<ActivityLogPanel sessionId=... />`. On merge the S5 placeholder was dropped in favour of S6's real `components/Activity/ActivityLogPanel.tsx`
- Settings gained tabs: General (everything that was there), Usage (the existing `UsagePane` mounted unchanged) and Stop All, which fires the existing `message:abort` at every chat rather than shutting the server down. Both left the left rail per the addendum
- New `components/Tools/ToolsView.tsx`: the chat's engine, provider, model and folder, the `medusa` MCP tool set, skills from `/api/skills`, and placeholder rule files, each with a toggle persisted per chat to localStorage. The rules drive nothing server-side until the Medusa persona layer (S13) ships
- Deleted (S7): `components/Arcade/` and the `phaser` dependency; `components/Hub/{HubFeed,HubMessage,MentionAutocomplete,ApprovalBanner,UsageDashboard,ComparisonChart}.tsx` and the `recharts` dependency that went with ComparisonChart; `components/Chat/{ChatPane,KanbanStrip,MessageList,JumpToStartButton}.tsx`; `components/Input/ChatInput.tsx`; `hooks/useAutoScroll.ts`; `components/Sidebar/{SessionList,ProjectList,ProjectDetailCard}.tsx`; `stores/{hubStore,taskStore}.ts`; `types/{hub,task,approval}.ts`. `components/Hub/` is gone: `MedusaChat`, `ChatHeaderControls` and `LaunchScreen` moved into `components/Chat/`
- `api.ts` lost `fetchHubMessages`, `fetchTasks`, `acknowledgeTasks`, `fetchApprovals`, `approveRequest`, `denyRequest`, `fetchDevControl`, `pauseSession`, `resumeSession`, `requestSessionStatus`, `fetchCompare` and the `DevControlState` / `ComparePeriod` / `CompareResult` types, and gained the B.2 `createSession` shape plus a general `updateSession` PATCH. `stores/sessionStore.ts` lost `pendingTasks` and `devControl`; `activeView` is now `chat | project | tools`, since Browser and Simulator are panel tabs rather than views
- `ChatHeaderControls.tsx` is now only the three header icons. The agent selector went with the bots, and the provider and model pickers moved under the input, as the addendum requires
- Copy: rewrote the onboarding deck, which still taught a roster of bots coordinating through a Hub feed, and the launch screen tagline; renamed "Bot" to "Chat" through `SessionEditor`, `UsagePane` and `TokenRing`. `SessionEditor` also drops its hardcoded haiku/sonnet/opus/fable list for the provider's own model list and gains engine and provider selects
- Fixed while screenshotting: `ChatView`'s container had no `minHeight: 0`, so the message list grew to its content and pushed the model picker under the fold whenever the transcript was long
- One file outside this workstream's ownership was touched: `hooks/useSocket.ts` (S6's) lost only its `hub:message`, `task:done`, `tasks:acknowledged`, `session:pending-task`, `dev-control:*` and `bot:task-*` handlers, because the stores and types they referenced are deleted here. On merge S6's version of the file was taken, which already lacks those handlers
- `cd client && npx tsc -b --noEmit` clean, `npm run build` succeeds, server untouched and still 338 tests green
- Screenshots at 1440x900 in `docs/screenshots/`: `layout-panel-hidden.png`, `layout-panel-slim.png`, `layout-activity-log.png`

## 2026-09-17 19:20
- Feature (workstream S10 of the Medusa-only orchestrator spec, section A.8): usage attribution now understands subagents. `TokenUsageEntry` gains `sessionTitle`, `role`, `agentId`, `subagentTask`, `subagentName` and `costEstimated`; `botName` is kept optional for reading pre-S10 JSONL lines (a legacy entry with only `botName` resolves its session title from that field). `UsageSummary.byBot` is renamed to `bySession` (keyed by sessionId, carrying the session title) and a new `bySubagent` (keyed by agent id, carrying engine, model, parentSessionId and a trimmed task summary) is added. A subagent's own log entry always keeps `sessionId` set to its PARENT session, so it aggregates into that session's `bySession` total automatically, on top of its own `bySubagent` row
- Added server/src/metrics/pricing.ts: a small in-memory OpenRouter `/v1/models` pricing cache. For `provider === "openrouter"` entries with known per-token pricing, cost is recomputed from token counts instead of trusting the CLI's Anthropic-priced `costUsd`; unknown pricing falls back to the reported cost with `byModel[key].priceKnown = false`. Refreshed once at boot in server/src/index.ts, best-effort and non-blocking
- server/src/index.ts: wired `SubagentManager`'s `logUsage` callback to `tokenLogger.log(...)`, looking up the finished subagent's task/name/engineSessionId via `subagentManager.get(agentId)` and the parent chat's title via `sessionStore.get(sessionId)`
- server/src/socket/handler.ts: the single `logUsage` call site now writes `sessionTitle: meta.name` instead of `botName`
- server/src/routes/metrics.ts and server/src/utils/token-report.ts: `byBot` replaced with `bySession`/`bySubagent` in both the JSON API and the CLI report's "Cost by Session" / "Cost by Subagent" sections
- Client: client/src/api.ts's `TokenUsagePeriod`/`ComparePeriodSummary` types follow the same rename plus new `SessionUsageBreakdown`/`SubagentUsageBreakdown`/`ModelUsageBreakdown` shapes. `TokenRing.tsx`'s popover now shows a "Subagents (today)" line (count and cost) alongside the existing "Top sessions" list; `UsagePane.tsx` gained Cost by Session and Cost by Subagent tables next to the existing Cost by Model table. Default exports and props (`TokenRing({ popoverDirection })`, `UsagePane({ onMenuToggle })`) are unchanged for S5 to mount as-is
- Tests: server/src/metrics/__tests__/token-logger.test.ts covers bySession replacing byBot, a subagent entry aggregating into both its parent session and bySubagent, legacy-entry loading (both a botName-only line and a fully blank sessionId), and the OpenRouter unknown-pricing flag. `cd server && npx tsc --noEmit` and `npx vitest run` are clean at 345 tests (338 on main plus 7 net new here); `cd client && npx tsc -b --noEmit` is clean
- Files affected: server/src/metrics/token-logger.ts, server/src/metrics/pricing.ts (new), server/src/metrics/__tests__/token-logger.test.ts, server/src/routes/metrics.ts, server/src/utils/token-report.ts, server/src/socket/handler.ts, server/src/index.ts, client/src/api.ts, client/src/components/Usage/TokenRing.tsx, client/src/components/Usage/UsagePane.tsx

## 2026-09-17 19:20
- S6 (docs/2026-09-17_medusa_only_orchestrator_spec.md sections A.6/E.4) plus the Activity Log data path from docs/2026-09-17_ui_and_layer_addendum.md. Merged main (e2d9576) first
- New server/src/socket/activity.ts: pure mapping from ParsedEvent (init, delta, tool_use_start, tool_input_delta, tool_result, assistant_complete with its thinking blocks split out, result with usage, error) and from each subagent:* payload to `activity:event` lines `{ sessionId, ts, kind, summary, detail, detailTruncated, tokens?, subagentId?, parentToolUseId? }`. Detail is clipped at 8k with a flag so one huge tool result is not broadcast whole. Also exports isSpawnAgentToolName and matchSubagentId, the spawn_agent to subagent correlation rule
- server/src/socket/handler.ts: emits the Activity Log lines for every parsed event at the top of onEvent, and exports emitSubagentActivity for the subagent side. server/src/index.ts: the SubagentManager emitter now also calls it (the only place subagent:* events are visible server-side)
- New client/src/stores/subagentStore.ts: subagents keyed by agent id with parentSessionId, parentToolUseId, engine, model, task, status, streamed text, tool events paired by id, usage. findSubagentForToolUse mirrors the server's FIFO correlation
- New client/src/stores/activityStore.ts: per-session ring buffer, 5000 lines, oldest dropped
- New client/src/components/Chat/SubagentCard.tsx: collapsed header with engine/model, tool count, status and a live elapsed timer, a Stop button emitting subagent:cancel while the run is open, and an expanded body with the task, the subagent's own ToolUseBlocks and the final result text. Theme variables only, no new dependencies
- New client/src/components/Activity/ActivityLogPanel.tsx (props: `{ sessionId }`): timestamped lines, kind badges, expandable detail, filter box, "N logs" counter, auto-scroll that pauses on scroll-up with a resume affordance, and a Clear button. Thinking blocks render in full
- client/src/hooks/useSocket.ts: subscribes to subagent:start/delta/tool/end and activity:event; the dead hub:message listener and the hubStore import are gone
- client/src/components/Chat/MessageBubble.tsx: a spawn_agent / mcp__medusa__spawn_agent tool block renders a SubagentCard once its record exists, and the ordinary ToolUseBlock until then
- Tests: server 338 to 367 (29 new in server/src/socket/__tests__/activity.test.ts covering every ParsedEvent kind, each subagent event, truncation and the correlation helper). `npx tsc --noEmit` clean on the server, `npx tsc -b --noEmit` clean on the client. Booted on PORT=3998 with a throwaway HOME: GET /api/health 200

## 2026-09-17 19:15
- Orchestrator prompt (S8, spec section C plus the addendum's "The Medusa layer"): one prompt composed by the harness and injected identically into every engine. Persona, working-folder discipline, subagent instructions, reply style, user rules, then the session's own notes. The only engine-dependent part is tool naming: `mcp__medusa__spawn_agent` on the claude CLI, bare `spawn_agent` everywhere else
- Added: server/src/sessions/orchestrator-prompt.ts (`buildOrchestratorPrompt`, `loadRuleFiles`, `toolName`), server/src/sessions/medusa-persona.md (the default persona, overridable by `~/.medusa/MEDUSA.md`), server/src/sessions/__tests__/orchestrator-prompt.test.ts (19 tests)
- Deleted: server/src/sessions/compact-prompts.ts. Its bot-era role prompts carried [HUB-POST]/[TASK-DONE] markers and had no callers left after S3; nothing replaces the compact/full mode split
- server/src/socket/handler.ts: the send path now compresses only the per-session section (session systemPrompt + skills + summary) and passes it to buildOrchestratorPrompt as `sessionSystemPrompt`, so it lands under "## Project notes" and never substitutes the orchestrator body. The orchestrator text itself is not compressed. Per-engine injection mechanics are unchanged
- `~/.medusa/rules/*.md` are appended alphabetically, all on by default; an explicit `rules` array overrides the directory for per-session toggles

## 2026-09-17 19:05
- Removal (S3, docs/2026-09-17_medusa_only_orchestrator_spec.md section D): deleted the server-side multi-bot system so only Medusa replies. Hub messages, mention routing, poll scheduling, bot-to-bot task routing, dev control, and the human-in-the-loop approval path are gone. Rebased onto main so S1's subagent work and S2's session model are the base
- Deleted: server/src/hub/store.ts, server/src/hub/mention-utils.ts, server/src/hub/mention-router.ts, server/src/hub/poll-scheduler.ts, server/src/hub/post-processor.ts, server/src/hub/approval-store.ts, server/src/hub/__tests__/post-processor.test.ts, server/src/dev-control/store.ts, server/src/dev-control/controller.ts, server/src/routes/hub.ts, server/src/routes/approvals.ts, server/src/routes/dev-control.ts, server/src/projects/task-sync.ts, server/src/claude/autonomous-deliver.ts, server/default-bots.json
- server/src/socket/handler.ts: dropped HubPostDetector, buildHubPromptSection, extractTaskDone and all [HUB-POST]/[TASK-DONE]/[BOT-TASK]/[NO-ACTION] marker handling, mention routing, hub prompt injection, the hub:post handler and every io.emit("hub:message"). Everything main added (tool_use/tool_result with parentToolUseId, error-policy dedupe/auth handling, provider-tagged usage, the Anthropic-compatible provider bypass) is untouched. A small in-file FIFO send queue replaces MentionRouter's queueDirectMessage/onSessionIdle, so message:queued still works
- server/src/index.ts: dropped hub/dev-control/mention-router/task-sync construction and route mounts, restored the plain io.emit, removed the AR2 auto-resume-via-autonomousDeliver loop and the BOT-ANNOUNCE block
- Applied server/src/subagents/HANDLER_PATCH.md (now deleted): SubagentManager is constructed in index.ts with per-session engine/provider resolution, /api/subagents is mounted, subagent:cancel is handled on the socket, message:abort now calls cancelForParent, both graceful-shutdown paths call cancelAll, spawn_agent / mcp__medusa__spawn_agent tool_use blocks are registered with registerSpawnToolUse (and cleared on result) so cards anchor to the parent tool call, and descriptorForSession() is threaded through ProcessManager.sendMessage into EngineSpawnOptions.mcpConfig, so every engine spawn for a chat now carries --mcp-config / mcpServers. Subagent spawns are still handed no descriptor, so the tree stays one level deep
- Applied server/src/sessions/HANDLER_PATCH.md (now deleted): the send path resolves the chat's own provider (`meta.providerId ?? getActiveProvider()`), which drives the usage-log tag, the tier-routing bypass and the default model, and both processManager.createSession calls plus the three sendMessage calls now carry `{ engineId, providerId }` from SessionMeta. index.ts's boot-time restore loop does the same, so sessions restored after a restart resolve per-session rather than falling back to the global provider
- Also edited: server/src/routes/health.ts (poll-scheduler param out, optional SubagentManager in), server/src/config.ts (removed hubFile/approvalsFile/devControlFile/hubPolling/hubPollIntervalMs/staleTaskThresholdMs), server/src/claude/model-router.ts plus its test (dropped the poll/mention/nudge sources and the `[Hub Check]`/`[NO-ACTION]` patterns), server/src/claude/process-manager.ts (sendMessage takes an optional mcpConfig descriptor and forwards it to engine.spawn), server/src/routes/sessions.ts (dropped the structural MentionRouter/HubPollScheduler params S2 left behind), server/src/projects/store.ts (stale HubStore/task-sync comments)
- Kept, with reason: server/src/sessions/compact-prompts.ts still carries `[HUB-POST:]`-era prompt text and is now dead code, but S8 owns its deletion. server/src/sessions/store.ts and its migration test still match on `[HUB-POST`/`[TASK-DONE`/`[BOT-TASK` on purpose: that is S2's migration stripping those markers out of old bot prompts
- Server tests: 352 to 338 (dropped the 12-case hub/post-processor file and 2 poll/mention model-router cases). `npx tsc --noEmit` clean on the server, `npx tsc -b --noEmit` clean on the client (it still references hub socket events, which S7 removes, but no deleted server type was imported so no stub was needed)
- Verified by booting on PORT=3999 with a throwaway HOME: `GET /api/health` 200, `/api/hub`, `/api/approvals` and `/api/dev-control` all 404, `/api/subagents` 200 with a token and 401 without
- Orphaned user data left in place on purpose (spec D.6b): ~/.claude-chat/hub.json, tasks.json, dev-control.json, approvals.json and the chats/<id>.json files of dropped bot sessions can be deleted by hand

## 2026-09-17 18:31
- Feature (workstream S1 of the Medusa-only orchestrator spec, `docs/2026-09-17_medusa_only_orchestrator_spec.md` section A): the `medusa` MCP server and the SubagentManager behind it. Medusa can now run subagents through one uniform mechanism on every engine
- New server/src/mcp/: `descriptor.ts` holds the single `MedusaMcpDescriptor` both engine spellings derive from; `config.ts` exposes `buildMcpConfigJson()` (the `{"mcpServers": {"medusa": {...}}}` object map the claude and kimi CLIs take) and `buildAcpMcpServers()` (the ACP array form with env as name/value pairs), so the two cannot drift; `tools.ts` declares the tool surface as data; `medusa-mcp-shim.ts` is the stdio process every engine spawns, which speaks MCP on stdin/stdout and plain HTTP back to Medusa on 127.0.0.1 with a Bearer token
- Tools per spec A.4: `spawn_agent`, `agent_status`, `agent_result`, `list_agents`, `cancel_agent`. The shim is generic on purpose (tools are specs, not code) so the Medusa tools layer in `docs/2026-09-17_ui_and_layer_addendum.md` (Browser/CDP, Simulator/idb, files, shell) can be carried by the same shim without touching it: descriptor and shim both understand a `toolsets` filter
- New server/src/subagents/: `SubagentManager` owns the whole lifecycle, spawning a full `Engine` per subagent so any engine/model can be a subagent's brain regardless of the parent's. Per-session (3) and global (6) concurrency caps queue rather than spawn, cancellation lands on the engine's own abort, a crashed child becomes `status: "error"` and still emits `subagent:end`, `cwd` is rejected when it escapes the parent chat's folder, yolo is inherited and cannot be escalated, and `resultText` is truncated at 24,000 chars with a `truncated` flag plus a JSONL transcript under `~/.claude-chat/subagents/`
- Socket events emitted to the parent session's room, anchored to the parent `spawn_agent` tool_use id: `subagent:start`, `subagent:delta`, `subagent:tool`, `subagent:event` (the raw ParsedEvent passthrough), `subagent:end`
- New server/src/routes/subagents.ts: the HTTP surface the shim calls, scoped to one chat by the `x-medusa-parent-session-id` header the shim sets from its environment, so one chat can never see or cancel another's subagents
- `EngineSpawnOptions` gains one optional additive field, `mcpConfig`, wired at three injection points: `claude --mcp-config <json>` (deliberately WITHOUT `--strict-mcp-config`, so the user's own .mcp.json servers stay available), `kimi --mcp-config <json>` (verified against `kimi --help` 1.47.0), and ACP `session/new`/`session/load` `mcpServers` (previously always an empty array). Subagents are never handed an mcpConfig, so the tree stays one level deep
- Kimi abort fix: `kimi` installs no SIGTERM or SIGINT handler, so a killed client skips its own `shutdown_background_tasks()` and any `kimi-code-bg-worker` it started for a backgrounded Shell call keeps running. There is no flag or config key that disables that worker and no `kimi cancel` subcommand; the worker also overwrites its argv, so it carries no session marker in `ps`. `KimiCliEngine.abort()` now SIGTERMs the client and then reaps only THAT session's workers via the CLI's own on-disk task state (`~/.kimi/sessions/<workdir hash>/<session key>/tasks/*/`), writing `control.json` for the graceful path and signalling `child_pgid`/`worker_pid` as the fallback. Findings documented in a comment at the top of the engine
- `server/src/socket/handler.ts` is untouched (workstream S3 owns it). The exact code S3 must add (the `subagent:cancel` handler, `cancelForParent` on `message:abort`, where the manager is constructed and passed in, and the tool_use correlation hook) is written out in server/src/subagents/HANDLER_PATCH.md
- New dependency: `@modelcontextprotocol/sdk` (the shim's MCP server side), the only new runtime dependency
- Tests: 352 server tests green (298 before, +54): server/src/mcp/__tests__/config.test.ts (13), server/src/subagents/__tests__/manager.test.ts (34), and 7 new engine argv cases asserting the claude and kimi argv carry `--mcp-config` with parseable JSON naming `medusa` and no `--strict-mcp-config`, and that ACP's `session/new` carries a non-empty `mcpServers`. `child_process.spawn` stays mocked throughout; no real CLI is touched
- Files affected: server/src/mcp/descriptor.ts (new), server/src/mcp/config.ts (new), server/src/mcp/tools.ts (new), server/src/mcp/medusa-mcp-shim.ts (new), server/src/mcp/__tests__/config.test.ts (new), server/src/subagents/manager.ts (new), server/src/subagents/types.ts (new), server/src/subagents/HANDLER_PATCH.md (new), server/src/subagents/__tests__/manager.test.ts (new), server/src/routes/subagents.ts (new), server/src/engine/types.ts, server/src/engine/claude-cli-engine.ts, server/src/engine/kimi-cli-engine.ts, server/src/engine/acp-engine.ts, server/src/engine/__tests__/claude-cli-engine.test.ts, server/src/engine/__tests__/kimi-cli-engine.test.ts, server/src/engine/__tests__/acp-engine.test.ts, server/src/config.ts, server/package.json

## 2026-09-17 18:30
- S2 (Medusa Only orchestrator spec, section B): the session model becomes one chat = one folder + one provider + one model + one engine
- SessionMeta gains `engineId`, `providerId` and `archived`; `compactSystemPrompt` is removed (old files still parse, the field is dropped on the next write). `workingDir` and `model` are unchanged
- New `SessionStore.migrateFromBots()`: on first boot it copies `~/.claude-chat/sessions.json` to `~/.claude-chat/sessions.bots.backup.json`, keeps the Medusa session with its id byte for byte (so `chats/<id>.json`, `<id>.summary.txt` and `claude --resume <id>` all stay attached), clears any systemPrompt carrying `[HUB-POST`/`[TASK-DONE`/`[BOT-TASK` or PM roster wording, drops the other bots from sessions.json, and writes a `.migrated-single-agent` marker so a second load is a no-op. Bot chat files are left on disk
- Deleted `loadDefaults()` and `server/default-bots.json`: a fresh install now starts with zero chats
- `POST /api/sessions` now requires `workingDir` and accepts `engineId`/`providerId`/`model`; the title defaults to the folder basename, deduped ("Medusa", "Medusa 2"). `PATCH /api/sessions/:id` accepts name, systemPrompt, model, engineId, providerId and workingDir, validating engine and provider ids. Removed `POST /api/sessions/bulk-prompt-append` (a multi-bot convenience). Rename, reorder and delete are unchanged
- ProcessManager resolves the provider per session (per-call override, then the session's engine/provider, then the global setting) instead of always calling `getActiveProvider()`; new `configureSession()` and `updateWorkingDir()` keep the spawn path in step with the chat's settings
- The resolved provider is threaded into the spawn as `EngineSpawnOptions.providerId`, which `ClaudeCliEngine` prefers over the global `getActiveProvider()` when building the Anthropic-compatible env, so one chat can run on OpenRouter while another stays native. ProcessManager keeps main's engine-registry delegation; the engine that last spawned is tracked separately (`spawnedEngineId`) so abort still tears down the same way
- Orphaned in `~/.claude-chat/` after migration and safe to delete by hand: `hub.json`, `tasks.json`, `dev-control.json`, `approvals.json`, and the `chats/<id>.*` files of the dropped bots
- Tests: new `sessions/__tests__/migration.test.ts` (16) and `routes/__tests__/sessions.test.ts` (18); server suite 264 to 298, all green, `tsc --noEmit` clean
- Files affected: server/src/sessions/store.ts, server/src/sessions/compact-prompts.ts, server/src/sessions/HANDLER_PATCH.md, server/src/sessions/__tests__/migration.test.ts, server/src/routes/sessions.ts, server/src/routes/__tests__/sessions.test.ts, server/src/claude/process-manager.ts, server/src/engine/types.ts, server/src/engine/claude-cli-engine.ts, server/default-bots.json (deleted)

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
