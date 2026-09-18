# Live voice

**Date:** 2026-09-18

Live voice is true speech to speech. Your voice goes to a realtime model over
one socket and its voice comes straight back. Nothing is transcribed, answered
and re-synthesized in between, so the pauses that make the local pipeline feel
like a walkie-talkie are gone.

The rule is that voice always works. Medusa picks the best tier she can reach,
tells you which one she is on, and says how to move up when the better one is
free.

## Tiers

| Tier | What runs | Needs |
|---|---|---|
| `live` | A realtime speech-to-speech model. One socket: audio in, audio out. | A realtime API key |
| `pipeline` | The S14 loop: Whisper, then the chat engine, then Kokoro. | Nothing (all local) |

Medusa picks on every `voice:start` and emits `voice:tier
{sessionId, tier, provider, model, reason}` once, plus an Activity Log line.
The badge beside the mic reads **Live** or **Local**, and `reason` is its
tooltip.

`Settings > Voice > Live voice` sets the preference:

- **Auto (best available)**: Live when a realtime key exists, local otherwise.
  This is the default.
- **Pipeline only**: pin the local loop even when a key exists.
- **Live only**: prefer Live. It still falls back to the pipeline when there is
  no key, because a missing key must never mean a dead microphone.

## Getting a key (free)

The Gemini provider works on a free Google AI Studio key.

1. Create one at https://aistudio.google.com/apikey
2. Put it in `~/.claude-chat/settings.json`:

   ```json
   { "providers": { "gemini": { "apiKey": "..." } } }
   ```

   or set `GEMINI_API_KEY` in the environment.

3. Turn voice on. The badge should read **Live**.

The same slot is where the other non-chat keys live (`openai`, `deepgram`);
none of them appear in the model picker, because none of them can drive a chat.

## Providers and models

| Provider id | Display name | Default model |
|---|---|---|
| `gemini-live` | Gemini Live (native audio) | `gemini-2.5-flash-native-audio-latest` |
| `openai-realtime` | OpenAI Realtime | `gpt-realtime` |

Gemini is tried first: it is the only one with a free tier that speaks native
audio. Anthropic has no realtime audio API, so Medusa's own provider is not an
option for this tier. `Settings > Voice > Model` overrides the default;
`gemini-3.5-transcribe-live` is offered alongside the native-audio model.

## What she keeps

Live voice does not take the orchestration away.

- Every Medusa MCP tool (`spawn_agent`, `agent_status`, `agent_result`,
  `list_agents`, `cancel_agent`) is handed to the realtime model as a function
  declaration, and every call it makes is executed against Medusa's own HTTP
  API with this chat as the parent session. Subagents still run here.
- The system instruction is Medusa's own orchestrator prompt in voice mode:
  the same persona, the same working-folder discipline, the same two-lane rule,
  the same spoken style.
- Both sides are transcribed and land in the chat as ordinary messages, so the
  history stays complete. A user turn carries `source: "voice-live"`.
- A subagent follow-up is injected into the live conversation as a turn, so she
  says it out loud instead of it appearing only as text.

## Fallback

If the realtime service fails mid-conversation (quota, auth, a dropped socket),
Medusa:

1. closes the realtime session,
2. emits a second `voice:tier` with `tier: "pipeline"` and the error in
   `reason`,
3. starts the local pipeline session in its place,
4. speaks one short local line, "Switching to local voice",
5. and tries Live again the next time voice is switched on.

Voice is never left off.

## Protocol notes (Gemini Live)

Implemented in `server/src/voice/live/gemini-live.ts` against the published
BidiGenerateContent reference (ai.google.dev/api/live plus the live,
live-guide and live-tools pages, read 2026-09-18):

- Endpoint: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<API_KEY>`
- `{"setup": {...}}` is the first frame, and nothing else may be sent until the
  server answers `{"setupComplete": {}}`.
- Audio in: `{"realtimeInput": {"audio": {"data": <base64>, "mimeType": "audio/pcm;rate=16000"}}}`,
  raw little-endian 16-bit mono PCM.
- Audio out: `serverContent.modelTurn.parts[].inlineData`, 24 kHz PCM16.
- Barge-in: `serverContent.interrupted === true`.
- Tools: `setup.tools[].functionDeclarations`; calls arrive as
  `{"toolCall": {"functionCalls": [{id, name, args}]}}` and are answered with
  `{"toolResponse": {"functionResponses": [{id, name, response}]}}`. The Live
  API does no automatic tool handling.
- Text turn (follow-ups): `{"clientContent": {"turns": [...], "turnComplete": true}}`.

## One speaker at a time

Every spoken turn carries a server-assigned `turnId` on
`voice:speaking-start`, every `voice:audio-chunk`, `voice:speaking-end` and
`voice:stop-audio`, exactly as the pipeline tier does, and `seq` restarts at 0
with it. The client scheduler stops the previous turn the moment a new
`turnId` arrives and refuses any chunk belonging to a turn that was stopped,
so a chunk still inside `decodeAudioData` when a barge-in lands can never be
played on top of the reply that replaced it.

While she is speaking, the mic is gated as well as ducked
(`client/src/lib/voice/echoGate.ts`): the first 500 ms of each turn measure
how loud her own echo is on this machine, and after that a frame has to stay
above `max(floor, 2x measured)` for 300 ms before anything is sent. Without
it, the leakage through the ducked mic was enough for Gemini's own VAD to
interrupt her mid-sentence and transcribe her own voice as a user turn, which
is what "talking over itself" sounded like. The gate opening is also a local
barge-in: playback stops in about 750 ms instead of waiting the ~2 s the
service takes to report the same interruption, and audio for the turn that
was cut off is dropped until the service catches up.

## Limits and known gaps

- Verified against the real service on 2026-09-18 from a headless client
  (spoken WAV in, every `voice:*` event recorded, playback fed back into the
  mic). Measured: speech end to first audio about 2.2 s, `firstAudioMs`
  337-368 ms from the transcript, barge-in to playback stop 747-1675 ms.
  Service latency is variable: turns occasionally took 20-35 s to come back on
  a free key.
- Audio out is re-wrapped as WAV in roughly 200 ms chunks, because the client
  scheduler decodes with `AudioContext.decodeAudioData`, which cannot read
  headerless PCM. That adds about one chunk of buffering to the first spoken
  word.
- A subagent follow-up still also runs its normal engine turn, so in Live mode
  it is both spoken by the realtime model and written into the chat by the
  engine. Suppressing the second one means changing the follow-up runner, which
  this workstream deliberately did not touch.
- `voice:latency` in Live mode reports `firstAudioMs` and `totalMs` only; there
  is no separate STT or first-token stage to measure.
- There is no cancel message in the Live API. The interrupt button and the
  echo gate's local barge-in both stop local playback and drop the cut-off
  turn's remaining audio; the model's own VAD is what ends the turn on its
  side, a second or two later.
- Session resumption and context-window compression are not wired, so a very
  long live conversation ends when the provider's session limit is reached.
  That surfaces as an unclean close, which triggers the pipeline fallback.
