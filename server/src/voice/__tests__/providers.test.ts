import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WhisperSttProvider,
  KokoroTtsProvider,
  pcm16ToWav,
  wavToPcm16,
  listProviders,
} from "../providers.js";
import { SttStream } from "../stt-stream.js";

const SAMPLE_RATE = 16_000;

function tone(ms: number): Int16Array {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WAV helpers", () => {
  it("round-trips PCM16 through a RIFF header", () => {
    const pcm = tone(50);
    const wav = pcm16ToWav(pcm, SAMPLE_RATE);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.length).toBe(44 + pcm.length * 2);
    const decoded = wavToPcm16(wav);
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.pcm.length).toBe(pcm.length);
    expect(decoded.pcm[100]).toBe(pcm[100]);
  });

  it("rejects a non-WAV buffer", () => {
    expect(() => wavToPcm16(Buffer.from("nope"))).toThrow(/RIFF/);
  });
});

describe("WhisperSttProvider", () => {
  it("posts a WAV to /audio/transcriptions and returns the trimmed text", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ text: "  hello there  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new WhisperSttProvider("http://127.0.0.1:8000/v1/", "k", "whisper-1");
    const text = await provider.transcribe(tone(100), SAMPLE_RATE);
    expect(text).toBe("hello there");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    const file = form.get("file") as Blob;
    expect(file.type).toBe("audio/wav");
    expect(file.size).toBe(44 + tone(100).length * 2);
  });

  it("throws on an upstream failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 502 })));
    const provider = new WhisperSttProvider("http://127.0.0.1:8000/v1", "k", "whisper-1");
    await expect(provider.transcribe(tone(20))).rejects.toThrow(/502/);
  });
});

describe("KokoroTtsProvider", () => {
  it("posts JSON to /audio/speech and returns WAV bytes", async () => {
    const wav = pcm16ToWav(tone(20));
    const fetchMock = vi.fn(async () =>
      new Response(Uint8Array.from(wav), { status: 200, headers: { "content-type": "audio/wav" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new KokoroTtsProvider("http://127.0.0.1:8001/v1", "local", "kokoro", "af_heart");
    const out = await provider.synthesize("Hello.", "bf_emma");
    expect(out.mime).toBe("audio/wav");
    expect(out.audio.length).toBe(wav.length);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8001/v1/audio/speech");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "kokoro",
      input: "Hello.",
      voice: "bf_emma",
      response_format: "wav",
    });
  });

  it("falls back to the configured default voice", async () => {
    const fetchMock = vi.fn(async () => new Response(Uint8Array.from(pcm16ToWav(tone(10))), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new KokoroTtsProvider("http://127.0.0.1:8001/v1", "", "kokoro", "af_heart");
    await provider.synthesize("Hi.");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).voice).toBe("af_heart");
  });

  it("throws on an upstream failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const provider = new KokoroTtsProvider("http://127.0.0.1:8001/v1");
    await expect(provider.synthesize("Hi.")).rejects.toThrow(/500/);
  });
});

describe("SttStream", () => {
  it("transcribes each segmented utterance in order", async () => {
    let n = 0;
    const provider = {
      id: "fake",
      supportsPartials: false,
      isReady: () => true,
      transcribe: async () => {
        n++;
        // The first utterance resolves slowly; order must still hold.
        if (n === 1) await new Promise((r) => setTimeout(r, 40));
        return `utterance ${n}`;
      },
    };
    const transcripts: string[] = [];
    const stream = new SttStream({ provider, onTranscript: (t) => transcripts.push(t) });

    const silence = (ms: number) => new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
    stream.pushAudio(tone(400));
    stream.pushAudio(silence(800));
    stream.pushAudio(tone(400));
    stream.pushAudio(silence(800));
    await new Promise((r) => setTimeout(r, 120));
    expect(transcripts).toEqual(["utterance 1", "utterance 2"]);
  });

  it("drops empty and blank-audio transcripts", async () => {
    const provider = {
      id: "fake",
      supportsPartials: false,
      isReady: () => true,
      transcribe: async () => "[BLANK_AUDIO]",
    };
    const transcripts: string[] = [];
    const stream = new SttStream({ provider, onTranscript: (t) => transcripts.push(t) });
    stream.pushAudio(tone(400));
    stream.pushAudio(new Int16Array(SAMPLE_RATE));
    await new Promise((r) => setTimeout(r, 30));
    expect(transcripts).toEqual([]);
  });

  it("reports a transcription failure without killing the stream", async () => {
    const provider = {
      id: "fake",
      supportsPartials: false,
      isReady: () => true,
      transcribe: async () => {
        throw new Error("whisper down");
      },
    };
    const errors: string[] = [];
    const stream = new SttStream({ provider, onError: (e) => errors.push(e.message) });
    stream.pushAudio(tone(400));
    stream.pushAudio(new Int16Array(SAMPLE_RATE));
    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toEqual(["whisper down"]);
  });

  it("accepts a Buffer of little-endian PCM16 from the socket", async () => {
    const provider = {
      id: "fake",
      supportsPartials: false,
      isReady: () => true,
      transcribe: async (pcm: Int16Array) => `${pcm.length}`,
    };
    const transcripts: string[] = [];
    const stream = new SttStream({ provider, onTranscript: (t) => transcripts.push(t) });
    const pcm = tone(400);
    stream.pushAudio(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    stream.pushAudio(Buffer.alloc(SAMPLE_RATE * 2));
    await new Promise((r) => setTimeout(r, 30));
    expect(transcripts).toHaveLength(1);
    expect(Number(transcripts[0])).toBeGreaterThan(pcm.length * 0.9);
  });
});

describe("listProviders", () => {
  it("reports one stt and one tts entry for /api/voice/status", () => {
    const providers = listProviders();
    expect(providers.map((p) => p.role)).toEqual(["stt", "tts"]);
    expect(providers[0]?.id).toBe("whisper");
    expect(providers[1]?.id).toBe("kokoro");
    for (const p of providers) {
      expect(typeof p.ready).toBe("boolean");
      expect(typeof p.baseUrl).toBe("string");
    }
  });
});
