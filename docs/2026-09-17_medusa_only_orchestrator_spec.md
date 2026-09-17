# Medusa Only: Orchestrator Spec

**Project:** Medusa
**Date:** 2026-09-17
**Status:** SPEC (research complete, nothing built)
**Supersedes for the multi-bot parts of:** `docs/2026-09-15_cowork_parity_tauri_agnostic_plan.md`, `docs/cowork_parity_audit.md` (the Hub rows), `HUB_BOT_COORDINATION.md`, `BOT_SYSTEM_GUIDE.md`, `BOT_STATUS_SYMBOLS_IMPLEMENTATION_GUIDE.md`, `MEDUSA_PROJECT_MANAGEMENT_GUIDE.md`

---

## Summary of decisions

1. **Medusa becomes a single agent with subagents, not a team of bots.** Every multi-bot mechanism is deleted: `server/src/hub/`, `server/src/dev-control/`, `server/src/projects/task-sync.ts`, `default-bots.json`, the `[HUB-POST]` / `[TASK-DONE]` / `[BOT-TASK]` markers, mention routing, poll scheduling, bot status symbols, Stop All, and the client `Hub` feed plus `hubStore`.
2. **Subagents run through one uniform mechanism: a Medusa-owned MCP server named `medusa`, reached over stdio by a small shim process that every engine spawns.** This was chosen over engine-native Agent tools and over a prompt-marker protocol. All three engine families are verified to accept it (see A.1).
3. **The Medusa server owns subagent lifecycle**, not the CLI. `SubagentManager` spawns a full `Engine` per subagent, so any engine/model can be a subagent's brain regardless of the parent's engine.
4. **A subagent renders as one collapsible card in the parent chat**, anchored to the `mcp__medusa__spawn_agent` tool_use block by `parentToolUseId` (the plumbing shipped 2026-09-17 16:40 already carries this field end to end).
5. **One chat = one session = one folder + one provider + one model + one engine.** `SessionMeta` gains `engineId` and `providerId`; `workingDir` and `model` already exist and get surfaced in the UI.
6. **Migration keeps the existing Medusa session as chat #1** (same id, so its `~/.claude-chat/chats/<id>.json` history survives) and moves bot sessions to a one-time backup file rather than deleting them on disk.
7. **`server/src/sessions/compact-prompts.ts` is deleted** and replaced by `server/src/sessions/orchestrator-prompt.ts`: one prompt, engine-aware, that documents `spawn_agent`.
8. **The Projects pane stays, rescoped as a per-session artifact** (see E.5). It was the PM surface for bot assignments; it survives as "what this chat's project is working on", backed by the same `~/.claude-chat/projects.json`, with the `assignments[].owner` field repurposed to subagent names.
9. **Kept unchanged:** `server/src/engine/*`, `server/src/claude/stream-parser.ts`, `ToolUseBlock`, Browser pane (CDP), Simulator pane (idb), voice in/out, `TokenRing` + `server/src/metrics/token-logger.ts`, the OpenRouter provider, and the Tauri shell.

---

## A. Uniform subagent mechanism

### A.1 The verification that decides this

Every claim below was checked against the binaries installed on this machine or the vendor docs, on 2026-09-17.

| Engine | How an external MCP server is attached | Verified by |
|---|---|---|
| `claude` CLI (`server/src/engine/claude-cli-engine.ts`) | `--mcp-config <configs...>`: "Load MCP servers from JSON files **or strings** (space-separated)". Plus `--strict-mcp-config`: "Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations". | `claude --help` on this machine |
| `kimi` CLI (`server/src/engine/kimi-cli-engine.ts`) | `--mcp-config TEXT` ("MCP config JSON to load", repeatable) and `--mcp-config-file FILE` (repeatable). Persistent config lives at `~/.kimi/mcp.json` in the same `{"mcpServers": {...}}` shape Claude Code uses. `kimi mcp add` documents `--transport [stdio\|http]`, `--env KEY=VALUE`, `--header KEY:VALUE`. | `kimi --help`, `kimi mcp add --help` on this machine; https://moonshotai.github.io/kimi-cli/en/customization/mcp.html |
| ACP agents, incl. Code Puppy (`server/src/engine/acp-engine.ts`) | `session/new` carries an `mcpServers` **array** of `{name, command, args, env: [{name, value}]}` (stdio) or `{name, url, headers}` (http, only when the agent advertises `mcpCapabilities.http`). **Medusa already sends the field, empty**, at `acp-engine.ts:645` and `acp-engine.ts:664`. | source read + https://agentclientprotocol.com/protocol/session-setup |
| OpenRouter models | Run through the `claude` CLI harness (`getAnthropicCompatibleEnv`), so they inherit the `claude` row above with no extra work. | `claude-cli-engine.ts:178-186` |

This is the crux: **MCP is the only subagent-spawning surface all four rows share.** Nothing else does.

Tool naming: the `claude` CLI exposes external MCP tools to the model as `mcp__<server>__<tool>`, so the orchestrator prompt refers to `mcp__medusa__spawn_agent`. Kimi and ACP agents may expose the bare name `spawn_agent`; the prompt in C names both spellings so it is engine-portable.

### A.2 Recommendation

**Ship an MCP server named `medusa`, transported over stdio via a shim binary that the engine spawns, backed by a `SubagentManager` living inside the Medusa server process.**

Why a shim rather than mounting MCP straight onto Express: the agent CLI is a *separate OS process*, so an in-process MCP object is not reachable. stdio is the one transport all three engine families accept identically, it needs no new listening port, and auth is just env vars handed to the child at spawn. An HTTP variant is specified in A.7 as a secondary for the multi-machine runner case, but stdio is the default.

```
Medusa server (node)
 ├── SubagentManager ──────────────► Engine.spawn()  (claude | kimi | code-puppy | openrouter-via-claude)
 │        ▲  (HTTP, 127.0.0.1, AUTH_TOKEN)
 │        │
 └── parent Engine.spawn(claude/kimi/acp)
          └── child proc: node dist/mcp/medusa-mcp-shim.js   ← the "medusa" MCP server
```

### A.3 New files

| Path | Contents |
|---|---|
| `server/src/subagents/manager.ts` | `class SubagentManager`: the lifecycle owner. |
| `server/src/subagents/types.ts` | `SubagentRecord`, `SubagentStatus`, `SpawnAgentInput`. |
| `server/src/mcp/medusa-mcp-shim.ts` | Standalone entrypoint. Speaks MCP over stdio to the parent CLI; speaks HTTP to `MEDUSA_URL`. Compiled to `dist/mcp/medusa-mcp-shim.js` and included in the Tauri sidecar bundle. |
| `server/src/mcp/config.ts` | `buildMcpConfigJson(opts)` → the JSON blob injected into each engine. |
| `server/src/routes/subagents.ts` | The HTTP API the shim calls. |
| `server/src/subagents/__tests__/manager.test.ts` | Unit tests. |
| `client/src/components/Chat/SubagentCard.tsx` | The collapsible card. |
| `client/src/stores/subagentStore.ts` | Zustand store keyed by `agentId`. |

New dependency: `@modelcontextprotocol/sdk` in `server/package.json` (the shim's MCP server side). This is the only new runtime dependency; keep it out of the main server bundle path so the core stays dependency-light.

### A.4 The tool surface

```jsonc
// spawn_agent
{
  "name": "spawn_agent",
  "description": "Start a subagent that works in parallel on a focused task and returns its result.",
  "inputSchema": {
    "type": "object",
    "required": ["task"],
    "properties": {
      "task": { "type": "string", "description": "Self-contained instructions. The subagent sees none of this conversation." },
      "name": { "type": "string", "description": "Short label shown on the card, e.g. \"Audit socket events\"." },
      "engine": { "type": "string", "enum": ["claude", "kimi", "code-puppy"], "description": "Defaults to the parent chat's engine." },
      "model": { "type": "string", "description": "Engine-specific model id. Defaults to the parent chat's model." },
      "cwd": { "type": "string", "description": "Must be inside the parent session's workingDir. Defaults to it." },
      "wait": { "type": "boolean", "default": true, "description": "true: block and return the final result. false: return immediately with an agent_id." }
    }
  }
}
```

`agent_status(agent_id)` → `{ agentId, name, status, engine, model, startedAt, endedAt?, toolCallCount, tokens }`
`agent_result(agent_id)` → `{ agentId, status, text, truncated, transcriptPath, usage }`
`list_agents()` → `{ agents: [ ...agent_status shapes... ] }` for the current parent session only
`cancel_agent(agent_id)` → `{ agentId, status: "cancelled" }`

`SubagentRecord`:

```ts
interface SubagentRecord {
  id: string;                  // "sa_" + 12 hex
  parentSessionId: string;
  parentToolUseId: string | null;
  name: string;
  task: string;
  engineId: string;
  model: string | null;
  cwd: string;
  yolo: boolean;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  startedAt: string;
  endedAt: string | null;
  resultText: string;
  transcriptPath: string;      // ~/.claude-chat/subagents/<parentSessionId>/<id>.jsonl
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  toolCallCount: number;
}
```

The shim is told which parent it belongs to by `MEDUSA_PARENT_SESSION_ID`, so `spawn_agent` needs no session argument and one chat can never see or cancel another chat's subagents.

### A.5 Wiring MCP into each engine

One helper, three call sites:

```ts
// server/src/mcp/config.ts
export function buildMcpConfigJson(opts: {
  parentSessionId: string;
  serverUrl: string;   // http://127.0.0.1:<config.port>
  authToken: string;
}): string   // returns the stringified { mcpServers: { medusa: { ... } } }
```

The stdio entry it produces:

```json
{
  "mcpServers": {
    "medusa": {
      "type": "stdio",
      "command": "node",
      "args": ["<abs path>/dist/mcp/medusa-mcp-shim.js"],
      "env": {
        "MEDUSA_URL": "http://127.0.0.1:3456",
        "MEDUSA_TOKEN": "<AUTH_TOKEN>",
        "MEDUSA_PARENT_SESSION_ID": "<session id>"
      }
    }
  }
}
```

- `claude-cli-engine.ts`, after the existing `--model` push at line 174:
  `args.push("--mcp-config", buildMcpConfigJson({...}))`. Do **not** add `--strict-mcp-config`: the user's own `.mcp.json` servers should stay available to Medusa.
- `kimi-cli-engine.ts`, after the `--yolo` push at line 98:
  `args.push("--mcp-config", buildMcpConfigJson({...}))`.
- `acp-engine.ts`: replace the two literal `mcpServers: []` (lines 645, 664) with the ACP-shaped array
  `[{ name: "medusa", command: "node", args: [shimPath], env: [{ name, value }, ...] }]`.
  ACP uses an array of named entries with `env` as name/value pairs, not the object map the CLIs take, so `buildMcpConfigJson` gets a sibling `buildAcpMcpServers()` returning the array form. Both read one shared `MedusaMcpDescriptor` so the two spellings cannot drift.

`EngineSpawnOptions` gains one optional field, `mcpConfig?: MedusaMcpDescriptor`, so engines never reach into config themselves and the tests can pass a fixture.

### A.6 Attaching a subagent's stream to the parent chat

New socket events, emitted to the **parent session's room** (`io.to(parentSessionId)`), matching the existing `message:stream:*` naming:

| Event | Payload |
|---|---|
| `subagent:start` | `{ sessionId, agentId, parentToolUseId, name, task, engineId, model, cwd, startedAt }` |
| `subagent:event` | `{ sessionId, agentId, event }` where `event` is the same `ParsedEvent` the parent's own stream uses |
| `subagent:end` | `{ sessionId, agentId, status, resultText, usage, durationMs, endedAt }` |
| `subagent:cancel` | client → server: `{ sessionId, agentId }` |

Rendering: `SubagentCard` is keyed by `agentId`. `MessageBubble` already receives `ToolUse` blocks with `id`; when a tool block's name is `spawn_agent` or `mcp__medusa__spawn_agent`, render `SubagentCard` in its place instead of `ToolUseBlock`. The card is **collapsed by default**, header showing `▸ <name> · <engine>/<model> · <n> tools · <status spinner or ✓>`; expanding reveals the subagent's own text and its `ToolUseBlock`s, reusing the existing component unchanged. This is exactly the Claude Code Agent-tool card shape.

The 2026-09-17 16:40 work already threads `parentToolUseId` through `stream-parser.ts`, the socket handler, `ToolUse`, and `ToolUseBlock`'s "subagent" badge. That badge path serves the engine-native `Task` tool; `SubagentCard` serves the Medusa-managed one. Both coexist.

### A.7 Results back into the parent's context

`wait: true` (the default) is the important case and is how Claude Code's own Agent tool behaves: the MCP tool call does not return until the subagent finishes, so the final text arrives as the tool_result in the parent's own transcript. No extra prompting, no context surgery, and the parent's engine handles it natively.

Caps: `resultText` is truncated to 24,000 characters with `truncated: true` and a `transcriptPath` the parent can `Read` if it needs more. Subagent tool traffic never enters the parent's context; only the final text does.

`wait: false` is for fan-out: the orchestrator spawns three, keeps talking, then calls `agent_result` on each. A `wait: false` spawn that is never collected is still surfaced in the UI and still logged.

Secondary HTTP transport (runner case only): mount the same MCP server at `POST /mcp` on the existing Express app behind `authMiddleware`, and emit an `{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer ..."}}` entry instead. Both `claude` and `kimi` accept the http shape. Defer until a runner actually needs it.

### A.8 Concurrency, cancellation, cost, permissions

**Concurrency.** `SubagentManager` holds two limits, from `config`: `MEDUSA_MAX_SUBAGENTS_TOTAL` (default 6) and `MEDUSA_MAX_SUBAGENTS_PER_SESSION` (default 3). Over the limit, the record enters `queued` and the `spawn_agent` call blocks in the queue (with `wait:true`) or returns `{agentId, status:"queued"}` (with `wait:false`). A FIFO queue per parent. `subagent:start` fires on actual start, so a queued card shows as "queued".

**Cancellation.** Three entry points, all landing on `SubagentManager.cancel(agentId)` which calls the owning engine's `abort(state, id)` (the shared SIGTERM-then-SIGKILL in `engine/types.ts`):
1. the `cancel_agent` tool,
2. a Stop button on the card → `subagent:cancel`,
3. the parent aborting: extend the existing `socket.on("message:abort")` handler (`socket/handler.ts:1192`) with `subagentManager.cancelForParent(sessionId)`. A subagent must never outlive its parent turn.
Graceful shutdown (`server/src/index.ts`) also calls `cancelAll()`, mirroring how `stopScreencast()` is wired today.

**Cost attribution.** On `subagent:end`, `SubagentManager` writes one `TokenUsageEntry` through the existing `tokenLogger`, with `sessionId = parentSessionId` so the ring is automatically right, plus three new optional fields: `agentId`, `role: "subagent"`, and the subagent's own `provider`/`model` (those two already exist on the entry as of 2026-09-17 00:00). `UsageSummary` gains `bySubagent` alongside the existing `byBot`/`bySource`/`byModel`: and `byBot` is renamed `bySession` in the same pass since bots are gone. The `TokenRing` popover gains a "subagents" line; no ring math changes.

**Permissions / yolo.** A subagent inherits `yoloMode` from its parent `SessionMeta` and **cannot escalate**: `spawn_agent` has no yolo parameter, by design. Non-yolo subagents get the same treatment the parent gets today: `claude` without `--dangerously-skip-permissions`, `kimi` without `--yolo`, and ACP's `session/request_permission` auto-rejecting with an explanatory tool_result (`acp-engine.ts`). `cwd` is validated to be inside the parent's `workingDir` (reuse the path-escape guard already in `acp-engine.ts` around line 479) and the call is rejected otherwise.

### A.9 Alternatives considered

**Engine-native Agent tool only.** The `claude` CLI has `Agent` (listed as `Task` in `system:init`), plus `--agents <json>` for inline custom definitions, verified in `claude --help`. But three things kill it as *the* mechanism:

1. Kimi and ACP agents have no equivalent the Medusa server can rely on, so requirement 3 ("the same way on every engine") fails immediately.
2. **Its stream is opaque by default.** Per https://code.claude.com/docs/en/agent-sdk/streaming-output, `StreamEvent.parent_tool_use_id` is *always null*: stream events are emitted for the main session only and token-level deltas from subagents are not forwarded. Attribution requires whole `AssistantMessage` objects, and live subagent text needs the opt-in `--forward-subagent-text` (or `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1`). So the live, streaming card the owner asked for is not something the native tool gives us for free.
3. The Medusa server would own nothing: no concurrency limit it can enforce, no cancel, no cost attribution, and no way to give a subagent a *different engine* from its parent, which is exactly the owner's "any engine/model can be the subagent's brain".

**Rejected as the sole mechanism, kept as a coexisting extra** when the parent is `claude`. If we ever want its cards to stream, add `--forward-subagent-text` to the claude argv; `ToolUseBlock`'s existing `parentToolUseId` badge already handles the attribution.

**Prompt-level marker protocol (`[BOT-TASK: ...]`).** This is the thing being removed. It is unparseable mid-stream without a stateful buffer (the `HubPostDetector` machinery), carries no typed arguments, has no result handshake, gets copied verbatim into prose by weaker models, and is invisible to the model's own tool loop so the model cannot reason about the return value. **Rejected.**

**MCP, chosen.** It is the one mechanism all four engine rows already accept, it is typed, the result handshake is the tool_result the model already understands, and it puts lifecycle in the Medusa server where the owner asked for it. Cost: one new npm dependency and a shim process per parent turn.

---

## B. Session model

### B.1 Schema

`server/src/sessions/store.ts`: `SessionMetaSchema` after the change:

```ts
const SessionMetaSchema = z.object({
  id: z.string(),
  name: z.string(),                     // chat title, renameable (already)
  workingDir: z.string(),               // the chat's project folder (already; now surfaced in the UI)
  createdAt: z.string(),
  lastActiveAt: z.string(),
  yoloMode: z.boolean().optional(),
  systemPrompt: z.string().optional(),  // per-chat extra instructions, appended to the orchestrator prompt
  skills: z.array(z.string()).optional(),
  model: z.string().optional(),
  // NEW
  engineId: z.string().optional(),      // "claude" | "kimi" | "code-puppy"; getEngineOrDefault falls back to claude
  providerId: z.string().optional(),    // "claude" | "kimi" | "openrouter": the settings/providers.ts id
  archived: z.boolean().optional(),
});
```

**Removed:** `compactSystemPrompt` (its only consumer is `compact-prompts.ts`, deleted in C). Zod ignores unknown keys by default here, so old files carrying it still parse; the field is simply dropped on the next write.

`providerId` and `engineId` are separate on purpose: OpenRouter is a *provider* that runs on the `claude` *engine*. `getEngineOrDefault(session.engineId)` picks the harness; `providerId` picks the env (`getAnthropicCompatibleEnv`). Today both are global in `settings.json`; this makes them per-session, with the global value as the default for new chats.

### B.2 New chat flow

`POST /api/sessions` body becomes `{ name?, workingDir, engineId?, providerId?, model?, systemPrompt? }`. `workingDir` becomes **required** (today it defaults to `~/Documents`); `name` defaults to the folder's basename, deduped ("Medusa", "Medusa 2").

Client `NewChatButton` (rename of `client/src/components/Sidebar/NewSessionButton.tsx`) opens a small inline panel: folder, provider, model. Folder picking:

- **Tauri shell (preferred):** add `tauri-plugin-dialog` to `desktop/src-tauri/Cargo.toml`, `.plugin(tauri_plugin_dialog::init())` in `main.rs`, and `"dialog:allow-open"` to `desktop/src-tauri/capabilities/default.json`. The client calls `window.__TAURI__.dialog.open({ directory: true })`. Mirror the detection pattern already used in `client/src/components/Input/captureScreen.ts` (try Tauri `invoke`, fall back).
- **Browser fallback:** a text input prefilled from `localStorage["medusa.lastProjectDir"]`, validated by a new `GET /api/files/stat?path=` on the existing `server/src/routes/files.ts` returning `{ exists, isDirectory }`. No picker, because browsers cannot return a real filesystem path.
- **Remembering:** the last folder used is stored in `localStorage` and preselected; a chat's folder is editable later via the header folder chip (E.3), which emits the existing `session:working-dir` socket event (handler at `socket/handler.ts:1144`, already implemented and currently unused by the UI).

### B.3 Migration

`SessionStore.load()` gains a one-shot `migrateFromBots()` that runs when `~/.claude-chat/sessions.json` exists and no `~/.claude-chat/.migrated-single-agent` marker is present:

1. Copy the current file to `~/.claude-chat/sessions.bots.backup.json`. Nothing is destroyed.
2. Find the session whose `name` matches `/^medusa$/i`. **Keep it, with the same `id`** so `~/.claude-chat/chats/<id>.json` and `<id>.summary.txt` stay attached, so `--resume <id>` still resolves in the `claude` CLI, and so the token-usage log's history stays joined.
3. Strip its `systemPrompt` if that prompt contains any of `[HUB-POST`, `[TASK-DONE`, `[BOT-TASK` (the migration must not leave marker instructions behind); `undefined` means "use the orchestrator prompt".
4. Drop every other session from `sessions.json`. Leave their chat files on disk; a follow-up cleanup command can remove them once the user is happy.
5. If no Medusa session exists, create one chat at `~/Documents` named after that folder.
6. Write the marker file.

Also delete `SessionStore.loadDefaults()` and the `default-bots.json` seeding branch entirely (`store.ts:50-58`, `:68-92`). A fresh install now starts with **zero** chats and the empty-state "New chat" call to action.

---

## C. System prompt

Delete `server/src/sessions/compact-prompts.ts` (both exports, `getCompactPrompt` and `generateCompactPrompt`, and the whole `ROLE_PATTERNS` / `BotRole` apparatus). Replace with:

```ts
// server/src/sessions/orchestrator-prompt.ts
export function buildOrchestratorPrompt(
  session: SessionMeta,
  opts: { engineId: string; spawnToolName: string }
): string;
```

`spawnToolName` is `"mcp__medusa__spawn_agent"` for the `claude` engine and `"spawn_agent"` otherwise, so the prompt names the tool the way that engine will actually present it. The session's own `systemPrompt`, when set, is appended under a `## Project notes` heading rather than replacing the base.

Draft content:

> You are Medusa, a hands-on coding assistant working with one person in one project folder.
>
> Write code, fix bugs, ship features, review code. Use your Read, Edit, and shell tools to make real changes rather than describing them. You are not a project manager and you do not produce status dashboards.
>
> ## Working with subagents
> You can run work in parallel by calling `{spawnToolName}`. A subagent is a fresh agent with its own context: it sees your `task` string and nothing else, so write self-contained instructions with file paths and enough background to act. It returns its final text to you as the tool result.
>
> - `task` (required): what to do, and what to report back.
> - `name`: a short label the user sees on the card.
> - `engine` / `model`: optional. Leave them out to inherit this chat's settings; set them to put a cheaper or a stronger model on a task.
> - `cwd`: optional, must be inside this chat's folder.
> - `wait`: leave it true to get the result inline. Set false only when you are launching several at once, then collect each with `agent_result`.
>
> Delegate when the work is independent and read-heavy: surveying a large codebase, running a test matrix, drafting one file while you draft another. Do the work yourself when it is small, when it needs this conversation's context, or when the edits would collide. At most three subagents run at once; check `list_agents` if you are unsure what is in flight.
>
> ## Style
> Be concise. Do not use the em-dash character. Never invent markers or bracketed protocol strings in your replies; every capability you have is a real tool.

Call sites to update: `socket/handler.ts` (the compact-prompt branch in the send path), `routes/sessions.ts:129` (drops `compactSystemPrompt` from the PATCH body), and `SessionEditor.tsx` (drops the compact-prompt field).

---

## D. Removal inventory

### D.0 The socket events that disappear

Verbatim strings, all of which must be gone from both sides:

`"hub:post"` (inbound, `handler.ts:1164-1165`) · `"hub:message"` · `"task:done"` · `"tasks:acknowledged"` · `"bot:task-assigned"` · `"bot:task-cleared"` · `"approval:new"` · `"approval:resolved"` · `"dev-control:update"` · `"dev-control:removed"` · `"session:pending-task"` · `"session:status"` (emitted only from `autonomous-deliver.ts`, i.e. only on the bot path: but the client handler in `useSocket.ts` can stay harmlessly, or go with it).

Everything else in `handler.ts` survives untouched: `session:join`, `session:leave`, `message:user`, `message:stream:{start,delta,tool,tool_result,end}`, `message:error`, `message:queued`, `message:abort`, `cowork:{start,stop,input,frame,status}`, `simulator:{start,stop,input,frame,status}`, `session:{toggle-yolo,set-yolo,update-system-prompt,update-skills,update-working-dir}` and their `*-changed` echoes, `server:shutting-down`, `projects:updated`, `quick-tasks:updated`.

### D.1 Server: delete outright

| Path | Exports being removed |
|---|---|
| `server/src/hub/store.ts` | `HubMessage`, `CompletedTask`, `HubStore` (`getAll`, `getRecent`, `getRecentForSession`, `getRecentForSessionDelta`, `add`, `addCompletedTask`, `getUnacknowledged`, `acknowledgeAll`). Also stops creating the undocumented `~/.claude-chat/tasks.json` that `HubStore` derives from its own file path. |
| `server/src/hub/mention-utils.ts` | `hasMention`, `hasAllMention`, `hasDevsMention`, `hasYouMention`, `hasAnyMention`, `parseBotTaskTarget`. Kills the `@all` / `@devs` / `@you` tokens. |
| `server/src/hub/mention-router.ts` | `MAX_CHAIN_DEPTH`, `MentionRouter` (`processMessage`, `removeSession`, `queueDirectMessage`, `onSessionIdle`, `processBotTaskContent`, `queueBotTask`) |
| `server/src/hub/poll-scheduler.ts` | `HubPollScheduler` (`start`, `stop`, `removeSession`, `recordHeartbeat`, and the private `checkBotHeartbeats` / `checkStaleAssignments` / `nudgeBot` / `pollBot`) |
| `server/src/hub/post-processor.ts` | `extractQuickTask`, `extractApprovalRequest`, `HubPostProcessorOptions`, `processHubPosts` |
| `server/src/hub/approval-store.ts` | `ApprovalRequest`, `ApprovalStore`. See D.5. |
| `server/src/hub/__tests__/post-processor.test.ts` | the only test file that imports hub code |
| `server/src/dev-control/store.ts` | `DevControlEntry`, `DevControlSnapshot`, `DevControlStore`, and the module-level singleton `devControlStore` |
| `server/src/dev-control/controller.ts` | `DevControlStatePayload`, `DevControlController` |
| `server/src/routes/dev-control.ts` | `GET /`, `GET /:id`, `POST /:id/pause`, `POST /:id/resume`, `POST /:id/status` |
| `server/src/routes/hub.ts` | `GET /`, `POST /`, `GET /tasks`, `POST /tasks/ack` |
| `server/src/routes/approvals.ts` | `GET /`, `POST /:id/approve`, `POST /:id/deny` (see D.5) |
| `server/src/projects/task-sync.ts` | `TaskSyncManager` (`handleTaskDone`): consumes `[TASK-DONE]` |
| `server/default-bots.json` | the roster; schema is `[{ name, systemPrompt }]` and its single current entry embeds the whole marker protocol |
| `server/src/claude/autonomous-deliver.ts` | `AutonomousDeliverParams`, `autonomousDeliver`. Its only five callers (`index.ts:472`, `dev-control/controller.ts:138`, `poll-scheduler.ts:239,287,438`, `mention-router.ts:336,423`) all die in this change, so it goes with them. |

Directories `server/src/hub/` and `server/src/dev-control/` end up empty and are removed.

### D.2 Server: edit

| Path | Change |
|---|---|
| `server/src/index.ts` | Imports at 27-29, 34-35, 40-41, 43, 47-49. Constructions: `hubStore` (66), `approvalStore` (69), `mentionRouter` (140), `devControlController` (145-147), `pollScheduler` (150-153), `taskSyncManager` (342). Route mounts at 192, 195, 205, and the trimmed argument lists at 188 (`createHealthRouter`), 189 (`createSessionsRouter`), 142 (`setupSocketHandler`). **Restore the plain `io.emit`** by deleting the monkey-patch at 348-357 that exists only to feed `TaskSyncManager`. Remove the `botName` field from the interrupted-session schema (400-409), the AR2 auto-resume `autonomousDeliver` loop (456-489), the BOT-ANNOUNCE block (527-549), and the AR3 hub notifications (551-577). Construct `SubagentManager` and mount `/api/subagents` in their place. |
| `server/src/socket/handler.ts` | **Do this file and `post-processor.ts` together**: they import from each other (`post-processor.ts:6` imports `extractTaskDone` *from the socket handler*, and `autonomous-deliver.ts:16` imports `HubPostDetector` / `buildHubPromptSection` / `sanitizeImagePaths` from it), so neither can be cleaned alone. Delete the exported `HubPostDetector` (113-303), `extractTaskDone` (309), `buildHubPromptSection` (316-430) and the four prefix constants at 103-106 (`"[HUB-POST: "`, `"[BOT-TASK: "` and their lowercase twins). In `handleMessageSend`: the detector construction (558), `handleHubPosts` (576-577), `handleBotTasks` (579-584), the `feed()` calls (604, 615-616, 676, 685-686), the flushes (693-699, 895-899), the hub prompt section (773, 779), and `mentionRouter.onSessionIdle` (975). Drop `hubStore` / `mentionRouter` / `approvalStore` (443) from `setupSocketHandler`. Remove the `"hub:post"` handler (1164-1191) and the four `io.emit("hub:message")` calls (760, 874, 890, 1184). Add `subagent:cancel` beside `message:abort` (1192). **Keep** `sanitizeImagePaths` (16): it is a security guard, not hub code. |
| `server/src/sessions/store.ts` | Delete `loadDefaults()` (68-92) and its call in `load()` (50-58); delete `updateCompactSystemPrompt`; add `migrateFromBots()`; schema per B.1. Note there is **no `isBot` field today**: bot-ness is inferred from the `name` string in five places, which is exactly why the migration in B.3 must match on names. |
| `server/src/routes/sessions.ts` | Drop the `MentionRouter` (line 9) and `HubPollScheduler` (line 10) imports and params, and the `mentionRouter?.removeSession(id)` / `pollScheduler?.removeSession(id)` calls at 172-173. `POST` / `PATCH` bodies per B.2; drop `compactSystemPrompt` from the PATCH body (129). Drop `POST /bulk-prompt-append` (95): a multi-bot convenience. **Keep** `PUT /reorder` (82); chat ordering is still useful. |
| `server/src/config.ts` | Remove `hubFile`, `approvalsFile`, `devControlFile`, `hubPolling` (`HUB_POLLING`), `hubPollIntervalMs` (`HUB_POLL_INTERVAL_MS`), `staleTaskThresholdMs` (`STALE_TASK_THRESHOLD_MS`), and the `default-bots.json` comments at 17 and 49. Keep `quickTasksFile` (the Projects pane still uses it). Add `maxSubagentsTotal`, `maxSubagentsPerSession`, `subagentsDir`. |
| `server/src/routes/health.ts` | Drop the `HubPollScheduler` import (3), the constructor param, and the `pollScheduler.stop()` call inside `gracefulShutdown` (88-90). Add `subagentManager.cancelAll()` there instead. |
| `server/src/claude/model-router.ts` | **Keep**: no hub imports. Prune only the `source` union (`"poll" \| "mention" \| "nudge"` collapse to `"user"`) and the two hub-shaped entries in `HAIKU_PATTERNS`: `/\[Hub Check\]/i` and `/\[NO-ACTION\]/i`. Update `claude/__tests__/model-router.test.ts` accordingly: it exercises exactly those. |
| `server/src/projects/store.ts` | Drop the task-sync comment at 194; see E.5. |
| `server/src/metrics/token-logger.ts` | Rename `byBot` → `bySession` and the `botName` log field → `sessionName`; add `bySubagent`, `agentId`, `role`. |
| `server/src/utils/token-report.ts`, `server/src/routes/metrics.ts` | Follow the rename. |
| `desktop/src-tauri/sidecar-src/entry.mjs` | **Functional, not a comment**: line 60 `const KNOWN_ROOT_ESCAPES = new Set(["/.env", "/default-bots.json"])`. Drop the second entry. (Note: CHANGELOG 2026-09-17 17:05 says this file was deleted; verify which state the tree is in before editing.) Also `desktop/README.md:90,140`, `desktop/scripts/build-sidecar.sh:85`, `desktop/src-tauri/src/main.rs:39` mention `default-bots.json` in comments. |
| `server/src/engine/*` | Additive only (A.5). No behavior change to existing paths. |

### D.3 Client: delete outright

| Path | Lines | Note |
|---|---|---|
| `client/src/components/Hub/HubFeed.tsx` | 711 | also removes `parseSlashCommand` (`/pause`, `/resume`, `/status`) and the duplicate `getMentionQuery` |
| `client/src/components/Hub/HubMessage.tsx` | 128 | |
| `client/src/components/Hub/MentionAutocomplete.tsx` | 222 | includes an already-unused `handleMentionKeyDown` export |
| `client/src/components/Hub/ApprovalBanner.tsx` | 162 | see D.5; also removes its module-level `approval:new` / `approval:resolved` subscriptions |
| `client/src/stores/hubStore.ts` | 53 | `useHubStore` + `useUnreadHubCount` |
| `client/src/stores/taskStore.ts` | 48 | `useTaskStore` + `hasCompletedTask` |
| `client/src/types/hub.ts`, `client/src/types/task.ts`, `client/src/types/approval.ts` | | |
| `client/src/components/Chat/KanbanStrip.tsx` | | bot task strip |

**Dead code to sweep in the same pass** (verified zero importers, so this is free): `client/src/components/Hub/UsageDashboard.tsx` (347), `client/src/components/Hub/ComparisonChart.tsx` (324, the client's only **recharts** consumer: drop the dependency), `client/src/components/Sidebar/ProjectList.tsx` (109) and its orphan `client/src/components/Sidebar/ProjectDetailCard.tsx` (383, a name collision with the live `components/Project/ProjectDetailCard.tsx`), and `client/src/components/Chat/ChatPane.tsx` (166).

**Careful with `ChatPane`:** deleting it orphans `MessageList.tsx`, `JumpToStartButton.tsx`, `useAutoScroll.ts` and `ChatInput.tsx`. `ChatInput.tsx` is the only emitter of `'message:abort'`, and `MessageList.tsx` holds `isHubSystemMessage` / `stripHubDeliveryWrapper` (the `[Hub Request]` / `[Hub Check]` / `[NO-ACTION]` / `[Hub Message from X]` stripping). Before deleting, **move abort into `MedusaChat`'s send path**: a chat with no stop button is a regression, not a cleanup. Roughly 1,300 lines total.

The `client/src/components/Hub/` directory is then renamed to `client/src/components/Chat/`; `MedusaChat.tsx`, `ChatHeaderControls.tsx` and `LaunchScreen.tsx` move there. Do the move as its own commit so the content diff stays readable.

### D.4 Client: edit

| Path | Change |
|---|---|
| `client/src/App.tsx` | `activeView` loses `'hub'`; the final `else` branch (226) renders `MedusaChat`, not `HubFeed`. Remove the `fetchHubMessages()` and `fetchTasks()` calls from the mount effect (107-123). Default view becomes `'chat'`. |
| `client/src/stores/sessionStore.ts` | `activeView: 'chat' \| 'project' \| 'usage' \| 'arcade' \| 'cowork' \| 'simulator'` at lines 8, 32, 44, 167. Remove `pendingTasks` and `devControl` plus `setPendingTask` / `setDevControl` / `removeDevControl`. Fix the restore whitelist at line 47, which currently omits `'arcade'` so that view never survives a reload. Reconsider the comment at 117 ("Individual bot chat removed"): selecting a session must now switch to that chat. |
| `client/src/components/Sidebar/Sidebar.tsx` | Remove the **Hub** nav item (123-146) and its unread badge, **Stop All** (165-176) and its `Stop All Bots?` modal (292-333) plus `handleShutdown` (79-91), and `AgentBusyPrompt` (282, 340-353). Rename the **Medusa Chat** item or fold it away entirely, since chats are now the list. Add the New chat button at the top. See E.1. |
| `client/src/components/Sidebar/SessionList.tsx` | Delete `StatusIcon` (15-52) and all of `statusStyles` except `draftDot`: the spinning cog, pause icon, status-requested dot, `&#10003;` checkmark, pulsing dot and idle dot all go. Keep one streaming spinner. Delete the context menu's `Pause` / `Resume` / `Request status` items and their `api.pauseSession` / `api.resumeSession` / `api.requestSessionStatus` calls. Delete `isMedusaSession` (10) and make every row clickable, setting the active chat. Keep rename, search, delete, drag-reorder, and the draft dot. Empty-state copy "No bots yet" becomes "No chats yet". |
| `client/src/components/Sidebar/SessionEditor.tsx` | Title `Edit Bot` → `Chat settings`; `Bot Name` → `Chat name`; `Delete Bot` → `Delete chat`. Replace the hardcoded `MODEL_OPTIONS` (16-22) with `providerStore.modelsFor(...)`. Add engine and provider selects. The existing four socket emits (`session:update-system-prompt`, `session:update-working-dir`, `session:set-yolo`, `session:update-skills`) all stay. The "Changing the model requires a server restart" hint and the `window.confirm` restart prompt can go once per-session model takes effect on the next spawn. |
| `client/src/components/Sidebar/NewSessionButton.tsx` | Rename to `NewChatButton.tsx`. Collapse `FormMode` from `'none' \| 'menu' \| 'bot' \| 'project' \| 'task'` to the single new-chat form of B.2; the New Project and New Task entry points move into the Projects pane where they belong. |
| `client/src/components/Hub/MedusaChat.tsx` | Biggest single edit. Drop `medusaSession` (38) and the `selectedId` agent state (40-42); drive off `useSessionStore.activeSessionId`. Drop `<ApprovalBanner />` (261). Replace the empty-state copy at 424-429. Add the folder chip to the header. Add the abort button rescued from `ChatInput`. Bottom toolbar (346-369) is unchanged. |
| `client/src/components/Hub/ChatHeaderControls.tsx` | Delete the Agent `<select>` (88-96), the `onSelectAgent` prop, and `resolveActiveId` (34-42). Keep the Provider `<select>` (98-110); add an Engine `<select>` beside it. |
| `client/src/hooks/useSocket.ts` | Remove the handlers for `hub:message`, `task:done`, `tasks:acknowledged`, `session:pending-task`, `dev-control:update`, `dev-control:removed`, `bot:task-assigned`, `bot:task-cleared`. Add `subagent:start`, `subagent:event`, `subagent:end` → `subagentStore`. |
| `client/src/api.ts` | Remove `fetchHubMessages`, `fetchTasks`, `acknowledgeTasks`, `fetchApprovals`, `approveRequest`, `denyRequest`, `fetchDevControl`, `pauseSession`, `resumeSession`, `requestSessionStatus`, `fetchCompare` (+ its `ComparePeriod` / `CompareResult` types, orphaned with `ComparisonChart`), and the `DevControlState` type. Extend `createSession` for B.2. Add `fetchSubagents`. |
| `client/src/components/Chat/MessageBubble.tsx` | Route tool blocks named `spawn_agent` / `mcp__medusa__spawn_agent` to `SubagentCard` (the `toolUses.map` at 125). |
| `client/src/components/Chat/ToolUseBlock.tsx` | Unchanged. Its collapse/expand, 20-line output clipping, error style and `subagent` badge are all reused as-is. |
| `client/src/components/Arcade/ArcadeWidget.tsx` | Drops its "which bot is busy" hook. |

**Trap:** several socket subscriptions live at **module scope outside `useSocket`** and a pass that only edits `useSocket.ts` will miss them: `stores/projectStore.ts:29` (`projects:updated`), `stores/quickTaskStore.ts:22` (`quick-tasks:updated`), `components/Hub/ApprovalBanner.tsx:29-30`, `components/Cowork/CoworkPane.tsx:99-127`, `components/Cowork/SimulatorPane.tsx:141-169`. Only the ApprovalBanner ones are being removed; the rest stay but should be noted so nobody "cleans" them.

### D.5 The approvals decision

`ApprovalBanner` + `ApprovalStore` exist only because `[HUB-POST: @You APPROVAL NEEDED: ...]` was the escalation channel. That channel is gone. **Delete the whole approval path in this change**, and note it as a gap: real per-tool permission prompts (Claude Code's own approval UX, and ACP's `session/request_permission`, which `acp-engine.ts` currently auto-rejects) are the correct replacement and deserve their own spec. Do not half-keep the banner.

### D.6 Tests

**Delete:** `server/src/hub/__tests__/post-processor.test.ts` (12 cases; the only test file importing hub code).
**Rewrite:** `server/src/claude/__tests__/model-router.test.ts`: it exercises `source: "poll" | "nudge"` and the `[Hub Check]` / `[NO-ACTION]` patterns being pruned. `server/src/metrics/__tests__/token-logger.test.ts`: the `byBot` → `bySession` and `botName` → `sessionName` renames plus new `bySubagent` cases.
**Unchanged and must stay green:** all of `server/src/engine/__tests__/` (registry, claude argv, claude provider env, kimi, ACP, code-puppy), `server/src/claude/__tests__/stream-parser*.test.ts`, `server/src/compressor/__tests__/` (6 files), `server/src/socket/__tests__/error-policy.test.ts`, `server/src/settings/__tests__/providers.test.ts`, `server/src/routes/__tests__/providers.test.ts`. Note `compressor/__tests__/{security,dedup}.test.ts` and `engine/__tests__/code-puppy-engine.test.ts` match a `bot`/`hub` grep incidentally; they import nothing from those modules and must not be touched.

### D.6b Data files left behind

The migration does not delete user data. After the change these are orphaned in `~/.claude-chat/` and should be left in place, mentioned in the CHANGELOG so the user can remove them by hand: `hub.json`, `tasks.json` (derived inside `HubStore` from `hubFile`'s directory, so it never appears in `config.ts`), `dev-control.json`, `approvals.json`, and the per-bot `chats/<id>.json` / `<id>.summary.txt` files for dropped sessions.
**New:** `server/src/subagents/__tests__/manager.test.ts`, `server/src/mcp/__tests__/config.test.ts`, `server/src/sessions/__tests__/migration.test.ts`, `server/src/sessions/__tests__/orchestrator-prompt.test.ts`.

Baseline is 253 server tests (CHANGELOG 2026-09-17 17:50). Expect roughly -10 from deletions, +25 from new suites.

### D.7 Docs that must change

| File | What |
|---|---|
| `CLAUDE.md` | Delete the "Hub Post Formats" section entirely, delete the `[BOT-TASK: @BotName ...]` line under Sub-Agents, and replace the Sub-Agents section with the `spawn_agent` description. The Projects-pane section survives (E.5). |
| `PROJECT_OVERVIEW.md` | Delete the entire "Hub (Shared Awareness Feed)" section (lines 65-86) and the hub mention in "How It Works". Retitle from "Claude Chat - Multi-Session Chat Web UI" to describe one agent with subagents. Add the subagent architecture and the engine registry. |
| `README.md` | Line 14 ("Medusa lets you run multiple Claude Code bots simultaneously… communicate through a central Hub using @mentions") is now false and is the first paragraph a visitor reads. Rewrite. Line 8 mentions "the Hub and Medusa Chat". `docs/medusa_architecture.png` shows the hub topology and must be regenerated. |
| `Features.md` | Items framed around multi-bot orchestration need restating around subagents; the "Hub" rows in the roadmap go. |
| `HUB_BOT_COORDINATION.md`, `BOT_SYSTEM_GUIDE.md`, `BOT_STATUS_SYMBOLS_IMPLEMENTATION_GUIDE.md`, `MEDUSA_PROJECT_MANAGEMENT_GUIDE.md`, `docs/DEV_CONTROLS.md`, `docs/stop_all_button_spec.md`, `docs/send_to_busy_bots_spec.md`, `docs/bot_to_bot_api_spec.md`, `docs/2026-02-1*_hub_*.md`, `docs/2026-02-15_bot_accountability_plan.md` | Move to `docs/archive/` with a one-line header saying they describe the removed multi-bot system. Do not delete: they are the project's history. |
| `CHANGELOG.md` | One entry per workstream, per the house format. |

---

## E. UI spec

### E.1 Left pane (`client/src/components/Sidebar/Sidebar.tsx`)

Top to bottom:

1. **`+ New chat`**: full-width button, the first thing in the pane. Opens the B.2 panel.
2. **Search field**: already exists, filters chat titles. Keep.
3. **Chat list** (`SessionList.tsx`): one row per session, newest `lastActiveAt` first:
   - line 1: chat title (bold when active),
   - line 2: `<folder basename> · <relative time>`, muted,
   - a spinner dot on the right while that chat is streaming (this is the *only* status indicator; the old bot status symbols go),
   - hover reveals a `…` menu: Rename, Change folder, Duplicate, Delete. Rename/search/delete already work; wire Change folder to `session:working-dir`.
4. **Nav items** below a divider: Browser, Simulator, Projects, Usage, Arcade. The **Hub item is removed**. These are panes, not chats, and should read visually as a secondary group.
5. **Footer**: settings gear (unchanged).

Today the order is: header, then nav (Hub, Medusa Chat, Stop All, Usage, Arcade, Browser, Simulator, Projects), then `AgentBusyPrompt`, then `SessionList`, then `NewSessionButton`. The chat list is currently *below* eight nav buttons, which is backwards for a chat app: after this change the list is the pane's primary content and the remaining panes are a short secondary group beneath it.

**Removed from the sidebar:** the Hub nav item and its unread badge, the **Medusa Chat** nav item (clicking a chat row is now how you get to a chat), the Stop All button and its `Stop All Bots?` modal, `AgentBusyPrompt`, and every per-bot status symbol. The draft dot stays.

### E.2 What the chat header keeps (`MedusaChat.tsx` + `ChatHeaderControls.tsx`)

| Control | Where now | Where after |
|---|---|---|
| Agent selector | header (`ChatHeaderControls`) | **removed** |
| Provider picker | header | header, kept |
| Engine picker | does not exist | header, new, beside provider |
| Folder chip | does not exist | header, new: `📁 Medusa` with the full path as its `title`, click to change |
| Speaker (TTS) toggle | header, right | unchanged |
| Chat title | header | shows the session name, inline-editable |
| Model picker | bottom bar right | unchanged |
| Mic | bottom bar left | unchanged |
| TokenRing | bottom bar right | unchanged |
| ApprovalBanner | under the header | removed (D.5) |

The bottom toolbar built on 2026-08-06 is exactly right and should not be touched beyond deleting the "applies after a server restart" title on the model select once per-session model takes effect on the next spawn.

### E.3 Empty states

- **No chats at all** (fresh install, since `default-bots.json` seeding is gone): centered Medusa mark, "No chats yet", and a primary `New chat` button.
- **Empty chat**: keep the existing centered mark and title, replace the subtitle/description: current copy is "AI-Powered Development Hub" / "Your PM bot. Ask Medusa to create tasks, check project status, plan sprints…" (`MedusaChat.tsx:424-429`). New copy names the folder: "Working in `~/Documents/GIT/Medusa`. Ask for a feature, a fix, or a review."

### E.4 The subagent card

Collapsed: `▸ ⚙ Audit socket events · kimi/k2 · 7 tools · running` with a Stop affordance on hover. Done: `▸ ✓ Audit socket events · claude/sonnet · 12 tools · 41s`. Error: the `--danger` style `ToolUseBlock` already uses. Expanded: the subagent's streamed text plus its `ToolUseBlock`s, indented one level, with the final result text at the bottom in the same style as a tool result. Multiple concurrent cards stack in spawn order.

### E.5 The Projects pane: keep, rescoped

**Recommendation: keep it, as a per-session artifact.** Justification: the pane's value was never the bot roster, it was that Medusa can write structured plans to `~/.claude-chat/projects.json` and the user sees them live via the file watcher, with no chat scrollback to dig through. That is strictly more useful in a single-agent world, where the alternative is a plan that scrolls away. Concretely: add `sessionId` to the project schema, filter the pane to the active chat's projects, and repurpose `assignments[].owner` from a bot name to a subagent name so a fan-out renders as a checklist. `QuickTaskSection` stays (it is human-authored). What goes is `task-sync.ts`, which existed only to flip an assignment to `done` when a bot emitted `[TASK-DONE]`; the orchestrator now edits the file directly, as `CLAUDE.md` already instructs.

---

## F. Work breakdown

One git worktree per workstream (`EnterWorktree`), disjoint file ownership, merge behind green tests.

### Batch 1: independent, run together

| ID | Workstream | Model | Owns | Done when |
|---|---|---|---|---|
| **S1** | **Subagent MCP server.** `server/src/subagents/*`, `server/src/mcp/*`, `server/src/routes/subagents.ts`, the additive `EngineSpawnOptions.mcpConfig` field, and the three engine injection points (A.5). New `@modelcontextprotocol/sdk` dependency. | **Opus** | `server/src/subagents/`, `server/src/mcp/`, `server/src/routes/subagents.ts`, `server/src/engine/*` | `spawn_agent` returns a real result through all three engines; concurrency, cancel, and cost paths unit-tested |
| **S2** | **Session model + migration.** B.1 schema, `migrateFromBots()`, `loadDefaults()` deletion, `POST/PATCH /api/sessions` shapes, per-session engine/provider resolution in the spawn path. | **Opus** | `server/src/sessions/`, `server/src/routes/sessions.ts`, `server/src/config.ts` | a real `sessions.json` with Dev1/Dev2/Dev3/Fable/Medusa migrates to one chat, backup written, chat history intact |
| **S3** | **Server removals.** D.1 and the D.2 rows S1/S2 do not own, principally `index.ts` and `socket/handler.ts`. | **Sonnet** | `server/src/hub/`, `server/src/dev-control/`, `server/src/projects/task-sync.ts`, `server/src/index.ts`, `server/src/socket/handler.ts`, `server/src/routes/{hub,approvals,dev-control,health}.ts` | server boots, `tsc --noEmit` clean, remaining tests green, no `hub` string left under `server/src` |
| **S4** | **Docs.** D.7: rewrite `README.md` lead, `PROJECT_OVERVIEW.md`, `CLAUDE.md`, `Features.md`; archive the bot-era docs; regenerate the architecture diagram. | **Sonnet** | `README.md`, `PROJECT_OVERVIEW.md`, `CLAUDE.md`, `Features.md`, `docs/archive/`, `docs/medusa_architecture.*` | no doc describes the Hub as current behavior |

S1 and S3 both touch `socket/handler.ts`: S1 adds `subagent:cancel`, S3 removes the hub branches. Give **S3** sole ownership of the file and have S1 hand over a patch note; sequence S3's merge first if they finish together. S3 is the riskiest stream despite being the "just delete things" one, because `socket/handler.ts`, `hub/post-processor.ts` and `claude/autonomous-deliver.ts` import from each other in a cycle and must be untangled in a single commit.

### Batch 2: after Batch 1

| ID | Workstream | Model | Depends on | Owns |
|---|---|---|---|---|
| **S5** | **Left pane + chat header.** E.1 to E.3: New chat button, chat list, folder chip, engine picker, agent-selector removal, empty-state copy, `activeView` union, the `Hub/` → `Chat/` directory move. | **Sonnet** | S2, S3 | `client/src/components/Sidebar/`, `client/src/components/Hub/` (→ `Chat/`), `client/src/App.tsx`, `client/src/stores/sessionStore.ts` |
| **S6** | **Subagent card.** `SubagentCard.tsx`, `subagentStore.ts`, the `useSocket` subscriptions, `MessageBubble` routing. | **Sonnet** | S1 | `client/src/components/Chat/SubagentCard.tsx`, `client/src/stores/subagentStore.ts`, `client/src/hooks/useSocket.ts`, `client/src/components/Chat/MessageBubble.tsx` |
| **S7** | **Client removals.** D.3 plus the D.4 rows S5/S6 do not own: `api.ts`, `ArcadeWidget`, `taskStore`, `KanbanStrip`, hub types. | **Sonnet** | S3 | `client/src/api.ts`, `client/src/stores/{hubStore,taskStore}.ts`, `client/src/types/{hub,task,approval}.ts`, `client/src/components/Chat/KanbanStrip.tsx` |
| **S8** | **Orchestrator prompt.** C: new module, delete `compact-prompts.ts`, update call sites, prompt-shape tests. | **Opus** | S2 | `server/src/sessions/orchestrator-prompt.ts` |
| **S9** | **Tauri folder picker.** B.2: `tauri-plugin-dialog`, capability, client detection path. | **Sonnet** | S5 | `desktop/src-tauri/`, `client/src/components/Sidebar/NewChatButton.tsx` |
| **S10** | **Usage attribution.** A.8: `byBot` → `bySession`, `bySubagent`, ring popover line. | **Sonnet** | S1 | `server/src/metrics/`, `server/src/routes/metrics.ts`, `server/src/utils/token-report.ts`, `client/src/components/Usage/` |

S5 and S6 and S7 all touch `client/src/components/Chat/`. Sequence: S5 lands the directory move first, then S6 and S7 rebase onto it.

### Batch 3

- **S11** Projects pane rescope (E.5): Sonnet, depends on S5.
- **S12** Cross-engine subagent matrix: the same three-task prompt set run with each of `claude`, `kimi`, `code-puppy` as the subagent brain, under each parent engine; a 3x3 table of spawn success, result fidelity, cancel behavior, and token cost. Opus, depends on S1. This doubles as an eval artifact.

### F.1 Test plan

**Unit (vitest, `cd server && npx vitest run`)**

- `mcp/config.test.ts`: `buildMcpConfigJson` produces the exact stdio shape; `buildAcpMcpServers` produces the array form with matching command and env; both derive from one descriptor.
- `engine/*`: extend the existing argv tests: `claude` argv contains `--mcp-config` followed by parseable JSON naming `medusa`, and does **not** contain `--strict-mcp-config`; `kimi` argv likewise; the ACP `session/new` params carry a non-empty `mcpServers`. `child_process.spawn` stays mocked; no real processes.
- `subagents/manager.test.ts`: per-session and global concurrency caps queue rather than spawn; `cancelForParent` aborts every running child; a crashed child produces `status: "error"` and still emits `subagent:end`; `cwd` outside the parent `workingDir` is rejected; `resultText` over 24k is truncated with the flag set.
- `sessions/migration.test.ts`: a fixture `sessions.json` with five bot sessions migrates to one, the Medusa id is preserved byte for byte, the backup file matches the input, marker-bearing `systemPrompt`s are cleared, and a second `load()` is a no-op.
- `sessions/orchestrator-prompt.test.ts`: the prompt names `mcp__medusa__spawn_agent` for `claude` and `spawn_agent` otherwise; the session `systemPrompt` is appended not substituted; no `[HUB-POST`/`[TASK-DONE`/`[BOT-TASK` substring appears; no em-dash appears.
- `metrics/token-logger.test.ts`: `bySession` replaces `byBot`; a subagent entry aggregates into its parent session's total and into `bySubagent`.
- Client: `cd client && npx tsc -b --noEmit` clean.

**Manual QA against `http://localhost:3456`**

Run the server from a checkout with a real pre-migration `~/.claude-chat/sessions.json` (back it up first).

1. Boot. Sidebar shows exactly one chat, named for the old Medusa session, and its history loads. `~/.claude-chat/sessions.bots.backup.json` exists.
2. No Hub anywhere: no nav item, no feed, no Stop All, no status symbols. `curl -H "Authorization: Bearer $AUTH_TOKEN" localhost:3456/api/hub` returns 404.
3. `+ New chat` → pick a folder → the chat appears, header shows the folder chip, the title defaults to the basename.
4. Send "what files are in this folder?": a normal reply with a rendered tool card. Engine = claude.
5. Send "spawn two subagents: one to list the .ts files under server/src/engine, one to list them under client/src/stores. Report both counts." Expect: two collapsed cards appear, each expands to its own stream, both resolve, and the final reply cites both counts.
6. While they run, the sidebar spinner dot shows on that chat only. The TokenRing total rises, and its popover shows a subagents line.
7. Hit Stop mid-run on one card: that card goes to `cancelled`, the other finishes.
8. Abort the parent turn mid-run: every running card goes to `cancelled` within a few seconds, and `ps aux | grep -c claude` returns to its pre-turn count.
9. Switch the chat's engine to `kimi` in the header, repeat step 5. The cards render identically. Repeat with `code-puppy`.
10. Ask for a subagent on a *different* engine than the parent: "spawn a subagent using engine kimi to …" from a `claude` chat. The card header shows `kimi`.
11. Ask a subagent to work outside the folder ("spawn an agent with cwd /etc"): refused, with a visible tool error rather than a silent failure.
12. Restart the server mid-turn: no orphaned child processes remain.
13. Rename, search, and delete a chat. Delete removes it from the list and from `sessions.json`.
14. Browser pane, Simulator pane, mic, and speaker all still work: these were untouched and are the regression canary.

---

## References

- Engine layer: `server/src/engine/types.ts`, `registry.ts`, `claude-cli-engine.ts` (argv at 147-186), `kimi-cli-engine.ts` (argv at 85-99), `acp-engine.ts` (`session/new` at 636-671)
- Socket layer: `server/src/socket/handler.ts`
- Sessions: `server/src/sessions/store.ts`, `server/src/chat/store.ts` (`~/.claude-chat/chats/{sessionId}.json`)
- Prior plans: `docs/2026-09-15_cowork_parity_tauri_agnostic_plan.md`, `docs/cowork_parity_audit.md`, `docs/code_puppy_stream_format.md`
- MCP: https://code.claude.com/docs/en/mcp ; `claude --help`, `kimi --help`, `kimi mcp add --help`
- ACP: https://agentclientprotocol.com
