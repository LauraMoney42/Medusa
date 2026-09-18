/**
 * Pluggable STT/TTS providers for the voice loop.
 *
 * Both default implementations talk to the same local HTTP servers the mic
 * button and the speaker button already use: faster-whisper behind
 * `STT_API_BASE_URL` (supervised by `stt/whisper-manager.ts`) and Kokoro behind
 * `TTS_API_BASE_URL` (supervised by `tts/tts-manager.ts`). Nothing in the voice
 * pipeline knows which backend is behind the interface, so swapping in a cloud
 * endpoint is a config change, and the tests swap in a fake `fetch`.
 */

import config from "../config.js";
import { isWhisperReady } from "../stt/whisper-manager.js";
import { isTtsReady } from "../tts/tts-manager.js";

export interface SttProvider {
  readonly id: string;
  /** Transcribe one utterance of 16 kHz mono PCM16. Returns trimmed text. */
  transcribe(pcm: Int16Array, sampleRate?: number): Promise<string>;
  /** Best-effort readiness for `GET /api/voice/status`. */
  isReady(): boolean;
  /** True when the backend can return interim hypotheses (Whisper cannot). */
  readonly supportsPartials: boolean;
}

export interface SynthesizedAudio {
  audio: Buffer;
  mime: string;
}

export interface TtsProvider {
  readonly id: string;
  synthesize(text: string, voice?: string): Promise<SynthesizedAudio>;
  isReady(): boolean;
}

/** Wrap raw PCM16 in a 44-byte RIFF header so any HTTP backend accepts it. */
export function pcm16ToWav(pcm: Int16Array, sampleRate = 16_000): Buffer {
  const channels = 1;
  const bytesPerSample = 2;
  const dataBytes = pcm.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format: PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(pcm[i] as number, 44 + i * 2);
  }
  return buf;
}

/** Decode a WAV buffer's PCM16 payload (used by the live-check harness). */
export function wavToPcm16(wav: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Not a RIFF/WAV buffer");
  }
  let offset = 12;
  let sampleRate = 16_000;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      sampleRate = wav.readUInt32LE(body + 4);
    } else if (id === "data") {
      const end = Math.min(wav.length, body + size);
      const count = Math.floor((end - body) / 2);
      const pcm = new Int16Array(count);
      for (let i = 0; i < count; i++) pcm[i] = wav.readInt16LE(body + i * 2);
      return { pcm, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

const stripSlash = (url: string) => url.replace(/\/$/, "");

/** faster-whisper / any OpenAI-compatible `/audio/transcriptions` endpoint. */
export class WhisperSttProvider implements SttProvider {
  readonly id = "whisper";
  readonly supportsPartials = false;

  constructor(
    private readonly baseUrl: string = config.sttApiBaseUrl,
    private readonly apiKey: string = config.sttApiKey,
    private readonly model: string = config.sttModel
  ) {}

  isReady(): boolean {
    // The local supervisor knows for sure; a remote endpoint is assumed ready
    // as soon as it is configured with a key.
    return isWhisperReady() || (Boolean(this.apiKey) && !this.baseUrl.includes("localhost"));
  }

  async transcribe(pcm: Int16Array, sampleRate = 16_000): Promise<string> {
    const wav = pcm16ToWav(pcm, sampleRate);
    const form = new FormData();
    // Copy into a plain Uint8Array: a Node Buffer's backing store is typed as
    // ArrayBufferLike, which is not a valid BlobPart.
    form.append("file", new Blob([Uint8Array.from(wav)], { type: "audio/wav" }), "utterance.wav");
    form.append("model", this.model);
    form.append("response_format", "json");

    const res = await fetch(`${stripSlash(this.baseUrl)}/audio/transcriptions`, {
      method: "POST",
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Whisper transcription failed (${res.status})`);
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? "").trim();
  }
}

/** Kokoro / any OpenAI-compatible `/audio/speech` endpoint. */
export class KokoroTtsProvider implements TtsProvider {
  readonly id = "kokoro";

  constructor(
    private readonly baseUrl: string = config.ttsApiBaseUrl,
    private readonly apiKey: string = config.ttsApiKey,
    private readonly model: string = config.ttsModel,
    private readonly defaultVoice: string = config.ttsVoice
  ) {}

  isReady(): boolean {
    return isTtsReady() || (Boolean(this.baseUrl) && !this.baseUrl.includes("localhost"));
  }

  async synthesize(text: string, voice?: string): Promise<SynthesizedAudio> {
    const res = await fetch(`${stripSlash(this.baseUrl)}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: voice || this.defaultVoice,
        response_format: "wav",
      }),
    });
    if (!res.ok) {
      throw new Error(`Kokoro synthesis failed (${res.status})`);
    }
    const mime = res.headers.get("content-type") || "audio/wav";
    return { audio: Buffer.from(await res.arrayBuffer()), mime };
  }
}

// ---- Registry ----------------------------------------------------------

let sttProvider: SttProvider | null = null;
let ttsProvider: TtsProvider | null = null;

export function getSttProvider(): SttProvider {
  if (!sttProvider) sttProvider = new WhisperSttProvider();
  return sttProvider;
}

export function getTtsProvider(): TtsProvider {
  if (!ttsProvider) ttsProvider = new KokoroTtsProvider();
  return ttsProvider;
}

/** Test seam: swap either provider (pass null to restore the default). */
export function setVoiceProviders(next: {
  stt?: SttProvider | null;
  tts?: TtsProvider | null;
}): void {
  if (next.stt !== undefined) sttProvider = next.stt;
  if (next.tts !== undefined) ttsProvider = next.tts;
}

export interface ProviderStatus {
  role: "stt" | "tts";
  id: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  ready: boolean;
}

/** Provider inventory for `GET /api/voice/status`. */
export function listProviders(): ProviderStatus[] {
  return [
    {
      role: "stt",
      id: getSttProvider().id,
      baseUrl: config.sttApiBaseUrl,
      model: config.sttModel,
      enabled: config.sttEnabled,
      ready: config.sttEnabled && getSttProvider().isReady(),
    },
    {
      role: "tts",
      id: getTtsProvider().id,
      baseUrl: config.ttsApiBaseUrl,
      model: config.ttsModel,
      enabled: config.ttsEnabled,
      ready: config.ttsEnabled && getTtsProvider().isReady(),
    },
  ];
}
