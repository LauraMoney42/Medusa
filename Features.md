# Medusa - Planned Features

Roadmap of planned changes, ordered by how directly each one signals the skills the
target Anthropic roles screen for.

**Target roles (from application tracker):**
- ⭐ Research Engineer, Model Evaluations
- ⭐ Research Engineer, Agents
- SWE / Staff, Labs: Applied AI
- 🔻 Research Engineer, Computer Use (reach)

Ranking favors: evals rigor, multi-agent systems, computer-use, and product craft.

---

## Priority order

1. **Test suite + CI badge** - ✅ **DONE (2026-08-05)**
   Strongest signal for *Model Evaluations*: reproducibility, coverage, and a green
   badge is the first thing a reviewer sees. Shipped: vitest v8 coverage config; unit
   tests for `StreamParser` (NDJSON parsing), `selectModel` (model routing), and
   `extractQuickTask` (hub markers); 170 tests across 9 files; GitHub Actions CI
   (server typecheck + tests, client typecheck) and a badge in the README.

2. **Live computer-use view: CDP screencast pane + supervised take-over** - ✅ done (2026-08-05)
   Maps directly to the *Computer Use* role and is the most visual proof of agentic
   control (Claude Cowork parity). Shipped: server `cowork/screencast.ts` (CDP
   `Page.startScreencast` → Socket.IO `cowork:frame`), client `Cowork/CoworkPane.tsx`
   + a "Browser" sidebar view. **Take-over** also done: the pane forwards mouse/wheel/
   keyboard as CDP `Input.dispatch*` / `insertText` - click, scroll, and type in the
   live browser. Verified end-to-end (a click navigated the real Chrome).

3. **Multi-machine agent orchestration: brain on the mini + a runner per machine + task routing**
 - ✅ **exec primitive done (2026-08-05); bot-session routing not yet built**
   The *Research Engineer, Agents* story: a real distributed multi-agent system. Shipped:
   `runner-manager.ts` (brain side, on `io.of("/runner")`, AUTH_TOKEN-gated) +
   `runner-client.ts` (a standalone daemon any machine runs to dial OUT and register a
   name - no inbound port needed). `GET/POST /api/runners` lists connected runners and
   runs a shell command on a named one. Validated locally with two simulated runners
   ("mac-mini" + "laptop"): register/list, exec with custom cwd, nonzero-exit and
   unknown-runner error paths, clean disconnect removal, and auth rejection all confirmed.
   **Remaining (the bigger piece):** actually routing a BOT SESSION to a chosen runner -
   today `ProcessManager` always spawns `claude`/`kimi` locally; making it dispatch a
   spawn to a remote runner instead is a larger, more invasive change to the core spawn
   path, intentionally deferred until this exec primitive had been proven safe and
   working. Also needs: a "single brain on the always-on mini" deployment (currently
   still runs wherever you launch it), and real-machine testing (this was validated with
   two local processes simulating two machines, not the actual laptop + mini pair) once
   the second Mac is available.

4. **Human-in-the-loop safety / guardrails** - ✅ **approval workflow DONE (2026-08-05)**
   Anthropic's core value; shows a safety-first agent design mindset. Shipped: bot
   escalations (`[HUB-POST: @You APPROVAL NEEDED: ...]`) are detected server-side and
   turned into structured requests with a dedicated Approve/Deny UI (`ApprovalBanner`)
   in the Hub and Medusa Chat - no more relying on the user to notice a plain chat
   message. Resolving posts the decision back to the bot via the existing mention
   pipeline. Validated end-to-end (approve + deny paths, live socket push, no
   false-positive detection, persists across restart).
   **Remaining:** isolated automation Chrome profile / no auto-run of untrusted
   community skills / mTLS+ACL on the runner link (these apply to items #3/#9, not yet
   built). Deliberately did **not** touch global Claude Code hooks/settings for this -
   the default `CLAUDE_CONFIG_DIR` (`~/.claude`) is the user's everyday Claude Code
   config, so a global `PreToolUse` hook there would affect their normal CLI usage, not
   just Medusa's bots. That would need a dedicated per-bot config dir first.

5. **Native iOS Simulator control into the same pane** - ✅ **done (2026-08-05)**
   Extends the computer-use narrative to driving real dev tools end to end. Shipped via
   `idb` (Facebook's iOS Development Bridge) rather than cua/Simulator MCP: a new
   "Simulator" sidebar view streams the booted simulator's screen (`idb screenshot`
   polling) and forwards tap/swipe/text/hardware-button input (`idb ui *`), correctly
   converting normalized coords to the simulator's POINT space (not pixel space).
   Validated end-to-end against a real booted simulator, cross-checked with independent
   `idb screenshot` calls. **Remaining:** pair with the existing `ios-bot` xcodebuild
   wrapper so a bot can build + boot + you watch, all in one flow (currently you boot
   the simulator yourself; the view attaches to whatever's already booted).

6. **Cowork-like UI overhaul** (see detailed spec below)
   Strong *Applied AI* / frontend-craft signal and the most immediately visible upgrade.
   Reshapes the client to feel like Claude Cowork: a left chat pane (rename + search),
   an agent selector that always defaults to Medusa, a provider + model selector, and a
   token-usage ring that expands into a usage breakdown.

7. **Voice I/O: server-side TTS + mic / speech-to-text input** (see detailed spec below)
   *Applied AI* product polish. Replaces the robotic on-device voice with streamed
   neural TTS, and adds a mic button with speech-to-text so you can talk out ideas.

8. **Voice-enabled PWA of the existing UI, then native iOS app** - ✅ **PWA shell done (2026-08-05)**
   Turn the client into an installable PWA reachable over Tailscale; evolve to a native
   iOS app reusing the same backend (live view + tap-to-approve). Skip chat channels.
   Shipped: manifest.json + generated icons + a deliberately no-cache service worker
   (installability only - no risk of stale cached responses in a live chat/socket app).
   Validated live: manifest/icons/meta-tags/service-worker registration all verified.
   **Remaining:** reachable over Tailscale (needs #9 first); native iOS app is a
   separate, later effort.

9. **Tailscale remote access**
   Supporting infra hygiene that makes 2-8 reachable from the phone.

10. **(Later) Railway control plane + Mac runner dial-out**
    Only if Medusa needs to be reachable when both Macs are off; the always-on mini
    mostly solves this already.

Items that used to live here as "#11 provider/model-agnostic gateway via LiteLLM"
and the multi-bot framing of #3/#4/#6 are superseded by the redesign below: Medusa
is becoming single-agent and engine-agnostic directly, via an engine registry and
a Medusa-owned MCP server, rather than a LiteLLM proxy in front of a bot roster.

---

## Redesign roadmap: single-orchestrator rebuild (S1-S12)

**Spec:** `docs/2026-09-17_medusa_only_orchestrator_spec.md`, with UI and
long-term direction in `docs/2026-09-17_ui_and_layer_addendum.md`. This
replaces the multi-bot Hub/dev-control/PM system with one agent (Medusa)
that orchestrates subagents herself, uniformly across every engine.

### Batch 1 - independent, run together

| ID | Workstream | Owns | Done when |
|---|---|---|---|
| S1 | Subagent MCP server: `spawn_agent`/`agent_status`/`agent_result`/`list_agents`/`cancel_agent`, backed by a `SubagentManager`, reached identically by every engine over stdio MCP. The engine registry this depends on (`server/src/engine/`) already ships. | `server/src/subagents/`, `server/src/mcp/`, `server/src/routes/subagents.ts` | `spawn_agent` returns a real result through all three engine families; concurrency, cancel, and cost paths unit-tested |
| S2 | Session model + migration: `engineId`/`providerId` on `SessionMeta`, `migrateFromBots()` collapsing the bot roster into one chat, new session-create shape. | `server/src/sessions/`, `server/src/routes/sessions.ts`, `server/src/config.ts` | a real multi-bot `sessions.json` migrates to one chat, backup written, chat history intact |
| S3 | Server removals: Hub, dev-control, task-sync, and their wiring in `index.ts`/`socket/handler.ts`. | `server/src/hub/`, `server/src/dev-control/`, `server/src/projects/task-sync.ts`, `server/src/index.ts`, `server/src/socket/handler.ts` | server boots, typecheck clean, remaining tests green, no `hub` string left under `server/src` |
| **S4** | **Docs** (this pass): rewrite `README.md`, `PROJECT_OVERVIEW.md`, `CLAUDE.md`, `Features.md`; archive the bot-era docs; regenerate the architecture diagram. | `README.md`, `PROJECT_OVERVIEW.md`, `CLAUDE.md`, `Features.md`, `docs/archive/`, `docs/medusa_architecture.*` | no doc describes the Hub as current behavior |

### Batch 2 - after Batch 1

| ID | Workstream | Depends on |
|---|---|---|
| S5 | Left pane + chat header rebuild: New chat button, chat list, folder chip, engine picker, agent-selector removal. | S2, S3 |
| S6 | Subagent card + store + socket events + `MessageBubble` routing. | S1 |
| S7 | Client removals: Hub components, `hubStore`/`taskStore`, hub/task/approval types, `KanbanStrip`. | S3 |
| S8 | Orchestrator system prompt: replaces `compact-prompts.ts` / the bot-role prompt apparatus. | S2 |
| S9 | Tauri folder picker for new-chat creation. | S5 |
| S10 | Usage attribution: `byBot` → `bySession`, `bySubagent`, ring popover line. | S1 |

### Batch 3

- **S11** Projects pane rescope: per-session, `assignments[].owner` repurposed to subagent names. Depends on S5.
- **S12** Cross-engine subagent matrix: the same task set run with `claude`, `kimi`, and `code-puppy` as the subagent brain, under each parent engine. Depends on S1; doubles as an eval artifact.

## The Medusa layer (target architecture)

From the addendum: Medusa is the harness, engines are interchangeable brains.
Any customization a user makes to Medusa should apply identically across
every engine and every tool should feel the same regardless of which one is
running underneath a chat.

1. **Persona and rules layer** - `~/.medusa/MEDUSA.md` plus
   `~/.medusa/rules/*.md` plus `~/.medusa/skills/`, composed into one system
   prompt and injected the same way into every engine (`--system-prompt` for
   `claude`, a prepended prompt for Kimi, the session prompt for ACP agents).
   Rules toggle per session from Settings.
2. **Tools layer** - Browser (CDP), Simulator (idb), local files, shell, and
   `spawn_agent` exposed by the Medusa server as MCP servers, so every engine
   receives the identical tool set instead of relying on each CLI's
   built-ins.
3. **Engine layer** - the `Engine` interface in `server/src/engine`, already
   shipped (`registry.ts`, `claude-cli-engine.ts`, `kimi-cli-engine.ts`,
   `acp-engine.ts`, `code-puppy-engine.ts`). A brain is a stream of text and
   tool calls; nothing above this layer depends on which engine is active.

Parity test: the same prompt with the same rule set on two engines should
produce a reply of the same shape (same tools invoked, same formatting
constraints honored).

Also part of this redesign, per the UI addendum: Arcade is removed; Usage and
Stop All move from the sidebar into Settings; Browser and Simulator become
top-right chat-header icons instead of sidebar nav items; the left sidebar
becomes New chat + chat list only.

---

## Detailed spec - #6 Cowork-like UI overhaul

Goal: make Medusa's UI resemble Claude Cowork.

- **Left chat pane**
  - Chat/session list down the left side (Cowork/Discord-style layout). (exists)
  - **Rename** a chat - ✅ done (right-click → Rename, or pencil → editor).
  - **Search bar** - ✅ done (2026-08-05). Filters the bot list by name in `SessionList.tsx`.
    Future: also match message content.
- **Agent selector** - ✅ done (2026-08-05)
  - Pick which agent/bot to work with when desired (dropdown in the Medusa Chat header).
  - **Always starts with Medusa** as the default agent. Switching loads that bot's history
    and routes messages to it (`MedusaChat` generalized from the hardwired Medusa session).
- **Provider + model selector** - ✅ done (2026-08-05; `ChatHeaderControls`). OpenAI/other
  providers still need backend support (bots are Claude CLI or Kimi today).
  - Choose the **provider**: Anthropic, Kimi (Moonshot), OpenAI, others.
  - Choose the **model** within the provider: e.g. Anthropic → Sonnet / Opus; OpenAI →
    GPT-4o / o-series; Kimi → K2 / latest. (Model list should be provider-scoped.)
  - Note: per-bot model selection already exists (Auto / Haiku / Sonnet / Opus / Fable)
    and Kimi provider routing already exists in the backend - this extends both into a
    unified provider+model picker in the chat header.
- **Token-usage ring** - ✅ done (2026-08-05; `TokenRing` in the sidebar header). Uses a
  soft daily budget (localStorage `medusa-daily-budget`, default $20) since the Max plan
  exposes no hard "tokens left"; shows logged API cost.
  - Small circular/ring gauge showing spend vs. remaining (tokens and/or plan limits).
  - **Click to expand** into a detailed popover like Cowork: context-window usage,
    5-hour and weekly limits with reset times, and credit/dollar balance.
  - Backend already logs token usage (`server/src/metrics/token-logger.ts`,
    `tokenusage/`), so the ring reads from existing data.

## Detailed spec - #7 Voice I/O

- **TTS (her voice out)** - ✅ **DONE (2026-08-05)**. Server-side neural TTS via the local
  Kokoro server (`~/.medusa-tts`, auto-started by `tts-manager.ts`), `/api/tts` route,
  pluggable to ElevenLabs/OpenAI via `TTS_API_BASE_URL/KEY/MODEL/VOICE`. Client speaker
  toggle in the Medusa Chat header auto-speaks each completed reply (+ per-message play
  button); playback via `Audio()`. Replaces the robotic on-device synth.
  **Settings controls - ✅ done:** on/off toggle, a 12-voice Kokoro picker, and a speed
  slider (0.5-2.0×), all in Settings > Voice, backed by a shared `ttsStore` so the header
  toggle and Settings stay in sync; a "Test voice" button previews the current settings.
  **Remaining:** per-bot voice selection; native `AVAudioPlayer` path in the future iOS app.
- **STT (mic in)** - ✅ **DONE (2026-08-05)**. A mic button in the chat input
  (`MicButton.tsx`) records with MediaRecorder and posts to `/api/stt`, which forwards to
  any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, Groq, or a local
  whisper.cpp / faster-whisper server on the mini). The transcript is appended to the
  input. Chosen over the browser `SpeechRecognition` API because that doesn't work in the
  packaged WKWebView app. To enable: set `STT_API_KEY` (button hidden until then) and
  rebuild the macOS app so the mic permission takes effect.
  **Remaining:** for best accuracy, point `STT_API_BASE_URL` at a local Whisper/Parakeet
  server on the mini; optionally add live/streaming transcription later.

## Superseded: provider/model-agnostic model gateway

The earlier plan here was a LiteLLM proxy in front of the `claude` CLI to run
arbitrary models behind Medusa's bots. That approach is superseded by S1's
engine registry (native `claude`/`kimi`/ACP support, no proxy layer) plus
OpenRouter routed through the `claude` CLI harness directly. See the redesign
roadmap above.

---

## Status snapshot (2026-08-05)

**Done:** #1 test suite + CI · #2 live computer-use Browser view + supervised take-over ·
#3 multi-machine runner protocol exec primitive (brain + daemon, AUTH_TOKEN-gated,
validated with two simulated runners) ·
#4 human-in-the-loop approval guardrail (Approve/Deny UI for bot escalations) ·
#5 native iOS Simulator live view + take-over (via idb) ·
#6 Cowork-like UI (search, rename, agent selector, provider/model selector, token ring) ·
#7 voice loop complete - STT (mic + progressive dictation) + Whisper auto-start AND
TTS voice-out (Kokoro + auto-start + speaker toggle + Settings voice controls) ·
#8 installable PWA shell (manifest + icons + service worker).

**Not started / deferred:** #9 Tailscale (needs account login, user action) ·
#10 Railway · the LiteLLM gateway idea (superseded, see above). Remaining follow-ups
noted inline above: #3's bot-session-to-runner routing (the bigger, more invasive
piece) + real two-Mac testing; #4's real tool-call gating needs a dedicated bot
config dir; #5's ios-bot build+boot integration; #8's Tailscale reachability +
native iOS app.

Update: broader engine support has since shipped ahead of the S1-S12
redesign - the engine registry (`server/src/engine/`) now covers Anthropic,
Kimi, OpenRouter, and Code Puppy via ACP. What S1-S12 still adds on top is
the subagent MCP server and the single-orchestrator session model, not the
engines themselves.

This snapshot predates the single-orchestrator redesign; see the "Redesign
roadmap" section above for what is current going forward.
