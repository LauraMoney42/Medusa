# Addendum to the Medusa-only orchestrator spec: UI and the Medusa layer
**Date:** 2026-09-17
**Applies to:** `docs/2026-09-17_medusa_only_orchestrator_spec.md` (merge these into that spec's sections when it is finalized)

## UI decisions (owner, 2026-09-17)

1. **Remove Arcade** (nav item, `client/src/components/Arcade`, and the `phaser` dependency in `client/package.json`).
2. **Remove Hub** (already in the spec's removal inventory).
3. **Browser and Simulator move to the top right of the chat header** as icon buttons, Claude desktop style. They open as a right-hand panel or full-width view for the current session; they leave the left sidebar.
4. **Usage and Stop All leave the sidebar.** Functionality stays: Usage becomes a Settings tab (by bot, by source, by model, cost), Stop All becomes a button in Settings. The per-chat abort on the send button stays.
5. **Left sidebar = New chat + chat list only** (search, rename, delete), plus the Settings gear.

## Target layout (owner reference screenshot, 2026-09-17 18:18; supersedes items 3 to 5 above where they differ)

Three-column desktop layout modeled on a Code Puppy UI build the owner likes, restyled with Medusa's green/dark palette from `docs/MEDUSA_STYLE_GUIDE.md`.

**Left rail (fixed width, collapsible)**
- App mark + "Medusa" title.
- "Recent" chat list: title plus message count on the right; active chat outlined in the accent color; right-click or pencil for rename, delete; search field.
- Bottom group: `+ New Chat`, `Tools`, `Settings`, `Bug / Feature` (opens the repo's GitHub issues page).
- `Tools` opens a management view: Medusa MCP tool set (browser, simulator, files, shell, spawn_agent), user skills, and rule files such as an "adhd mode" rule, each toggleable per session. No Hub, Usage, Stop All, Arcade, or bot list.

**Center: chat**
- Message stream with tool cards and subagent cards.
- Input bar: attach, text ("Ask Medusa..."), mic, send. Session folder chip shown near the input or header.
- **Model selector directly under the input** (dropdown with provider + model + cost tier hint), plus the usage ring. Nothing model-related in the header.

**Right panel (Browser | Simulator tabs)**
- Opens to the right of the chat. States: hidden, slim, wide, full (covers the chat). Width adjustable with a drag bar between chat and panel; double-click the bar to toggle slim/wide.
- Browser tab: tab strip, back/forward/reload, desktop/mobile viewport toggle, URL field, live CDP view with take-over. Simulator tab: the existing idb live view and take-over.
- Header icons at the top right of the chat toggle Browser and Simulator; they open the panel on the matching tab.

**Far right: Activity Log (collapsible, resizable with its own drag bar)**
- Full raw stream for the CURRENT chat: thinking blocks, every tool call with arguments and full output, subagent streams, token counts per call, timestamps, system events. Filter box and a log counter at the bottom. Toggle from a header icon; remembers open/closed per user.

Both panels persist their widths in local storage. Keyboard: Cmd+B toggles the right panel, Cmd+L toggles the Activity Log.

**Message details (second reference screenshot, 18:17)**
- Each assistant message has a footer: timestamp, `Copy`, `Regenerate`, and a collapsible `Show tool calls & activity (N lines)` disclosure that expands that message's own tool calls and subagent activity inline. The Activity Log is the session-wide superset of these.
- With the right panel hidden, the chat column takes the full center width; the Activity Log keeps its own width and has a small `<` collapse handle on its left edge.
- Top-right header icons over the chat: Browser (globe), Simulator, Activity Log toggle. Icons only, tooltips on hover.
- Assistant text uses the full column width with a thin accent rule between sections; user messages are compact bubbles. Bottom of the input area shows a thin accent progress bar while a turn is running.

## Workstream S13: Persona, theme, voice editor and shareable packs (owner, 2026-09-17)

Goal: everything that makes Medusa "yours" is editable in the UI and shareable as one file, so the community can trade personas the way people trade editor themes. This is the open-source growth loop; ship it right after the layout work (S5 to S7).

**Pack format** (`*.medusa-pack`, a zip or a single JSON with embedded assets):
- `manifest.json`: name, version, author, description, license
- `persona.md`: name, greeting, personality/system prompt (the Medusa layer's persona file)
- `rules/*.md`: optional rule files (for example adhd-mode.md), each toggleable
- `theme.json`: color tokens matching `docs/MEDUSA_STYLE_GUIDE.md` variables (background, surface, accent, text, danger), font choice, density, optional avatar image
- `voice.json`: TTS engine (local Kokoro default; optional cloud providers), voice id, speed, pitch, on/off default
- `toolbox.json`: default MCP servers and skills enabled for this persona (see the Toolbox note below)

**In-app editors (Settings > Persona, Theme, Voice, Toolbox):**
- Persona: name, avatar, personality text with live preview chat, rule toggles, "reset to Medusa default"
- Theme: color pickers bound to the CSS variables with instant preview, light/dark, export/import
- Voice: pick from installed Kokoro voices, preview a sample sentence, speed/pitch sliders, per-session mute
- Pack: Export current setup, Import by file picker or drag-and-drop onto the window, "Community packs" link (a GitHub repo of packs is enough at first)
- Every editor change applies to all engines identically through the Medusa layer; nothing here may depend on the active model

**Toolbox** (owner, 2026-09-17): a curated allowlist of favorite MCP servers and skills that are on by default for every new chat, with per-tool permission scopes. Agents may search registries (MCP registry, skills marketplaces) and propose additions; installs happen only on the user's click. Tool schemas load lazily (search first, attach on demand) to keep per-turn token cost flat.

**Ownership:** Sonnet for the editors and pack import/export (client/src/components/Settings/*, server/src/packs/*), Opus for the pack schema and the Medusa-layer prompt composition (`~/.medusa/` layout). Tests: schema validation, round-trip export/import, theme token application, prompt composition parity across two engines.

Branding note: the owner rejected "pick your snake" as a tagline; do not use snake metaphors in UI copy.

## The Medusa layer (owner's end goal, 2026-09-17)

Medusa is the harness; engines are interchangeable brains. Any customization a user makes to Medusa must apply identically to every engine (Claude, Kimi, ChatGPT via OpenRouter, Code Puppy via ACP, local models) and every tool must feel the same on every engine.

1. **Persona and rules layer.** `~/.medusa/MEDUSA.md` (persona) plus `~/.medusa/rules/*.md` (user rules, for example an "adhd mode" rule that enforces short, action-first replies) plus `~/.medusa/skills/`. Medusa composes these into one system prompt and injects it the same way into every engine: `--system-prompt` for the claude CLI, prepended prompt for Kimi, session prompt for ACP agents, unchanged for OpenRouter models routed through the claude CLI. Rules can be toggled per session from Settings.
2. **Tools layer.** Browser (CDP), Simulator (idb), local files, shell, and `spawn_agent` are exposed by the Medusa server as MCP servers, so every engine receives the identical tool set instead of relying on each CLI's built-ins. This is the same mechanism the orchestrator spec evaluates for subagents; the spec's section A should cover the full tool set, not only `spawn_agent`.
3. **Engine layer.** The existing `Engine` interface in `server/src/engine`. A brain is a stream of text and tool calls; nothing above this layer may depend on which engine is active.

Parity test for this layer: the same prompt with the same rule set on two engines must produce a reply of the same shape (same tools invoked, same formatting constraints honored). Add this to the eval in the orchestrator spec's test plan.
