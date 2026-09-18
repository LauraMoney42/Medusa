/**
 * Socket event payloads for the S14 voice loop, per
 * docs/2026-09-18_s14_voice_loop_spec.md section 7 ("Socket event contract").
 * That contract is binding even though the server side (S14-A/B) is being
 * written in parallel: these types are the client's contract test.
 */

export interface VoiceStartPayload {
  sessionId: string;
  mode: 'push-to-talk' | 'always-on';
}

export interface VoiceAudioPayload {
  sessionId: string;
  pcm16: ArrayBuffer;
}

export interface VoiceStopPayload {
  sessionId: string;
}

export interface VoiceInterruptPayload {
  sessionId: string;
}

export type VoiceLoopServerState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface VoiceStatePayload {
  sessionId: string;
  state: VoiceLoopServerState;
}

export interface VoicePartialPayload {
  sessionId: string;
  text: string;
}

export interface VoiceTranscriptPayload {
  sessionId: string;
  text: string;
  messageId: string;
}

export interface VoiceAudioChunkPayload {
  sessionId: string;
  seq: number;
  mime: string;
  /** Base64 (string) or binary (ArrayBuffer), depending on transport. */
  data: string | ArrayBuffer;
}

export interface VoiceStopAudioPayload {
  sessionId: string;
}

export interface VoiceLatencyPayload {
  sessionId: string;
  sttMs: number;
  firstTokenMs: number;
  firstAudioMs: number;
  totalMs: number;
}

export interface FollowupQueuedPayload {
  sessionId: string;
  agentId: string;
}

export interface FollowupDeliveredPayload {
  sessionId: string;
  agentIds: string[];
}
