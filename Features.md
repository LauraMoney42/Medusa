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

2. **Live computer-use view: CDP screencast pane + supervised take-over**
   Maps directly to the *Computer Use* role and is the most visual proof of agentic
   control (Claude Cowork parity). Attach to the existing CDP Chrome on `:9222`, run
   `Page.startScreencast`, broadcast frames over a Socket.IO channel, render in a new
   `client/src/components/Cowork/` pane, and forward pane clicks/keys back as CDP
   `Input.dispatch*` for take-over.

3. **Multi-machine agent orchestration: brain on the mini + a runner per machine + task routing**
   The *Research Engineer, Agents* story: a real distributed multi-agent system. One
   brain (chat, Hub, memory, projects) on the always-on Mac mini; a lightweight runner
   daemon per machine (laptop + mini) that dials out and registers a target name; task
   routing so one Medusa dispatches to `mac-mini` or `laptop`. Single shared memory at
   the brain (no dual-instance sync).

4. **Human-in-the-loop safety / guardrails**
   Anthropic's core value; shows a safety-first agent design mindset. Approvals for
   irreversible actions (send / publish / delete / purchase), isolated automation Chrome
   profile, no auto-run of untrusted community skills, mTLS / ACL on the runner link.

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

- **TTS (her voice out)** — server-side neural TTS, streamed to clients so she sounds
  identical on Mac and iOS. ElevenLabs Flash v2.5 as default, Kokoro-on-the-mini as the
  free local fallback, per-bot `voice` toggle (`flash` / `kokoro` / off). Replaces the
  robotic on-device synth. Playback via `<audio>` on web, `AVAudioPlayer` on iOS.
- **STT (mic in)** — ✅ **DONE (2026-08-05)**. A mic button in the chat input
  (`MicButton.tsx`) records with MediaRecorder and posts to `/api/stt`, which forwards to
  any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, Groq, or a local
  whisper.cpp / faster-whisper server on the mini). The transcript is appended to the
  input. Chosen over the browser `SpeechRecognition` API because that doesn't work in the
  packaged WKWebView app. To enable: set `STT_API_KEY` (button hidden until then) and
  rebuild the macOS app so the mic permission takes effect.
  **Remaining:** for best accuracy, point `STT_API_BASE_URL` at a local Whisper/Parakeet
  server on the mini; optionally add live/streaming transcription later.

---

## First milestone

Items 1–4 hit three of the four target roles at once (evals/CI + visible computer-use +
multi-agent orchestration + a safety layer). Items 6–7 are the highest-visibility
product upgrades and pair naturally with the PWA/app work.

**Status:** #1 Test suite + CI badge — ✅ done. Next up: pick between #2 (computer-use
view) and #6 (UI overhaul).
