# Handover: what S3 must add to `socket/handler.ts` (and `index.ts`)

S1 owns `server/src/subagents/`, `server/src/mcp/`, `server/src/routes/subagents.ts`
and the additive engine changes. S3 owns `server/src/socket/handler.ts` and
`server/src/index.ts`, so S1 has deliberately not touched either. Everything S1
needs from those two files is written out below, ready to apply on merge.

Line references below were re-checked against `server/src/socket/handler.ts` and
`server/src/index.ts` at main `19cd4b4` (after S2 landed).

Nothing here is required for S1's own tests to pass. Until it is applied, the
subagent HTTP/MCP surface works but no subagent is ever spawned, because no
engine spawn is handed an `mcpConfig`.

---

## 1. `server/src/index.ts`

### 1a. Construct the manager

Next to the other store constructions (where `hubStore` / `approvalStore` used
to be):

```ts
import { SubagentManager } from "./subagents/manager.js";
import { createSubagentsRouter } from "./routes/subagents.js";
import { getActiveProvider } from "./settings/store.js";

const subagentManager = new SubagentManager({
  // One chat = one folder + one engine + one model (spec B.1). S2 landed
  // per-session `engineId` / `providerId` on SessionMeta (server/src/sessions/store.ts),
  // so read those first and fall back to the global provider, exactly as
  // ProcessManager.resolveEngine does (server/src/claude/process-manager.ts).
  getParent: (sessionId) => {
    const session = sessionStore.get(sessionId);
    if (!session) return null;
    return {
      workingDir: session.workingDir,
      engineId: session.engineId ?? session.providerId ?? getActiveProvider() ?? "claude",
      model: session.model ?? null,
      yoloMode: session.yoloMode ?? false,
    };
  },
  emit: (sessionId, event, payload) => io.to(sessionId).emit(event, payload),
});
```

`sessionStore.get(id)` is the real accessor on main (`server/src/index.ts:62`
constructs the store).

### 1b. Mount the route

Beside the other `app.use("/api/...")` lines (currently `index.ts:185-192`; it
replaces the `/api/hub`, `/api/approvals` and `/api/dev-control` mounts being
deleted):

```ts
app.use("/api/subagents", generalLimiter, createSubagentsRouter(subagentManager));
```

Note: `spawn_agent` with `wait: true` (the default) holds this request open for
the whole subagent run. If `generalLimiter` ever grows a request timeout, this
mount must be excluded from it.

### 1c. Graceful shutdown

In the shutdown path (`routes/health.ts`'s `gracefulShutdown`, where
`pollScheduler.stop()` is being removed, and/or `index.ts`'s own handler):

```ts
subagentManager.cancelAll();
```

### 1d. Pass the manager to the socket handler

```ts
// index.ts:142 today reads:
//   setupSocketHandler(io, processManager, sessionStore, skillCatalog, chatStore,
//     hubStore, mentionRouter, tokenLogger, quickTaskStore, approvalStore);
// once S3 has dropped hubStore / mentionRouter / approvalStore:
setupSocketHandler(io, processManager, sessionStore, skillCatalog, chatStore, tokenLogger, quickTaskStore, subagentManager);
```

Argument order is S3's call; the manager just has to arrive.

---

## 2. `server/src/socket/handler.ts`

### 2a. Signature

Add a parameter to `setupSocketHandler` (declared at `handler.ts:433`; S3 is
already deleting `hubStore`, `mentionRouter` and `approvalStore` from it):

```ts
import type { SubagentManager } from "../subagents/manager.js";

export function setupSocketHandler(
  io: IOServer,
  processManager: ProcessManager,
  store: SessionStore,
  skillCatalog: SkillCatalog,
  chatStore: ChatStore,
  tokenLogger?: TokenLogger,
  quickTaskStore?: import("../projects/quick-task-store.js").QuickTaskStore,
  subagentManager?: SubagentManager
): void {
```

### 2b. The `subagent:cancel` handler

Immediately after the existing `socket.on("message:abort", ...)` handler
(currently at `handler.ts:1192`):

```ts
// -- Stop one subagent from its card's Stop button --
socket.on(
  "subagent:cancel",
  ({ sessionId, agentId }: { sessionId: string; agentId: string }) => {
    if (!subagentManager || !sessionId || !agentId) return;
    // Scoped by parent session on purpose: a socket may only cancel a
    // subagent belonging to the chat it names, never another chat's.
    const record = subagentManager.getForParent(agentId, sessionId);
    if (!record) return;
    subagentManager.cancel(agentId);
  }
);
```

### 2c. Extend `message:abort`

A subagent must never outlive its parent turn (spec A.8). Inside the existing
`message:abort` handler, after `processManager.abort(sessionId)`:

```ts
subagentManager?.cancelForParent(sessionId);
```

### 2d. Attach the MCP server to the parent spawn

This is the line that actually turns subagents on. In `handleMessageSend`,
wherever the spawn options are assembled for `processManager.sendMessage(...)`,
the descriptor has to reach `EngineSpawnOptions.mcpConfig`:

```ts
import { descriptorForSession } from "../mcp/config.js";

// ... in the send path:
const mcpConfig = descriptorForSession(sessionId) ?? undefined;
```

`ProcessManager.sendMessage` currently takes positional arguments and does not
forward an `mcpConfig`. Two options, S3's choice:

- pass it through `sendMessage` as one more parameter, or
- (preferred) give `ProcessManager.sendMessage` an options-object overload and
  forward `mcpConfig` into `engine.spawn({ ..., mcpConfig })`.

`descriptorForSession` returns `null` when no `AUTH_TOKEN` is configured, which
correctly disables the MCP server rather than exposing an unauthenticated one.

Note `SubagentManager` never passes `mcpConfig` to its own engine spawns, so
subagents cannot spawn subagents and the tree stays one level deep.

### 2e. Anchor cards to the parent's `spawn_agent` tool_use id

The MCP shim cannot know the id of the tool call it is servicing: the CLI never
tells a tool its own `tool_use` id. The manager therefore correlates on the
server side, and needs the socket handler to tell it what it saw.

In the `case "tool_use_start":` branch (`handler.ts:620`), after the existing
`io.to(sessionId).emit("message:stream:tool", ...)`:

```ts
if (
  event.toolName === "spawn_agent" ||
  event.toolName === "mcp__medusa__spawn_agent"
) {
  const task = typeof event.input?.task === "string" ? event.input.task : null;
  subagentManager?.registerSpawnToolUse(sessionId, event.toolId, task);
}
```

And in the `case "result":` branch (`handler.ts:692`, or wherever the turn is
finalized), drop any blocks that were never claimed:

```ts
subagentManager?.clearSpawnToolUses(sessionId);
```

Without 2e everything still works; `parentToolUseId` is simply `null` on the
socket events, and the client renders the card unanchored.

---

## 3. Events S3 should know about

Emitted to `io.to(parentSessionId)` by `SubagentManager`. S6 consumes them.

| Event | Payload |
|---|---|
| `subagent:start` | `{ sessionId, agentId, parentToolUseId, name, task, engineId, model, cwd, startedAt }` |
| `subagent:delta` | `{ sessionId, agentId, parentToolUseId, delta }` |
| `subagent:tool` | `{ sessionId, agentId, parentToolUseId, tool }` or `{ ..., toolResult }` |
| `subagent:event` | `{ sessionId, agentId, parentToolUseId, event }`, the raw `ParsedEvent` |
| `subagent:end` | `{ sessionId, agentId, parentToolUseId, status, resultText, truncated, usage, durationMs, endedAt, error? }` |
| `subagent:cancel` | client to server: `{ sessionId, agentId }` |

`subagent:event` is the generic passthrough the spec names in A.6;
`subagent:delta` and `subagent:tool` are the narrow convenience events. Both are
emitted from the same place, so a client may subscribe to whichever it prefers.

## 4. For S10 (usage attribution)

`SubagentManager` takes an optional `logUsage` callback and calls it exactly
once per finished subagent with a `SubagentUsageEntry`
(`server/src/subagents/types.ts`): `{ sessionId (the PARENT), agentId, role:
"subagent", engineId, model, durationMs, usage }`. S1 did not touch
`metrics/token-logger.ts`; wiring that callback to a real `TokenUsageEntry` with
the new `agentId` / `role` fields is S10's job.
