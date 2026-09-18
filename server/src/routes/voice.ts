import { Router, Request, Response } from "express";
import config from "../config.js";
import { listProviders } from "../voice/providers.js";
import { listVoiceSessions } from "../socket/voice-handlers.js";
import { VAD_DEFAULTS } from "../voice/vad.js";
import { MAX_SENTENCE_CHARS } from "../voice/sentence-chunker.js";

/**
 * Voice loop status (S14-A). The client calls this before offering voice mode:
 * it says which STT/TTS providers are configured, whether each one is actually
 * up right now, and what VAD defaults the server will apply.
 */
const router = Router();

// GET /api/voice/status
router.get("/status", (_req: Request, res: Response) => {
  const providers = listProviders();
  const stt = providers.find((p) => p.role === "stt");
  const tts = providers.find((p) => p.role === "tts");
  res.json({
    // Voice mode needs both halves: transcription in and speech out.
    enabled: Boolean(stt?.enabled && tts?.enabled),
    ready: Boolean(stt?.ready && tts?.ready),
    providers,
    sessions: listVoiceSessions(),
    defaults: {
      vad: VAD_DEFAULTS,
      voice: config.ttsVoice,
      maxSentenceChars: MAX_SENTENCE_CHARS,
    },
  });
});

export default router;
