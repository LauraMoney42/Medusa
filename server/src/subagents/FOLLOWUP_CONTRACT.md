# Subagent follow-up contract (S14-B to S14-C)

When a subagent finishes, the server starts a new turn in the parent chat on
its own. This file is the exact wire shape the client renders. Source of truth:
`server/src/subagents/followups.ts`.

## Lifecycle

1. A subagent reaches `done`, `error`, or `cancelled`.
2. Server emits `followup:queued` into the session room.
3. Completions within 2 s are merged; at most one follow-up turn is started per
   session per 10 s; if the session is busy the follow-up waits for idle.
4. The turn starts: `message:user` (the follow-up chip), then
   `message:stream:start`, then `followup:delivered`, then the usual
   `message:stream:delta` / `:tool` / `:end` for Medusa's reply.

`followup:delivered` is confirmation, not a heads-up: it lands just after the
turn's `message:user`, because a turn that failed to start emits nothing at all
and goes back in the queue.

## Events (server to client)

### `followup:queued`

```ts
{ sessionId: string; agentId: string; status: "done" | "error" | "cancelled" }
```

Nothing has been sent to the model yet. Safe to show as a transient hint.

### `followup:delivered`

```ts
{ sessionId: string; agentIds: string[]; text: string }
```

Emitted once the turn is under way. `text` is the same text carried by that
turn's `message:user`.

### `message:user` (follow-up variant)

The existing event, with three extra fields. A normal typed message still
arrives with `role: "user"` and no `kind` / `source`, so existing rendering is
untouched.

```ts
{
  id: string;             // uuid
  sessionId: string;
  role: "system";         // NOT "user": render a compact system chip
  kind: "followup";       // render hint
  source: "agent-followup";
  text: string;           // the follow-up body, see below
  agentIds: string[];     // every agent merged into this turn
  timestamp: string;      // ISO-8601
}
```

Render rule: when `kind === "followup"` (or `source === "agent-followup"`),
draw a one-line chip such as `Agent docs-sweep done` with the body collapsed,
not a user bubble. The assistant reply that follows is a normal assistant
message and renders as usual.

### `message:stream:start` (follow-up variant)

Same shape as today plus `source: "agent-followup"`, so the client can tag the
reply as agent-initiated. Deltas, tool events, and `message:stream:end` are
unchanged.

## Message text

One block per agent, blank line between blocks:

```
[Agent <name> <status>] <first 1500 chars of the result, or the error>
Call agent_result('<agentId>') for the full output.
```

## Persisted history

The follow-up is stored in the chat file as a message with `role: "user"`
(the persisted role union has no `system`) plus `source: "agent-followup"` and
`kind: "followup"`. Use those two fields, not the role, when rendering loaded
history, so a reloaded chat shows the same chip.
