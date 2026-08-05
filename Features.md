# Medusa — Planned Features

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

1. **Test suite + CI badge** — ✅ **DONE (2026-08-05)**
   Strongest signal for *Model Evaluations*: reproducibility, coverage, and a green
   badge is the first thing a reviewer sees. Shipped: vitest v8 coverage config; unit
   tests for `StreamParser` (NDJSON parsing), `selectModel` (model routing), and
   `extractQuickTask` (hub markers); 170 tests across 9 files; GitHub Actions CI
   (server typecheck + tests, client typecheck) and a badge in the README.

2. **Live computer-use view: CDP screencast pane + supervised take-over** — ✅ done (2026-08-05)
   Maps directly to the *Computer Use* role and is the most visual proof of agentic
   control (Claude Cowork parity). Shipped: server `cowork/screencast.ts` (CDP
   `Page.startScreencast` → Socket.IO `cowork:frame`), client `Cowork/CoworkPane.tsx`
   + a "Browser" sidebar view. **Take-over** also done: the pane forwards mouse/wheel/
   keyboard as CDP `Input.dispatch*` / `insertText` — click, scroll, and type in the
   live browser. Verified end-to-end (a click navigated the real Chrome).

3. **Multi-machine agent orchestration: brain on the mini + a runner per machine + task routing**
   The *Research Engineer, Agents* story: a real distributed multi-agent system. One
   brain (chat, Hub, memory, projects) on the always-on Mac mini; a lightweight runner
   daemon per machine (laptop + mini) that dials out and registers a target name; task
   routing so one Medusa dispatches to `mac-mini` or `laptop`. Single shared memory at
   the brain (no dual-instance sync).

4. **Human-in-the-loop safety / guardrails** — ✅ **approval workflow DONE (2026-08-05)**
   Anthropic's core value; shows a safety-first agent design mindset. Shipped: bot
   escalations (`[HUB-POST: @You APPROVAL NEEDED: ...]`) are detected server-side and
   turned into structured requests with a dedicated Approve/Deny UI (`ApprovalBanner`)
   in the Hub and Medusa Chat — no more relying on the user to notice a plain chat
   message. Resolving posts the decision back to the bot via the existing mention
   pipeline. Validated end-to-end (approve + deny paths, live socket push, no
   false-positive detection, persists across restart).
   **Remaining:** isolated automation Chrome profile / no auto-run of untrusted
   community skills / mTLS+ACL on the runner link (these apply to items #3/#9, not yet
   built). Deliberately did **not** touch global Claude Code hooks/settings for this —
   the default `CLAUDE_CONFIG_DIR` (`~/.claude`) is the user's everyday Claude Code
   config, so a global `PreToolUse` hook there would affect their normal CLI usage, not
   just Medusa's bots. That would need a dedicated per-bot config dir first.

5. **Native Mac + iOS Simulator control (cua + Simulator MCP) into the same pane**
   Extends the computer-use narrative to driving real dev tools end to end. Pairs with
   the existing `ios-bot` xcodebuild wrapper: a bot builds the app, boots the Simulator,
   and you watch + take over.

6. **Cowork-like UI overhaul** (see detailed spec below)
   Strong *Applied AI* / frontend-craft signal and the most immediately visible upgrade.
   Reshapes the client to feel like Claude Cowork: a left chat pane (rename + search),
   an agent selector that always defaults to Medusa, a provider + model selector, and a
   token-usage ring that expands into a usage breakdown.

7. **Voice I/O: server-side TTS + mic / speech-to-text input** (see detailed spec below)
   *Applied AI* product polish. Replaces the robotic on-device voice with streamed
   neural TTS, and adds a mic button with speech-to-text so you can talk out ideas.

8. **Voice-enabled PWA of the existing UI, then native iOS app**
   Turn the client into an installable PWA reachable over Tailscale; evolve to a native
   iOS app reusing the same backend (live view + tap-to-approve). Skip chat channels.

9. **Tailscale remote access**
   Supporting infra hygiene that makes 2–8 reachable from the phone.

10. **(Later) Railway control plane + Mac runner dial-out**
    Only if Medusa needs to be reachable when both Macs are off; the always-on mini
    mostly solves this already.

11. **(MVP2+) Provider/model-agnostic model gateway** (see detailed spec below)
    Run ANY model behind Medusa's Claude Code engine via a gateway (LiteLLM) that speaks
    the Anthropic API to the `claude` CLI. **Deferred — staying on Anthropic + Kimi for
    now.** Also fixes multi-provider cost accuracy for the token ring.

---

## Detailed spec — #6 Cowork-like UI overhaul

Goal: make Medusa's UI resemble Claude Cowork.

- **Left chat pane**
  - Chat/session list down the left side (Cowork/Discord-style layout). (exists)
  - **Rename** a chat — ✅ done (right-click → Rename, or pencil → editor).
  - **Search bar** — ✅ done (2026-08-05). Filters the bot list by name in `SessionList.tsx`.
    Future: also match message content.
- **Agent selector** — ✅ done (2026-08-05)
  - Pick which agent/bot to work with when desired (dropdown in the Medusa Chat header).
  - **Always starts with Medusa** as the default agent. Switching loads that bot's history
    and routes messages to it (`MedusaChat` generalized from the hardwired Medusa session).
- **Provider + model selector** — ✅ done (2026-08-05; `ChatHeaderControls`). OpenAI/other
  providers still need backend support (bots are Claude CLI or Kimi today).
  - Choose the **provider**: Anthropic, Kimi (Moonshot), OpenAI, others.
  - Choose the **model** within the provider: e.g. Anthropic → Sonnet / Opus; OpenAI →
    GPT-4o / o-series; Kimi → K2 / latest. (Model list should be provider-scoped.)
  - Note: per-bot model selection already exists (Auto / Haiku / Sonnet / Opus / Fable)
    and Kimi provider routing already exists in the backend — this extends both into a
    unified provider+model picker in the chat header.
- **Token-usage ring** — ✅ done (2026-08-05; `TokenRing` in the sidebar header). Uses a
  soft daily budget (localStorage `medusa-daily-budget`, default $20) since the Max plan
  exposes no hard "tokens left"; shows logged API cost.
  - Small circular/ring gauge showing spend vs. remaining (tokens and/or plan limits).
  - **Click to expand** into a detailed popover like Cowork: context-window usage,
    5-hour and weekly limits with reset times, and credit/dollar balance.
  - Backend already logs token usage (`server/src/metrics/token-logger.ts`,
    `tokenusage/`), so the ring reads from existing data.

## Detailed spec — #7 Voice I/O

- **TTS (her voice out)** — ✅ **DONE (2026-08-05)**. Server-side neural TTS via the local
  Kokoro server (`~/.medusa-tts`, auto-started by `tts-manager.ts`), `/api/tts` route,
  pluggable to ElevenLabs/OpenAI via `TTS_API_BASE_URL/KEY/MODEL/VOICE`. Client speaker
  toggle in the Medusa Chat header auto-speaks each completed reply (+ per-message play
  button); playback via `Audio()`. Replaces the robotic on-device synth.
  **Settings controls — ✅ done:** on/off toggle, a 12-voice Kokoro picker, and a speed
  slider (0.5–2.0×), all in Settings > Voice, backed by a shared `ttsStore` so the header
  toggle and Settings stay in sync; a "Test voice" button previews the current settings.
  **Remaining:** per-bot voice selection; native `AVAudioPlayer` path in the future iOS app.
- **STT (mic in)** — ✅ **DONE (2026-08-05)**. A mic button in the chat input
  (`MicButton.tsx`) records with MediaRecorder and posts to `/api/stt`, which forwards to
  any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, Groq, or a local
  whisper.cpp / faster-whisper server on the mini). The transcript is appended to the
  input. Chosen over the browser `SpeechRecognition` API because that doesn't work in the
  packaged WKWebView app. To enable: set `STT_API_KEY` (button hidden until then) and
  rebuild the macOS app so the mic permission takes effect.
  **Remaining:** for best accuracy, point `STT_API_BASE_URL` at a local Whisper/Parakeet
  server on the mini; optionally add live/streaming transcription later.

## Detailed spec — #11 Provider/model-agnostic model gateway (MVP2+, deferred)

Goal: run Medusa's bots on ANY model (OpenAI, Gemini, Bedrock, DeepSeek, local Ollama, …)
without rewriting the engine. Medusa's power (skills, tools, MCP, subagents, streaming,
Hub, the `usage`/cost result events) all come from the `claude` CLI, so we keep that and
only swap the model behind it — exactly how Kimi already works via `ANTHROPIC_BASE_URL`.

**Approach:** a **LiteLLM** proxy in front of the CLI (recommended over claude-code-router
because LiteLLM also does per-model cost tracking and exposes `GET /v1/models`).

**Work items:**
- **LiteLLM manager** — a supervised side-process like `stt/whisper-manager.ts` /
  `headroom/proxy-manager.ts`: spawn/adopt LiteLLM, health-check, config mapping friendly
  model names → provider models + keys.
- **Bot env routing** — extend the existing `ANTHROPIC_BASE_URL` injection in
  `claude/process-manager.ts` (see `getHeadroomEnv`): a bot's selected model maps to a
  LiteLLM model, injected per-spawn. Decide Headroom×LiteLLM interaction (chain, or
  mutually exclusive for non-Anthropic).
- **Dynamic model picker** — `ChatHeaderControls` reads `GET /v1/models` from LiteLLM
  instead of the hardcoded Anthropic/Kimi list, so whatever is configured shows up.
- **Accurate cost** — pull spend from LiteLLM (or compute `usage × per-model price`), and
  tag each `TokenUsageEntry` with model/provider so the ring + popover are correct for
  every backend. (This is the fix for the "ring is Anthropic-only" limitation.)

**Caveats:** you're swapping the brain, not the harness (a feature). Tool-use quality
varies by model — Kimi K2 / GPT-5.x / Gemini 3 are solid; small local models struggle.
API keys go in the LiteLLM config (the user adds them; keys can't be entered by the agent).

**Refs:** LiteLLM (docs.litellm.ai/docs/tutorials/claude_non_anthropic_models),
claude-code-router (github.com/musistudio/claude-code-router).

---

## Status snapshot (2026-08-05)

**Done:** #1 test suite + CI · #2 live computer-use Browser view + supervised take-over ·
#6 Cowork-like UI (search, rename, agent selector, provider/model selector, token ring) ·
#7 voice loop complete — STT (mic + progressive dictation) + Whisper auto-start AND
TTS voice-out (Kokoro + auto-start + speaker toggle).

**Not started / deferred:** #3 multi-machine runners · #4 human-in-the-loop guardrails ·
#5 native Mac + iOS Simulator control · #8 PWA · #9 Tailscale · #10 Railway ·
#11 model gateway (MVP2+).

Current model support: **Anthropic + Kimi only** (by choice, for now).
