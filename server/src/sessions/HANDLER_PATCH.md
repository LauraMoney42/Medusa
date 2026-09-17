# Handler patch for S3 (per-session engine / provider)

S2 made the spawn path per-session: `ProcessManager.sendMessage()` takes an optional
9th argument `engine?: { engineId?: string; providerId?: string }`, and
`ProcessManager.createSession()` takes an optional 4th argument of the same shape.
Resolution order inside `sendMessage` is: per-call override, then the session entry's
own `engineId` / `providerId`, then the global `getActiveProvider()`. The resolved
`providerId` is passed down as `EngineSpawnOptions.providerId`, which
`ClaudeCliEngine.spawn()` prefers over `getActiveProvider()` when building the
Anthropic-compatible env, so one chat can run on OpenRouter while another stays native.

`server/src/routes/sessions.ts` already sets the session entry on create and on PATCH
(`createSession(..., { engineId, providerId })`, `configureSession()`, `updateWorkingDir()`),
so chats created or edited through the API resolve correctly without any handler change.
The call sites S3 owns still fall back to the global provider and should be patched so
sessions restored at boot resolve per-session too.

Line numbers below are against `main` at 67bdb3a.

## 1. `server/src/socket/handler.ts`, the three `processManager.sendMessage(...)` calls

They sit in `handleMessageSend` at lines 804, 826 and 845 (the initial send, the
tier escalation, and the final opus fallback). Each currently ends with
`sanitizedFiles` as the last argument (lines 812, 834, 853). Append one more
argument to all three:

```ts
        sanitizedFiles,
        { engineId: meta.engineId, providerId: meta.providerId }
      );
```

`meta` is the `SessionMeta` already in scope in `handleMessageSend`.

## 2. `server/src/socket/handler.ts:572`, the `const activeProviderId = getActiveProvider()`

This one value drives the usage-log tag (line 736), the
`isAnthropicCompatibleProvider(...)` check that disables tier routing/escalation
(line 792), and `getDefaultModel(activeProviderId)` (line 797). Replace it with the
session's own provider, keeping the global setting as the fallback:

```ts
    const activeProviderId = meta.providerId ?? getActiveProvider();
```

Nothing else in that block changes: an OpenRouter chat then skips the haiku ->
sonnet -> opus ladder and uses its own model id, exactly as a globally-selected
OpenRouter provider does today, and the usage log is tagged with the chat's real
provider rather than whatever happens to be selected globally.

## 3. `server/src/socket/handler.ts`, the two `processManager.createSession(...)` calls

At lines 961 and 1047:

```ts
        processManager.createSession(sessionId, meta.workingDir, true, {
          engineId: meta.engineId,
          providerId: meta.providerId,
        });
```

The call at 1047 passes no `isFirstMessage` today, so pass `true` there only if that
is the intent; otherwise keep the current default by passing `undefined` for it.

## 4. `server/src/index.ts:78`, the boot-time restore loop

```ts
  processManager.createSession(meta.id, meta.workingDir, false, {
    engineId: meta.engineId,
    providerId: meta.providerId,
  });
```

## Also for S3

`server/src/routes/sessions.ts` no longer imports `MentionRouter` or `HubPollScheduler`;
the two optional trailing parameters are typed structurally as
`{ removeSession(id: string): void }` so the hub deletion does not break this file.
When S3 deletes those modules, drop the two trailing arguments at the
`createSessionsRouter(...)` call in `index.ts` and the two optional params here.

`POST /api/sessions/bulk-prompt-append` was removed (a multi-bot convenience).
`compactSystemPrompt` was removed from `SessionMeta`; `sessions/compact-prompts.ts`
no longer reads it and is deleted wholesale by S8.
