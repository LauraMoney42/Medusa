import type {
  VoiceAudioChunkPayload,
  VoiceStopAudioPayload,
  VoiceSpeakingStartPayload,
  VoiceSpeakingEndPayload,
} from '../../types/voice';

/**
 * useSocket() is mounted once, high in the tree (AuthenticatedApp), while the
 * AudioContext and GaplessAudioQueue that actually play `voice:audio-chunk`
 * frames live inside VoiceBar (they're not serializable, so they don't
 * belong in zustand). This tiny bus is the seam between the two: useSocket
 * forwards the two binary/high-frequency events here, VoiceBar subscribes
 * while mounted. Everything else in the section 7 contract (state, partial,
 * transcript, latency) goes through stores/voiceStore.ts and
 * stores/activityStore.ts directly since it's small and React-friendly.
 *
 * `voice:speaking-start` is also forwarded here (not through voiceStore)
 * because it carries the `turnId` the scheduler needs BEFORE the first audio
 * chunk of a turn arrives (`GaplessAudioQueue.beginTurn`); it is what tells
 * the scheduler a new turn has begun even when nothing needed stopping.
 */

type ChunkListener = (payload: VoiceAudioChunkPayload) => void;
type StopListener = (payload: VoiceStopAudioPayload) => void;
type SpeakingStartListener = (payload: VoiceSpeakingStartPayload) => void;
type SpeakingEndListener = (payload: VoiceSpeakingEndPayload) => void;

const chunkListeners = new Set<ChunkListener>();
const stopListeners = new Set<StopListener>();
const speakingStartListeners = new Set<SpeakingStartListener>();
const speakingEndListeners = new Set<SpeakingEndListener>();

export function emitAudioChunk(payload: VoiceAudioChunkPayload): void {
  for (const l of chunkListeners) l(payload);
}

export function emitStopAudio(payload: VoiceStopAudioPayload): void {
  for (const l of stopListeners) l(payload);
}

export function emitSpeakingStart(payload: VoiceSpeakingStartPayload): void {
  for (const l of speakingStartListeners) l(payload);
}

export function emitSpeakingEnd(payload: VoiceSpeakingEndPayload): void {
  for (const l of speakingEndListeners) l(payload);
}

export function onAudioChunk(listener: ChunkListener): () => void {
  chunkListeners.add(listener);
  return () => chunkListeners.delete(listener);
}

export function onStopAudio(listener: StopListener): () => void {
  stopListeners.add(listener);
  return () => stopListeners.delete(listener);
}

export function onSpeakingStart(listener: SpeakingStartListener): () => void {
  speakingStartListeners.add(listener);
  return () => speakingStartListeners.delete(listener);
}

export function onSpeakingEnd(listener: SpeakingEndListener): () => void {
  speakingEndListeners.add(listener);
  return () => speakingEndListeners.delete(listener);
}
