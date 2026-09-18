import type { VoiceAudioChunkPayload, VoiceStopAudioPayload } from '../../types/voice';

/**
 * useSocket() is mounted once, high in the tree (AuthenticatedApp), while the
 * AudioContext and GaplessAudioQueue that actually play `voice:audio-chunk`
 * frames live inside VoiceBar (they're not serializable, so they don't
 * belong in zustand). This tiny bus is the seam between the two: useSocket
 * forwards the two binary/high-frequency events here, VoiceBar subscribes
 * while mounted. Everything else in the section 7 contract (state, partial,
 * transcript, latency) goes through stores/voiceStore.ts and
 * stores/activityStore.ts directly since it's small and React-friendly.
 */

type ChunkListener = (payload: VoiceAudioChunkPayload) => void;
type StopListener = (payload: VoiceStopAudioPayload) => void;

const chunkListeners = new Set<ChunkListener>();
const stopListeners = new Set<StopListener>();

export function emitAudioChunk(payload: VoiceAudioChunkPayload): void {
  for (const l of chunkListeners) l(payload);
}

export function emitStopAudio(payload: VoiceStopAudioPayload): void {
  for (const l of stopListeners) l(payload);
}

export function onAudioChunk(listener: ChunkListener): () => void {
  chunkListeners.add(listener);
  return () => chunkListeners.delete(listener);
}

export function onStopAudio(listener: StopListener): () => void {
  stopListeners.add(listener);
  return () => stopListeners.delete(listener);
}
