import { Router, Request, Response } from "express";
import config from "../config.js";
import { listProviders, listRealtimeProviders } from "../voice/providers.js";
import { DIVERGENCE_THRESHOLD, STABLE_MS } from "../voice/speculation.js";
import { ROLLING_DEFAULTS } from "../voice/streaming-stt.js";
import { listVoiceSessions, getVoiceSession } from "../socket/voice-handlers.js";
import { VAD_DEFAULTS } from "../voice/vad.js";
import { BARGE_IN_DEFAULTS } from "../voice/barge-in.js";
import { MAX_SENTENCE_CHARS, FIRST_CLAUSE_CHARS } from "../voice/sentence-chunker.js";

/**
 * Voice loop status (S14-A). The client calls this before offering voice mode:
 * it says which STT/TTS providers are configured, whether each one is actually
 * up right now, and what VAD defaults the server will apply.
 */
const router = Router();

// GET /api/voice/status[?events=1]
router.get("/status", (req: Request, res: Response) => {
  const providers = listProviders();
  const stt = providers.find((p) => p.role === "stt");
  const tts = providers.find((p) => p.role === "tts");
  const sessions = listVoiceSessions();
  const body: Record<string, unknown> = {
    // Voice mode needs both halves: transcription in and speech out.
    enabled: Boolean(stt?.enabled && tts?.enabled),
    ready: Boolean(stt?.ready && tts?.ready),
    providers,
    sessions,
    defaults: {
      vad: VAD_DEFAULTS,
      bargeIn: BARGE_IN_DEFAULTS,
      voice: config.ttsVoice,
      maxSentenceChars: MAX_SENTENCE_CHARS,
      // S16 tuning, so the settings UI can show what it is actually doing.
      firstClauseChars: FIRST_CLAUSE_CHARS,
      partialIntervalMs: ROLLING_DEFAULTS.intervalMs,
      partialMaxUtteranceMs: ROLLING_DEFAULTS.maxUtteranceMs,
      speculationStableMs: STABLE_MS,
      speculationDivergence: DIVERGENCE_THRESHOLD,
    },
    /**
     * Live mode (S16 item 4). The realtime provider and its Medusa tool
     * bridge are implemented (`voice/realtime.ts`); the socket wiring that
     * would route `voice:audio` into a realtime session and post both sides'
     * transcripts into the chat is NOT, so the settings toggle stays
     * informational for now. `ready` is what the UI disables on.
     */
    realtime: {
      implemented: false,
      providers: listRealtimeProviders(),
    },
  };
  // The owner can share this: the last 200 voice events per session (state
  // changes, onsets, ignored echo onsets, barge-ins, latencies).
  if (req.query.events === "1" || req.query.events === "true") {
    const events: Record<string, unknown> = {};
    for (const s of sessions) {
      events[s.sessionId] = getVoiceSession(s.sessionId)?.getEvents() ?? [];
    }
    body.events = events;
  }
  res.json(body);
});

export default router;
