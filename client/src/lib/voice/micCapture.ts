import { MIC_WORKLET_SOURCE } from './micWorkletSource';

export interface MicCaptureOptions {
  /** Called with a 16 kHz mono PCM16 frame roughly every 100 ms. */
  onFrame: (pcm16: ArrayBuffer) => void;
  /** Called with 0..1 RMS level for the live waveform. */
  onLevel?: (level: number) => void;
  onError?: (err: unknown) => void;
  frameMs?: number;
}

/**
 * getUserMedia -> AudioWorklet mic pipeline (spec section 4). The worklet
 * source is loaded from an inline Blob URL (no new dependency, no built
 * asset) and does the 16 kHz PCM16 downsampling itself so the frames posted
 * back to the main thread are already socket-ready.
 *
 * A GainNode sits between the mic source and the worklet so the echo guard
 * (spec section 4) can duck the *sent* level while the assistant is
 * speaking, without touching the local waveform tap (which reads pre-gain
 * via a parallel AnalyserNode so the visual doesn't look muted).
 */
export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: number | null = null;
  private workletUrl: string | null = null;
  private opts: MicCaptureOptions;

  constructor(opts: MicCaptureOptions) {
    this.opts = opts;
  }

  get analyserNode(): AnalyserNode | null {
    return this.analyser;
  }

  async start(): Promise<void> {
    if (this.ctx) return; // already running
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;

    const ctx = new AudioContext();
    this.ctx = ctx;

    const blob = new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    this.workletUrl = url;
    await ctx.audioWorklet.addModule(url);

    const source = ctx.createMediaStreamSource(stream);
    this.sourceNode = source;

    const gain = ctx.createGain();
    gain.gain.value = 1;
    this.gainNode = gain;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    this.analyser = analyser;

    const worklet = new AudioWorkletNode(ctx, 'medusa-mic-processor', {
      processorOptions: { frameMs: this.opts.frameMs ?? 100 },
    });
    this.workletNode = worklet;
    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      this.opts.onFrame(e.data);
    };

    // Waveform reads pre-gain (source -> analyser) so ducking during
    // "speaking" doesn't make the mic look dead; the sent frames go
    // through the gain node so the echo guard only affects what the server
    // hears.
    source.connect(analyser);
    source.connect(gain);
    gain.connect(worklet);
    // The worklet has no audible output; connecting to destination is not
    // required for `process()` to run as long as it stays referenced, but
    // some browsers pause processing on fully disconnected graphs, so give
    // it a silent sink.
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    worklet.connect(silentSink);
    silentSink.connect(ctx.destination);

    if (this.opts.onLevel) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        this.opts.onLevel?.(rms);
        this.levelTimer = window.setTimeout(tick, 50);
      };
      tick();
    }
  }

  /** Echo guard: duck (not mute) the sent level while the assistant speaks. */
  setSentGain(factor: number): void {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1, factor));
  }

  stop(): void {
    if (this.levelTimer != null) {
      window.clearTimeout(this.levelTimer);
      this.levelTimer = null;
    }
    this.workletNode?.port.close();
    this.workletNode?.disconnect();
    this.gainNode?.disconnect();
    this.analyser?.disconnect();
    this.sourceNode?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
    this.stream = null;
    this.ctx = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.workletNode = null;
    this.analyser = null;
    this.workletUrl = null;
  }
}
