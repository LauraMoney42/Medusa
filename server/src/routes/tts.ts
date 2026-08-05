import { Router, Request, Response } from "express";
import config from "../config.js";

/**
 * Text-to-speech endpoint. Forwards text to any OpenAI-compatible
 * `/audio/speech` endpoint (local Kokoro server, OpenAI, etc.) and streams the
 * audio back so the client can play Medusa's replies out loud.
 */
const router = Router();

// GET /api/tts/status — lets the client show/hide the speak toggle.
router.get("/status", (_req: Request, res: Response) => {
  res.json({ enabled: config.ttsEnabled && Boolean(config.ttsApiBaseUrl) });
});

// POST /api/tts — synthesize speech for { text, voice? }, returns audio bytes.
router.post("/", async (req: Request, res: Response) => {
  if (!config.ttsEnabled) {
    res.status(503).json({ error: "Text-to-speech is disabled (set TTS_ENABLED=true)." });
    return;
  }
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const voice = typeof req.body?.voice === "string" && req.body.voice ? req.body.voice : config.ttsVoice;
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
