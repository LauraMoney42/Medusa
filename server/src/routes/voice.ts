import { Router, Request, Response } from "express";
import config from "../config.js";
import { listProviders, listRealtimeProviders } from "../voice/providers.js";
import { DIVERGENCE_THRESHOLD, STABLE_MS } from "../voice/speculation.js";
import { ROLLING_DEFAULTS } from "../voice/streaming-stt.js";
import { listVoiceSessions, getVoiceSession } from "../socket/voice-handlers.js";
import { readVoice } from "../packs/store.js";
import { tierFromSettings } from "../voice/live/live-session.js";
import { getRealtimeProvider } from "../voice/providers.js";
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

  // Which tier a new voice session would get, decided the same way
  // `voice:start` decides it, so Settings and the mic badge cannot disagree.
  let settings: ReturnType<typeof readVoice> | null = null;
  try {
    settings = readVoice();
  } catch {
    // Defaults win when the pack cannot be read.
  }
  const preference = settings?.liveTier ?? "auto";
  const realtimeProviders = listRealtimeProviders();
  const decision = tierFromSettings(settings, getRealtimeProvider);
  const selected =
    realtimeProviders.find((p) => p.id === decision.providerId) ??
    realtimeProviders.find((p) => p.id === (settings?.liveProvider || "gemini-live")) ??
    null;
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
     * Live mode (S17). Wired end to end now: `voice:start` picks a tier,
     * `voice:audio` is routed to the realtime model when Live wins, and both
     * transcripts land in the chat. `tier` is what this chat would get right
     * now if voice started this second, so Settings can show it without a
     * live session existing.
     */
    realtime: {
      implemented: true,
      providers: realtimeProviders,
      tier: decision.tier,
      provider: decision.providerId ?? null,
      model: decision.model ?? selected?.defaultModel ?? null,
      hasKey: Boolean(selected?.ready),
      reason: decision.reason,
      preference,
      freeKeyUrl: "https://aistudio.google.com/apikey",
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
