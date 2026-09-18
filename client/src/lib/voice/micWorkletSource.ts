/**
 * Inline AudioWorkletProcessor source (spec section 4: "AudioWorklet
 * downsampling to 16 kHz PCM16 -> voice:audio frames every 100 ms"), loaded
 * via a Blob URL so no build-time asset or new dependency is needed.
 *
 * AudioWorkletGlobalScope cannot `import` this project's modules, so the
 * downsampling math below is a hand-inlined copy of
 * lib/voice/pcmDownsample.ts's `resampleLinear` + `floatSampleToInt16`. Keep
 * the two in sync; pcmDownsample.ts carries the unit-tested version of this
 * exact algorithm.
 */
export const MIC_WORKLET_SOURCE = `
class MedusaMicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = 16000;
    this.inputRate = sampleRate; // AudioWorkletGlobalScope global
    this.frameMs = (options && options.processorOptions && options.processorOptions.frameMs) || 100;
    this.samplesPerFrame = Math.round((this.targetRate * this.frameMs) / 1000);
    this.resampleRatio = this.inputRate / this.targetRate;
    this.carry = new Float32Array(0);
    this.outBuffer = [];
  }

  // Linear-interpolation resample, mirrors pcmDownsample.ts resampleLinear().
  resample(input) {
    if (this.resampleRatio === 1) return input;
    const outLength = Math.max(1, Math.round(input.length / this.resampleRatio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcPos = i * this.resampleRatio;
      const srcIndex = Math.floor(srcPos);
      const frac = srcPos - srcIndex;
      const a = input[srcIndex] !== undefined ? input[srcIndex] : (input[input.length - 1] || 0);
      const b = input[srcIndex + 1] !== undefined ? input[srcIndex + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  toInt16(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    const resampled = this.resample(channel);
    const combined = new Float32Array(this.carry.length + resampled.length);
    combined.set(this.carry, 0);
    combined.set(resampled, this.carry.length);

    let offset = 0;
    while (combined.length - offset >= this.samplesPerFrame) {
      const slice = combined.subarray(offset, offset + this.samplesPerFrame);
      const pcm16 = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) pcm16[i] = this.toInt16(slice[i]);
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
      offset += this.samplesPerFrame;
    }
    this.carry = combined.slice(offset);
    return true;
  }
}
registerProcessor('medusa-mic-processor', MedusaMicProcessor);
`;
