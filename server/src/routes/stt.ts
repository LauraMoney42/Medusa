import { Router, Request, Response } from "express";
import multer from "multer";
import config from "../config.js";

/**
 * Speech-to-text endpoint. Accepts an audio recording from the client's mic
 * button and forwards it to any OpenAI-compatible `/audio/transcriptions`
 * endpoint (OpenAI, Groq, or a local whisper.cpp / faster-whisper server).
 *
 * The client records with MediaRecorder (rather than the browser
 * SpeechRecognition API) because the packaged macOS app runs in WKWebView,
 * where SpeechRecognition is unavailable but getUserMedia + MediaRecorder work.
 */

// Audio is held in memory and streamed straight to the STT provider — no need
// to persist recordings to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — matches common Whisper API limits
});

const router = Router();

// GET /api/stt/status — lets the client decide whether to show the mic button.
router.get("/status", (_req: Request, res: Response) => {
  res.json({ enabled: config.sttEnabled && Boolean(config.sttApiKey) });
});

// POST /api/stt — transcribe an audio blob, returns { text }.
router.post("/", upload.single("audio"), async (req: Request, res: Response) => {
  if (!config.sttEnabled) {
    res.status(503).json({ error: "Speech-to-text is disabled (set STT_ENABLED=true)." });
    return;
  }
  if (!config.sttApiKey) {
    res.status(503).json({
      error:
        "Speech-to-text is not configured. Set STT_API_KEY (and optionally STT_API_BASE_URL / STT_MODEL).",
    });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "No audio file provided" });
    return;
  }

  try {
    const form = new FormData();
    // Copy into a fresh Uint8Array so the type is a plain-ArrayBuffer-backed
    // BlobPart (a Node Buffer's backing store is typed as ArrayBufferLike).
    const bytes = Uint8Array.from(req.file.buffer);
    const blob = new Blob([bytes], { type: req.file.mimetype || "audio/webm" });
    form.append("file", blob, req.file.originalname || "recording.webm");
    form.append("model", config.sttModel);
    form.append("response_format", "json");

    const url = `${config.sttApiBaseUrl.replace(/\/$/, "")}/audio/transcriptions`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.sttApiKey}` },
      body: form,
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error(`[stt] upstream ${upstream.status}: ${detail}`);
      res.status(502).json({ error: `Transcription failed (${upstream.status}).` });
      return;
    }

    const data = (await upstream.json()) as { text?: string };
    res.json({ text: (data.text ?? "").trim() });
  } catch (err) {
    console.error("[stt] error:", err);
    res.status(500).json({ error: "Transcription error." });
  }
});

export default router;
