import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import type { MedusaVoice, TtsStatus } from '../../api';
import { useTtsStore } from '../../stores/ttsStore';
import { s } from './settingsStyles';
import Toggle from './Toggle';

/**
 * Voice editor. The list of voices comes from the TTS manager's status route,
 * and the preview plays through the same POST /api/tts the chat uses, so what
 * you hear here is exactly what a reply will sound like.
 *
 * Saving writes ~/.medusa/voice.json (the pack's voice part) and mirrors the
 * choice into the shared TTS store so the header toggle agrees straight away.
 */

const SAMPLE = 'Here is how I sound when I read a reply back to you.';

export default function VoiceTab() {
  const [voice, setVoice] = useState<MedusaVoice | null>(null);
  const [tts, setTts] = useState<TtsStatus | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const setStoreVoice = useTtsStore((st) => st.setVoice);
  const setStoreSpeed = useTtsStore((st) => st.setSpeed);
  const setStoreSpeak = useTtsStore((st) => st.setSpeak);

  useEffect(() => {
    api.fetchVoiceSettings().then(setVoice).catch((e: Error) => setError(e.message));
    api.fetchTtsStatus().then(setTts).catch(() => setTts(null));
  }, []);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const patch = useCallback((fields: Partial<MedusaVoice>) => {
    setVoice((v) => (v ? { ...v, ...fields } : v));
    setStatus(null);
  }, []);

  const handlePreview = useCallback(async () => {
    if (!voice) return;
    try {
      const url = await api.synthesizeSpeech(SAMPLE, voice.voiceId, voice.speed);
      audioRef.current?.pause();
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      setError(null);
    } catch {
      setError('Preview failed. Is the local voice server running?');
    }
  }, [voice]);

  const handleSave = useCallback(async () => {
    if (!voice) return;
    try {
      const saved = await api.saveVoiceSettings(voice);
      setVoice(saved);
      setStoreVoice(saved.voiceId);
      setStoreSpeed(saved.speed);
      setStoreSpeak(saved.enabled);
      setStatus('Voice saved.');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }, [voice, setStoreVoice, setStoreSpeed, setStoreSpeak]);

  if (!voice) {
    return <div style={s.pane}><p style={s.hint}>{error ?? 'Loading…'}</p></div>;
  }

  const voices = tts?.voices ?? [{ id: voice.voiceId, label: voice.voiceId }];

  return (
    <div style={s.pane}>
      <div style={s.card}>
        <div style={s.spread}>
          <span style={s.fieldLabel}>Speak replies aloud by default</span>
          <Toggle
            on={voice.enabled}
            label="Speak replies aloud by default"
            onChange={(next) => patch({ enabled: next })}
          />
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-id">Voice</label>
          <select
            id="voice-id"
            style={{ ...s.select, width: '100%' }}
            value={voice.voiceId}
            onChange={(e) => patch({ voiceId: e.target.value })}
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-speed">Speed {voice.speed.toFixed(2)}x</label>
          <input
            id="voice-speed"
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            style={s.slider}
            value={voice.speed}
            onChange={(e) => patch({ speed: Number(e.target.value) })}
          />
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-pitch">Pitch {voice.pitch.toFixed(2)}x</label>
          <input
            id="voice-pitch"
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            style={s.slider}
            value={voice.pitch}
            onChange={(e) => patch({ pitch: Number(e.target.value) })}
          />
        </div>

        <div style={s.row}>
          <button style={s.btnPrimary} onClick={handleSave}>Save voice</button>
          <button style={s.btn} onClick={handlePreview}>Preview sample</button>
        </div>
        {status && <p style={s.note}>{status}</p>}
        {error && <p style={s.error}>{error}</p>}
        {tts && !tts.enabled && (
          <p style={s.hint}>
            Voice output is switched off on the server, so the preview will not play.
            The setting is still saved and travels with your pack.
          </p>
        )}
      </div>
      <p style={s.hint}>
        Engine: {voice.engine}. Pitch is stored for backends that support it; the
        local voice server currently applies speed only.
      </p>
    </div>
  );
}
