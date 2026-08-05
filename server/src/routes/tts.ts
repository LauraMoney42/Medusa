import { Router, Request, Response } from "express";
import config from "../config.js";

/**
 * Text-to-speech endpoint. Forwards text to any OpenAI-compatible
 * `/audio/speech` endpoint (local Kokoro server, OpenAI, etc.) and streams the
 * audio back so the client can play Medusa's replies out loud.
 */
const router = Router();

// Curated Kokoro voices (the default local backend). If TTS_API_BASE_URL points
// at another backend, swap this list for that provider's voices.
const KOKORO_VOICES: { id: string; label: string }[] = [
  { id: "af_heart", label: "Heart — warm (F, US)" },
  { id: "af_bella", label: "Bella (F, US)" },
  { id: "af_nicole", label: "Nicole — soft (F, US)" },
  { id: "af_sarah", label: "Sarah (F, US)" },
  { id: "af_sky", label: "Sky (F, US)" },
  { id: "am_michael", label: "Michael (M, US)" },
  { id: "am_adam", label: "Adam (M, US)" },
  { id: "am_echo", label: "Echo (M, US)" },
  { id: "bf_emma", label: "Emma (F, UK)" },
  { id: "bf_isabella", label: "Isabella (F, UK)" },
  { id: "bm_george", label: "George (M, UK)" },
  { id: "bm_fable", label: "Fable (M, UK)" },
];

// GET /api/tts/status — availability + available voices + the default voice.
router.get("/status", (_req: Request, res: Response) => {
  res.json({
    enabled: config.ttsEnabled && Boolean(config.ttsApiBaseUrl),
    voices: KOKORO_VOICES,
    defaultVoice: config.ttsVoice,
  });
});

// POST /api/tts — synthesize speech for { text, voice? }, returns audio bytes.
router.post("/", async (req: Request, res: Response) => {
  if (!config.ttsEnabled) {
    res.status(503).json({ error: "Text-to-speech is disabled (set TTS_ENABLED=true)." });
    return;
  }
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const voice = typeof req.body?.voice === "string" && req.body.voice ? req.body.voice : config.ttsVoice;
  const speed = typeof req.body?.speed === "number" ? Math.max(0.5, Math.min(2.0, req.body.speed)) : undefined;
  if (!text) {
    res.status(400).json({ error: "No text provided" });
    return;
  }

  try {
    const url = `${config.ttsApiBaseUrl.replace(/\/$/, "")}/audio/speech`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.ttsApiKey ? { Authorization: `Bearer ${config.ttsApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel,
        input: text,
        voice,
        speed,
        response_format: "wav",
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error(`[tts] upstream ${upstream.status}: ${detail}`);
      res.status(502).json({ error: `Speech synthesis failed (${upstream.status}).` });
      return;
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/wav");
    res.send(bytes);
  } catch (err) {
    console.error("[tts] error:", err);
    res.status(500).json({ error: "Speech synthesis error." });
  }
});

export default router;
