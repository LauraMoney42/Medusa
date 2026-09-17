# Cowork Parity, Tauri Shell, and Model-Agnostic Engine: Plan
**Project: Medusa**
**Date:** 2026-09-15
**Status:** PLANNING (nothing built yet; open questions at the bottom)

---

## 0. Where Medusa stands today (audit, 2026-09-15)

| Layer | Current | Notes |
|---|---|---|
| Native shell | Swift `WKWebView` wrapper (`app/Sources/*.swift`, hand-rolled `.app` bundle via `build-app.sh`) | Mac only. Boots the Node server and loads the web client. |
| Server | Node + TypeScript, Express 4, Socket.IO 4 (`server/src`) | Sessions, Hub, runner protocol, TTS (Kokoro), STT (Whisper), CDP screencast, `idb` simulator stream, token metrics. |
| Client | React 19 + Vite 7 + Zustand (`client/src`) | Cowork-style layout already shipped: chat list, rename, search, agent/provider/model pickers, token ring, Browser pane, Simulator pane, mic. |
| Engine (the "harness") | Spawns the `claude` CLI (`claude -p --output-format stream-json`) or the `kimi` CLI per session (`server/src/claude/process-manager.ts`) | All agent power (tools, MCP, skills, subagents, streaming, usage events) comes from the `claude` CLI. This is the single hard lock-in point. |
| Model choice | Anthropic tiers (haiku/sonnet/opus/fable) via `--model`; Kimi via `ANTHROPIC_BASE_URL` | Roadmap item #11 (LiteLLM gateway) is spec'd but deferred. |

**Bottom line:** the UI, browser, simulator, voice, sessions, and multi-machine pieces already exist. Two things are missing for the "Claude Cowork but any model" goal:
1. A proper cross-platform desktop shell (Tauri), and
2. A model-agnostic engine that does not depend on the proprietary `claude` binary.

---

## 1. The one big decision: what is the engine?

Everything else is straightforward. This choice decides how "agnostic" Medusa really is.

### Option A: Keep the `claude` CLI, swap the brain (roadmap #11)
Put LiteLLM (or OpenRouter directly, since it already speaks the Anthropic Messages API) behind `ANTHROPIC_BASE_URL`.
- **Pro:** smallest change. Existing `getHeadroomEnv` injection path already does this for Kimi. Keeps Claude Code's excellent tool loop, MCP, skills, subagents.
- **Con:** still requires the proprietary `claude` binary installed and an Anthropic login. Not truly agnostic; you are borrowing Anthropic's harness to drive GPT/Gemini. Tool-call quality through the translation layer is model-dependent. Anthropic controls the binary and can change or restrict this at any time.
- **Verdict:** great as a *bridge* and as the "Claude provider" long-term, but not the agnostic foundation.

### Option B: Replace the engine with an open, multi-provider harness
Medusa spawns a different agent CLI (same `stream-json`-style NDJSON contract Medusa already parses). Candidates:

| Harness | Language | Providers | Streaming JSON for embedding | MCP | Notes |
|---|---|---|---|---|---|
| **Code Puppy** ([mpfaffenberger/code_puppy](https://github.com/mpfaffenberger/code_puppy)) | Python, Pydantic AI | 65+ via models.dev, round-robin across models | Needs verification (see Q1) | Yes (Pydantic AI) | The theme/brand you want. Smallest community. |
| **OpenCode** ([anomalyco/opencode](https://github.com/anomalyco/opencode)) | TypeScript | 75+, incl. GitHub Copilot subscription as a provider | Yes (`opencode run --format json`, plus an HTTP server mode) | Yes | 171k stars, multi-session, LSP. Same language as Medusa's server. |
| **Goose** ([block/goose](https://github.com/block/goose)) | Rust | 25+, incl. Ollama local | Yes (`goose run` + ACP / server mode) | Yes, 70+ extensions | Linux Foundation backed, most mature desktop. |

- **Pro:** true provider agnosticism, no proprietary binary, users bring any key or subscription.
- **Con:** Medusa's server has Claude-CLI assumptions baked in (`--resume`, `--session-id`, `usage` events, hub markers in the stream, `--dangerously-skip-permissions`). Each must be mapped to the new harness or reimplemented.

### Option C (recommended): Provider abstraction with two engines
Introduce an `Engine` interface in the server. Ship **two** implementations:
1. `ClaudeCliEngine` (today's code, kept intact for Anthropic subscribers), and
2. `OpenHarnessEngine` (Code Puppy or OpenCode, decided by Q1) for every other provider.

The UI's existing Provider + Model pickers choose the engine + model per bot. This mirrors how Medusa already switches between `claude` and `kimi` in `ProcessManager.send()`, just made explicit and extensible.

**Why not pick one:** Claude Code's harness is still the best tool loop for Anthropic models; forcing Claude through a third-party harness would make the Anthropic experience worse, not better. The abstraction costs one interface and keeps both paths first-class.

---

## 2. "One subscription, any model" services (Q2 decides which to support first)

| Service | Model of payment | API shape | Fit for Medusa |
|---|---|---|---|
| **OpenRouter** | Pay-per-token, one key, 300+ models | OpenAI-compatible **and** Anthropic-Messages-compatible | Best first target. Works with Option A today (point `ANTHROPIC_BASE_URL` at it) and with every open harness. |
| **GitHub Copilot** | Flat subscription (Pro/Pro+), per-token metering added June 2026 | Copilot API; OpenCode has a first-class `github-copilot` provider | Only clean path is via OpenCode (or reusing its provider code). Pushes Q1 toward OpenCode. |
| **Direct keys** (OpenAI, Google, xAI, DeepSeek, Kimi) | Pay-per-token per vendor | Native | Already how Kimi works. Any harness supports these. |
| **Local** (Ollama, LM Studio) | Free | OpenAI-compatible | Works with all three open harnesses. Good demo, weak tool-calling. |

Recommendation: **OpenRouter first** (covers GPT-5.x, Gemini, Claude, DeepSeek with one key), direct vendor keys second, Copilot third if the engine is OpenCode.

---

## 3. Tauri shell (Mac first, Windows later)

Replace `app/` (Swift WKWebView) with a Tauri v2 project.

- **Frontend:** the existing Vite/React client, unchanged. Tauri serves the built `client/dist`.
- **Backend:** the Node server ships as a **Tauri sidecar**: compile `server/dist` into a single binary (`bun build --compile` or `pkg`), listed in `tauri.bundle.externalBin`. Tauri spawns it on launch on port 0, learns the port via stdout, and the client connects. Windows gets the `.exe` variant automatically via the target-triple naming.
- **What the Swift shell does today that Tauri must replace:** server lifecycle (`ServerManager.swift`), WKWebView (`WebViewController.swift`), screen-capture window/region pickers (`WindowPickerController.swift`, `RegionPickerController.swift`). The pickers become Tauri commands (Rust) or a small plugin; everything else is stock Tauri.
- **Platform reality check for Windows:**
  - Browser pane (CDP screencast): works, Chrome is cross-platform.
  - iOS Simulator pane (`idb`): **Mac only**, hide the view on Windows.
  - TTS (Kokoro) and STT (Whisper): Python side-processes; need Windows install paths tested.
  - `claude` CLI engine: available on Windows; open harness also cross-platform.
- **Why Tauri over Electron:** ~10 MB vs ~150 MB installer, native WebView, Rust plugin surface for the OS-level bits (window picking, global hotkeys, tray). Same trade you already made by hand-rolling a WKWebView shell.

---

## 4. Claude Cowork / Desktop features: parity checklist

"Reverse engineer" here means: replicate the *behaviors* using Medusa's own open stack. Status is from the 2026-09-15 audit.

| Cowork / Claude Desktop feature | Medusa today | Gap |
|---|---|---|
| Session sidebar, rename, search | Done | None |
| Model picker per chat | Done (Anthropic + Kimi, hardcoded) | Dynamic list from the engine (`GET /v1/models`, or harness `models list`) |
| Streaming responses with tool-call cards | Done | Map second engine's event stream into the same `MessageBubble` types |
| Browser view + take-over | Done (CDP) | None |
| iOS Simulator view + take-over | Done (`idb`) | Build+boot flow from `ios-bot` (roadmap #5 remainder) |
| Voice in (mic) / voice out (TTS) | Done | Windows packaging |
| Artifacts (rendered HTML/preview pane) | Not present | New: a sandboxed preview pane fed by a file path or HTML string from the agent |
| Skills / plugins | Via `claude` CLI only | Open harness needs its own skills dir mapping; `server/src/skills` exists as a start |
| Approval / permission prompts | Done (ApprovalBanner) | Wire to second engine's permission events |
| Scheduled tasks / routines | Poll scheduler exists (`hub/poll-scheduler.ts`) | Expose in UI as "Routines" |
| Multi-machine (runner) | Exec primitive done | Route a session spawn to a runner (roadmap #3 remainder) |
| Native app: tray, hotkey, notifications, auto-update | Partial (Swift shell) | Tauri gives all four with plugins |

---

## 5. Phased plan

**Phase 1: Engine abstraction + OpenRouter bridge** (about 1 week)
1. Extract `Engine` interface from `ProcessManager` (`spawn`, `resume`, `abort`, event stream type). Keep `ClaudeCliEngine` behavior identical; existing 170 tests must stay green.
2. Add `ANTHROPIC_BASE_URL` routing to OpenRouter per bot (extends `getHeadroomEnv`). This alone gives "GPT-5.x / Gemini behind Medusa" on day one via Option A.
3. Dynamic model list in `ChatHeaderControls` from the configured provider instead of the hardcoded array.
4. Tag `TokenUsageEntry` with provider+model so the token ring is correct for non-Anthropic backends.

**Phase 2: Open harness engine** (about 2 weeks, depends on Q1)
1. Spike: run Code Puppy (or OpenCode) headless, capture its JSON event stream, write a parser next to `stream-parser.ts`.
2. Implement `OpenHarnessEngine`; map session resume, abort, permissions, usage.
3. Provider settings UI: keys stored in `~/.claude-chat/settings.json` (user-entered, never by the agent).
4. Parity tests: same test prompts through both engines; compare tool-call success (this doubles as a real eval, which fits the roadmap's Model Evaluations story).

**Phase 3: Tauri shell, Mac** (about 1 week)
1. `tauri init` alongside `client/`; bundle Node server as sidecar; port-0 handshake.
2. Port window/region pickers to Tauri commands.
3. Tray, global hotkey, native notifications, auto-updater.
4. Retire `app/` Swift shell once parity is verified.

**Phase 4: Windows + polish** (about 1 week)
1. Windows sidecar build, TTS/STT install paths, hide Simulator view.
2. Artifacts preview pane.
3. Rebrand pass (Code Puppy theme) if that is the product direction (Q3).

Estimates assume one developer plus agents, part time. Phases 1 and 3 are independent and can run in parallel.

---

## 6. Branding and business model (decided 2026-09-15)

- **The product stays Medusa.** Medusa is the LLC's own product with its own history, docs, and name. Code Puppy is a friend's project and is credited as an engine ("Powered by Code Puppy"), never as the brand.
- **Open-core.** The core app (shell, UI, engines, browser/simulator/voice) is open source under MIT or Apache 2.0 for adoption and name recognition. Paid tier later: hosted brain, team features, signed Windows/auto-update builds, support. This is the Goose / OpenCode playbook and it is what makes a "model-agnostic" claim credible.
- **Courtesy:** talk to the Code Puppy author before shipping the integration so it is welcomed, and consider contributing the JSON streaming mode upstream if it is missing.

## 7. Dependency risk: how hard should Medusa lean on Code Puppy?

Every engine sits behind the `Engine` interface (Section 1, Option C), so no single harness can hold Medusa hostage. Ranked options for the non-Anthropic engine:

1. **Code Puppy behind the interface (chosen for Phase 2).** Pin a version, spawn it as a side-process exactly like `claude` and `kimi` today, keep the parser isolated in one file. Risk is bus factor (small community, Python runtime must be installed or bundled). Mitigation: the interface makes it swappable in one file, and OpenCode is the ready fallback.
2. **OpenCode as fallback engine.** TypeScript, huge community, Copilot provider. Add as a third engine only if Code Puppy stalls; the interface makes that cheap.
3. **Native in-house harness (long-term option).** Medusa's server is TypeScript; the Vercel AI SDK gives multi-provider streaming + tool calling in-process with no external CLI at all. Most agnostic and zero third-party harness risk, but it means reimplementing the tool loop, permissions, MCP client, and subagents that the CLIs give for free. Revisit after Phase 2 once the engine interface has proven itself with two external harnesses.

## 8. Parallel work breakdown (subagents)

Rules: one git worktree per workstream (`EnterWorktree`), each stream owns a disjoint set of files, merge to `main` behind green tests. Opus for judgment-heavy specs and the core engine refactor, Sonnet for well-scoped build tasks.

### Batch 1 (all independent, run at once)

| ID | Workstream | Model | Owns | Output |
|---|---|---|---|---|
| W1 | Claude Cowork / Code feature and UX audit (Section 9 method) | Opus | `docs/cowork_parity_audit.md` | Feature matrix: Cowork/Code behavior, Medusa status, gap, priority |
| W2 | `Engine` interface extraction from `ProcessManager`; `ClaudeCliEngine` keeps byte-identical behavior; all 170 tests green | Opus | `server/src/engine/*`, `server/src/claude/process-manager.ts` | PR-ready refactor |
| W3 | Code Puppy headless spike: install, run non-interactively, capture stream format, write `docs/code_puppy_stream_format.md` + sample `.jsonl` | Sonnet | `docs/`, scratch only | Go/no-go on Phase 2, parser spec |
| W4 | Tauri v2 scaffold in `desktop/`: loads `client/dist`, spawns server sidecar on port 0, port handshake, Mac build boots | Sonnet | `desktop/*` (new) | Running Mac app, Swift shell untouched |

### Batch 2 (after Batch 1 merges)

| ID | Workstream | Model | Depends on | Output |
|---|---|---|---|---|
| W5 | OpenRouter provider via `ANTHROPIC_BASE_URL` per bot + dynamic model list in `ChatHeaderControls` + provider/model tags on `TokenUsageEntry` | Sonnet | W2 | GPT-5.x / Gemini selectable in the picker |
| W6 | `CodePuppyEngine` + stream parser + tests | Opus | W2, W3 | Second engine live |
| W7 | Port window/region pickers to Tauri commands; tray, hotkey, notifications, auto-update | Sonnet | W4 | Swift shell retired |
| W8 | Provider settings UI (keys in `~/.claude-chat/settings.json`, never entered by the agent) | Sonnet | W5 | Settings pane |

**Status 2026-09-17:** Batch 1 (W1 to W4) and Batch 2 (W5, W6, W7, plus W12 stream-json fix) merged to main; 249 server tests. W6 shipped as a generic `AcpEngine` (Agent Client Protocol) rather than a Code Puppy specific parser, so Goose and Gemini CLI can reuse it. W8 (provider settings UI) not started; keys currently come from env or `~/.claude-chat/settings.json`.

### Batch 3
- W9 Windows sidecar build + hide Simulator view + TTS/STT paths (Sonnet, depends on W7)
- W10 Artifacts preview pane (Sonnet, depends on W1 for spec)
- W11 Parity eval: same prompt set through both engines, tool-call success table (Opus, depends on W6)

## 9. How to reverse engineer and document Claude Cowork / Code

Goal is behavior parity, not code theft: document what the product *does* from public, legitimate sources, then rebuild it on Medusa's own stack. Do not decompile the app binary.

1. **Official docs first.** `code.claude.com/docs` (CLI, hooks, MCP, skills, permissions, sessions, slash commands) and the Cowork help pages on `support.claude.com`. Capture every feature name and its documented behavior into the matrix.
2. **Public repo and changelog.** `github.com/anthropics/claude-code` `CHANGELOG.md`, issues, and discussions show the feature timeline and edge-case behavior that docs skip.
3. **Use the product and record it.** With the Claude desktop app open, screenshot each surface (session list, chat, tool cards, permission prompts, browser pane, artifacts, settings, model picker, usage) with the computer-use tools, and write one row per interaction: trigger, what appears, what the user can do next. The `design` skill can then turn screenshots into Medusa artboards.
4. **Instrument the CLI.** `claude -p --output-format stream-json --verbose` already feeds Medusa; log the full event stream for representative sessions (tool use, permission denial, subagent, compaction) into `docs/stream-format-example.jsonl`-style fixtures. These become the contract every engine must satisfy.
5. **Diff against Medusa.** Merge 1 to 4 into the feature matrix (Section 4 seed) with a status column and priority; that matrix is W1's deliverable and the backlog for W10 and later.

## 10. Open questions (need answers before Phase 2 starts)

- **Q1. Which open harness?** Code Puppy (the brand you want, Python, smaller) vs OpenCode (TypeScript like Medusa's server, Copilot provider, huge community). Need to verify Code Puppy has a stable machine-readable streaming mode before committing.
- **Q2. Which subscription service first?** OpenRouter (one key, pay-per-use) vs GitHub Copilot (flat sub, only via OpenCode).
- **Q3. Product direction:** is this still "Medusa" with a Code Puppy engine option, or a full rebrand to a Code Puppy themed product? Affects naming, icons, repo, and whether `~/.claude-chat` config paths get renamed.
- **Q4. Do we keep the `claude` CLI engine long-term** (recommended: yes, as the Anthropic provider) or aim for zero Anthropic-binary dependency?
- **Q5. Uncommitted work:** 15 modified files + 2 untracked docs are sitting in the working tree. Commit or stash before Phase 1 refactors touch `process-manager.ts` and `stream-parser.ts`.

---

## References
- Roadmap: `Features.md` #3, #5, #6, #11
- Engine: `server/src/claude/process-manager.ts`, `server/src/claude/stream-parser.ts`, `server/src/claude/model-router.ts`
- Native shell: `app/Sources/*.swift`, `app/build-app.sh`
- Tauri sidecar docs: https://v2.tauri.app/learn/sidecar-nodejs/
- Code Puppy: https://github.com/mpfaffenberger/code_puppy
- OpenCode: https://github.com/anomalyco/opencode
- Goose: https://github.com/block/goose
- OpenRouter with Anthropic-compatible API: https://openrouter.ai
- Claude Code custom providers: https://code.claude.com/docs/en/model-config
