import { describe, it, expect } from "vitest";
import { Vad, frameEnergy, resolveVadOptions, VAD_DEFAULTS } from "../vad.js";

const SAMPLE_RATE = 16_000;

/** A sine burst at the given amplitude, as PCM16. */
function tone(ms: number, amplitude = 8000, sampleRate = SAMPLE_RATE): Int16Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
  }
  return out;
}

/** Digital silence (with a touch of dither, like a real mic floor). */
function silence(ms: number, sampleRate = SAMPLE_RATE): Int16Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = i % 7 === 0 ? 4 : 0;
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("frameEnergy", () => {
  it("is zero for silence and near the RMS of a sine for a tone", () => {
    expect(frameEnergy(new Int16Array(320))).toBe(0);
    const rms = frameEnergy(tone(20, 10_000));
    // RMS of a full sine is amplitude / sqrt(2).
    expect(rms).toBeGreaterThan(6000);
    expect(rms).toBeLessThan(8000);
  });
});

describe("resolveVadOptions", () => {
  it("defaults to a 600 ms silence hangover and clamps nonsense", () => {
    expect(VAD_DEFAULTS.silenceMs).toBe(600);
    expect(resolveVadOptions().silenceMs).toBe(600);
    expect(resolveVadOptions({ silenceMs: 250 }).silenceMs).toBe(250);
    expect(resolveVadOptions({ silenceMs: 1 }).silenceMs).toBe(100);
    expect(resolveVadOptions({ energyThreshold: 0 }).energyThreshold).toBe(1);
  });
});

describe("Vad segmentation", () => {
  it("splits a speech burst, silence, second burst into two utterances", () => {
    const vad = new Vad();
    const pcm = concat(
      silence(400),
      tone(500),
      silence(800),
      tone(500),
      silence(800)
    );
    // Feed it the way the client does: 100 ms frames.
    const frame = SAMPLE_RATE / 10;
    const utterances = [];
    for (let i = 0; i < pcm.length; i += frame) {
      utterances.push(...vad.push(pcm.subarray(i, Math.min(pcm.length, i + frame))));
    }
    expect(utterances).toHaveLength(2);
    for (const u of utterances) {
      // ~500 ms of speech plus pre-roll and the 600 ms hangover.
      expect(u.durationMs).toBeGreaterThan(900);
      expect(u.durationMs).toBeLessThan(1600);
      expect(u.truncated).toBe(false);
    }
  });

  it("does not end an utterance on a pause shorter than the hangover", () => {
    const vad = new Vad();
    const pcm = concat(tone(400), silence(300), tone(400), silence(800));
    const utterances = vad.push(pcm);
    expect(utterances).toHaveLength(1);
  });

  it("honours a per-session silence timeout", () => {
    const vad = new Vad({ silenceMs: 200 });
    const utterances = vad.push(concat(tone(300), silence(300), tone(300), silence(300)));
    expect(utterances).toHaveLength(2);
  });

  it("drops bursts shorter than minSpeechMs", () => {
    const vad = new Vad({ minSpeechMs: 300 });
    expect(vad.push(concat(tone(80), silence(800)))).toHaveLength(0);
  });

  it("fires onSpeechStart once per utterance, before the transcript exists", () => {
    const vad = new Vad();
    let starts = 0;
    vad.onSpeechStart = () => starts++;
    vad.push(concat(silence(200), tone(400)));
    expect(starts).toBe(1);
    expect(vad.speaking).toBe(true);
    vad.push(concat(silence(800), tone(400), silence(800)));
    expect(starts).toBe(2);
  });

  it("keeps pre-roll audio so the onset is not clipped", () => {
    const withPreRoll = new Vad({ preRollMs: 300 });
    const without = new Vad({ preRollMs: 0 });
    const pcm = concat(silence(500), tone(400), silence(800));
    const a = withPreRoll.push(pcm)[0];
    const b = without.push(pcm)[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect((a as { pcm: Int16Array }).pcm.length).toBeGreaterThan(
      (b as { pcm: Int16Array }).pcm.length
    );
  });

  it("flush() closes an utterance that is still open (push-to-talk release)", () => {
    const vad = new Vad();
    vad.push(concat(silence(100), tone(500)));
    const utterance = vad.flush();
    expect(utterance).not.toBeNull();
    expect(vad.speaking).toBe(false);
    expect(vad.flush()).toBeNull();
  });

  it("cuts a monologue at maxUtteranceMs and marks it truncated", () => {
    const vad = new Vad({ maxUtteranceMs: 1000 });
    const utterances = vad.push(tone(2500));
    expect(utterances.length).toBeGreaterThanOrEqual(2);
    expect(utterances[0]?.truncated).toBe(true);
  });

  it("reassembles frames that do not align to the analysis window", () => {
    const vad = new Vad();
    const pcm = concat(silence(200), tone(500), silence(800));
    const utterances = [];
    // 37-sample writes: never a whole 320-sample frame.
    for (let i = 0; i < pcm.length; i += 37) {
      utterances.push(...vad.push(pcm.subarray(i, Math.min(pcm.length, i + 37))));
    }
    expect(utterances).toHaveLength(1);
  });
});
