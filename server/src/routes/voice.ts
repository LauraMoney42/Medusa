import { Router, Request, Response } from "express";
import config from "../config.js";
import { listProviders } from "../voice/providers.js";
import { listVoiceSessions, getVoiceSession } from "../socket/voice-handlers.js";
import { VAD_DEFAULTS } from "../voice/vad.js";
import { BARGE_IN_DEFAULTS } from "../voice/barge-in.js";
import { MAX_SENTENCE_CHARS } from "../voice/sentence-chunker.js";

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
