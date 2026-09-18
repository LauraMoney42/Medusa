# S14: Speech-to-speech conversation loop and event-driven follow-ups
**Date:** 2026-09-18
**Goal:** talk with Medusa continuously, by voice, while she and her subagents work. Nothing she does may block the conversation for more than a few seconds, and her voice reply starts within about 800 ms of you finishing a sentence.

## 1. Principles

1. **Two lanes per chat.** The conversation lane is Medusa's own engine turn and must stay short. The work lane is subagents (`spawn_agent`, already shipped). The orchestrator prompt enforces: anything expected to take more than a few seconds, or more than two tool calls, goes to a subagent.
2. **Push, not poll.** When a subagent finishes, the server tells Medusa and she tells you. No one waits with a turn held open.
3. **Streaming everywhere.** Audio in is transcribed as it arrives, text out is spoken sentence by sentence as it streams, and either side can be interrupted.
4. **Local by default, pluggable.** Whisper (existing `server/src/stt/whisper-manager.ts`) and Kokoro (existing `server/src/tts/tts-manager.ts`) stay the defaults; cloud STT/TTS and realtime speech models are optional providers behind the same interfaces. Nothing here depends on which engine or model is active.

## 2. Server: event-driven follow-ups (workstream S14-B)

- `server/src/subagents/followups.ts`: subscribes to `SubagentManager` end events. On `done`/`error`/`cancelled`, it queues a follow-up for the parent session: a system-authored message `[Agent <name> <status>] <one-paragraph summary or first 1500 chars of result>` plus the agent id so Medusa can call `agent_result` for the full text.
- Delivery rules: if the parent session is idle, send immediately as a new turn with `source: "agent-followup"` (the socket layer renders it as a compact system chip, not a user bubble). If the parent is busy, hold; deliver when idle. Coalesce: multiple completions within 2 s become one message. Never deliver more than one follow-up turn per 10 s per session; extra completions merge into the next one.
- Medusa's reply to a follow-up is a normal assistant message (spoken if voice is on). The prompt instructs her to keep follow-up replies to one or two sentences unless the user asked for detail.
- Socket: `followup:queued` and `followup:delivered` events for the Activity Log.
- Tests: idle vs busy delivery, coalescing, rate cap, cancelled agents produce a follow-up, restart does not duplicate.

## 3. Server: voice pipeline (workstream S14-A)

New `server/src/voice/`:
- `session.ts`: one `VoiceSession` per chat when voice mode is on. State machine: `idle -> listening -> transcribing -> thinking -> speaking -> listening`. Emits `voice:state`.
- `stt-stream.ts`: accepts 16 kHz mono PCM chunks over the socket (`voice:audio`), runs VAD (energy plus hangover, 600 ms silence ends an utterance; configurable), sends the utterance to Whisper as soon as silence is detected, emits `voice:partial` (optional, if the Whisper server supports partials) and `voice:transcript` (final). Interface `SttProvider { transcribe(pcm): Promise<string> }` with Whisper as the default implementation.
- `tts-stream.ts`: consumes the assistant text stream for the session, splits on sentence boundaries (., ?, !, newline, or 180 chars), synthesizes each sentence through `TtsProvider { synthesize(text, voice): Promise<Buffer> }` (Kokoro default) with a lookahead of one sentence, and emits `voice:audio-chunk` (PCM or WAV, base64 or binary) in order. Emits `voice:speaking-start/end`.
- `barge-in`: when `voice:transcript` (or a confident `voice:partial`) arrives while `speaking`, the server emits `voice:stop-audio`, cancels pending TTS, and if the assistant turn is still streaming it aborts that turn (existing `message:abort`) and starts a new turn whose prompt is the new transcript, prefixed with `[You interrupted; the previous reply was cut off after: "<last spoken sentence>"]`.
- Conversation engine choice: the voice turn uses the session's normal engine and model. A per-session optional `voiceModel` override (for example Haiku or a fast Kimi tier) is supported in `SessionMeta` and the settings UI, defaulting to the session model.
- Latency budget (log every stage to the Activity Log with millis): speech end -> transcript < 300 ms (local Whisper base), transcript -> first token < 300 ms (depends on engine), first sentence -> first audio chunk < 200 ms (Kokoro). Target under 800 ms to first spoken word; the Activity Log shows the measured number per turn.
- Tests: VAD utterance segmentation on synthetic PCM, sentence chunker, ordering of audio chunks under slow synth, barge-in abort path, state machine transitions.

## 4. Client (workstream S14-C)

- `client/src/components/Voice/VoiceBar.tsx`: replaces the single mic button when voice mode is on. Controls: Voice mode toggle (off / push-to-talk / always-on), live waveform, state label (Listening, Thinking, Speaking), mute speaker, interrupt button. Always-on uses the mic continuously with VAD server-side; push-to-talk streams while held.
- `client/src/stores/voiceStore.ts`: state, transcript partials, queue of audio chunks; playback through a single `AudioContext` with gapless scheduling; stops on `voice:stop-audio`.
- Mic capture: `getUserMedia` -> `AudioWorklet` downsampling to 16 kHz PCM16 -> `voice:audio` socket frames every 100 ms. Echo guard: while speaking, either duck mic sensitivity or rely on server VAD threshold; barge-in still works because the user's voice is far louder than playback leakage on laptop mics; document the tradeoff.
- Transcript handling: the final transcript posts as a normal user message (so the chat history is complete) and the reply renders as usual while being spoken.
- Settings > Voice gains: voice mode default, VAD sensitivity, silence timeout, interrupt behavior (abort turn vs queue), voice model override.
- Tests: `tsc -b`, plus a small unit test for the audio queue scheduler.

## 5. Prompt changes (S14-B)

Append to `server/src/sessions/orchestrator-prompt.ts`: the lane rule, the follow-up reply style, and spoken-style guidance when `voiceMode` is on (short sentences, no markdown tables or code blocks read aloud; say "I put the code in the chat" instead).

## 6. Work breakdown

| ID | Owner | Model | Files |
|---|---|---|---|
| S14-A | Voice pipeline server | Opus | `server/src/voice/*`, `server/src/socket/voice-handlers.ts` (registered from handler.ts with a one-line hook), `server/src/routes/voice.ts`, `SessionMeta.voiceModel`, tests |
| S14-B | Follow-ups + prompt | Opus | `server/src/subagents/followups.ts`, `server/src/index.ts` (wire), `server/src/sessions/orchestrator-prompt.ts`, tests |
| S14-C | Client voice UI | Sonnet | `client/src/components/Voice/*`, `client/src/stores/voiceStore.ts`, `client/src/hooks/useSocket.ts` (voice events), Settings Voice tab additions, `client/src/components/Chat/ChatView.tsx` (mount VoiceBar) |
| S14-QA | End-to-end test | Sonnet | drives the running app: synthetic audio via a WAV file into the socket, measures latency from the Activity Log, verifies barge-in and follow-ups |

S14-A and S14-B both touch the handler/index wiring: S14-A owns `socket/handler.ts` (one registration line) and S14-B owns `index.ts`. S14-C depends on the event names in this document, not on the server code, so it runs in parallel.

## 7. Socket event contract

Client -> server: `voice:start {sessionId, mode}`, `voice:audio {sessionId, pcm16: ArrayBuffer}`, `voice:stop {sessionId}`, `voice:interrupt {sessionId}`.
Server -> client: `voice:state {sessionId, state}`, `voice:partial {sessionId, text}`, `voice:transcript {sessionId, text, messageId}`, `voice:audio-chunk {sessionId, seq, mime, data}`, `voice:stop-audio {sessionId}`, `voice:latency {sessionId, sttMs, firstTokenMs, firstAudioMs, totalMs}`, `followup:queued {sessionId, agentId}`, `followup:delivered {sessionId, agentIds}`.

## 8. Acceptance (manual, against the running app)

1. Voice on, always-on. Say "what's in this folder?" Reply starts speaking within about a second; transcript appears as your message; text reply renders while spoken.
2. Say "spawn an agent to count the TypeScript files under server and tell me when it's done." Medusa acknowledges in one sentence within a second; the card appears; you keep talking about something else and she answers; when the agent finishes she says the count unprompted.
3. Interrupt her mid-sentence: audio stops within ~100 ms, she answers the new question, the Activity Log shows the abort and the new turn.
4. Activity Log shows a `voice:latency` line per turn with the four stage timings.
5. Voice off: everything behaves exactly as before.
