/**
 * Pure PCM math for the mic-capture path (S14-C, spec section 4).
 *
 * getUserMedia hands us Float32 samples at whatever rate the input device
 * runs (commonly 44100 or 48000 Hz). The server's Whisper-backed VAD/STT
 * pipeline (spec section 3) wants 16 kHz mono PCM16, so every worklet frame
 * is downsampled and requantized before it goes over the socket as
 * `voice:audio`.
 *
 * This file is deliberately framework-free (no AudioContext, no DOM) so it
 * can run in both the AudioWorkletGlobalScope (via the inline module built in
 * micWorkletSource.ts, which mirrors this exact algorithm) and in a plain
 * Node unit test. Keep the two in sync if you change the resampling method.
 */

export const TARGET_SAMPLE_RATE = 16000;

/**
 * Linear-interpolation resample of a mono Float32 buffer to `targetRate`.
 * Downsampling only needs to be "good enough for speech", not broadcast
 * quality, so linear interpolation (rather than a windowed sinc filter) is
 * the right tradeoff: it is cheap enough to run every 100 ms on a worklet
 * thread with no allocation budget to spare.
 */
export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  targetRate: number = TARGET_SAMPLE_RATE,
): Float32Array {
  if (inputRate === targetRate) return input.slice();
  if (input.length === 0) return new Float32Array(0);

  const ratio = inputRate / targetRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const a = input[srcIndex] ?? input[input.length - 1] ?? 0;
    const b = input[srcIndex + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Clamp a float sample in [-1, 1] and requantize to a signed 16-bit int. */
export function floatSampleToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/** Float32 buffer at `inputRate` -> mono PCM16 at `targetRate`. */
export function floatTo16kPCM16(
  input: Float32Array,
  inputRate: number,
  targetRate: number = TARGET_SAMPLE_RATE,
): Int16Array {
  const resampled = resampleLinear(input, inputRate, targetRate);
  const out = new Int16Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    out[i] = floatSampleToInt16(resampled[i]);
  }
  return out;
}

/**
 * Echo guard (spec section 4): while the assistant is speaking, duck the
 * level of what we send upstream rather than muting outright, so a loud
 * barge-in still gets through. This is intentionally simple energy-domain
 * gain, not acoustic echo cancellation. This is a documented tradeoff: on
 * laptop mic/speaker setups the user's voice is far louder at the mic
 * than the speaker's own leakage, so a barge-in is not lost, but on unusual
 * hardware setups (e.g. line-in playback loopback) it may not attenuate
 * enough to prevent occasional self-triggering. The duck factor is
 * configurable from Settings > Voice ("interrupt behavior" pairs with this).
 */
export function applyEchoGuard(pcm: Int16Array, duckFactor: number): Int16Array {
  if (duckFactor >= 1) return pcm;
  const factor = Math.max(0, duckFactor);
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = Math.round(pcm[i] * factor);
  }
  return out;
}
