import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import type { MedusaVoice, TtsStatus, VoiceLoopStatus } from '../../api';
import { useTtsStore } from '../../stores/ttsStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useProviderStore } from '../../stores/providerStore';
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
  // S16: Live mode needs a key on the server, so the toggle is disabled with
  // an explanation until one exists.
  const [loop, setLoop] = useState<VoiceLoopStatus | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const setStoreVoice = useTtsStore((st) => st.setVoice);
  const setStoreSpeed = useTtsStore((st) => st.setSpeed);
  const setStoreSpeak = useTtsStore((st) => st.setSpeak);

  // S14-C: voice loop gains (spec section 4). voiceMode/vadSensitivity/
  // silenceTimeoutMs/interruptBehavior are account-wide defaults that live
  // on the same pack as the rest of this tab; voiceModel is per-session (it
  // makes sense to run a cheaper model for one chat's voice turns and not
  // another), so it's read/written straight through PATCH /api/sessions
  // rather than through the MedusaVoice pack.
  const activeSessionId = useSessionStore((st) => st.activeSessionId);
  const sessions = useSessionStore((st) => st.sessions);
  const updateSessionInStore = useSessionStore((st) => st.updateSession);
  const activeSession = sessions.find((sess) => sess.id === activeSessionId) ?? null;
  const globalProviderId = useProviderStore((st) => st.activeProviderId);
  const providerId = activeSession?.providerId ?? globalProviderId;
  const modelOptions = useProviderStore((st) => st.modelsFor(providerId));
  const [voiceModelStatus, setVoiceModelStatus] = useState<string | null>(null);
  // Mute-speaker: moved out of the old VoiceBar strip. Lives here and as the
  // existing speaker icon in the chat header, both reading/writing the same
  // client-local voiceStore field.
  const speakerMuted = useVoiceStore((st) => st.speakerMuted);
  const setSpeakerMuted = useVoiceStore((st) => st.setSpeakerMuted);
  // Echo guard + barge-in: client-local (localStorage), not part of the
  // account's voice.json pack, since they tune this machine's mic/speaker
  // setup rather than a voice preference that should follow the account.
  const echoGuardEnabled = useVoiceStore((st) => st.echoGuardEnabled);
  const setEchoGuardEnabled = useVoiceStore((st) => st.setEchoGuardEnabled);
  const echoGuardDuckFactor = useVoiceStore((st) => st.echoGuardDuckFactor);
  const setEchoGuardDuckFactor = useVoiceStore((st) => st.setEchoGuardDuckFactor);
  const bargeInEnergyThreshold = useVoiceStore((st) => st.bargeInEnergyThreshold);
  const setBargeInEnergyThreshold = useVoiceStore((st) => st.setBargeInEnergyThreshold);
  const bargeInMinSpeechMs = useVoiceStore((st) => st.bargeInMinSpeechMs);
  const setBargeInMinSpeechMs = useVoiceStore((st) => st.setBargeInMinSpeechMs);

  useEffect(() => {
    api.fetchVoiceSettings().then(setVoice).catch((e: Error) => setError(e.message));
    api.fetchTtsStatus().then(setTts).catch(() => setTts(null));
    api.fetchVoiceLoopStatus().then(setLoop).catch(() => setLoop(null));
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

  const handleVoiceModelChange = useCallback(
    async (next: string) => {
      if (!activeSession) return;
      setVoiceModelStatus(null);
      try {
        await api.updateSession(activeSession.id, { voiceModel: next || null });
        await updateSessionInStore(activeSession.id, { voiceModel: next || null });
        setVoiceModelStatus('Voice model saved for this chat.');
      } catch (e) {
        setVoiceModelStatus(e instanceof Error ? e.message : 'Save failed');
      }
    },
    [activeSession, updateSessionInStore],
  );

  if (!voice) {
    return <div style={s.pane}><p style={s.hint}>{error ?? 'Loading…'}</p></div>;
  }

  const voices = tts?.voices ?? [{ id: voice.voiceId, label: voice.voiceId }];

  // S17: voice always works, so nothing here is ever disabled. The server
  // reports the tier a session would get right now, plus why, and this section
  // shows that verbatim rather than second-guessing it.
  const realtimeProviders = loop?.realtime?.providers ?? [];
  const liveProviderId = voice.liveProvider ?? 'gemini-live';
  const selectedRealtime = realtimeProviders.find((p) => p.id === liveProviderId) ?? null;
  const liveTier = voice.liveTier ?? 'auto';
  const activeTier = loop?.realtime?.tier ?? 'pipeline';
  const tierReason = loop?.realtime?.reason ?? null;
  const modelOptionsLive = selectedRealtime?.models ?? [];
  const freeKeyUrl = selectedRealtime?.keyUrl ?? loop?.realtime?.freeKeyUrl
    ?? 'https://aistudio.google.com/apikey';
  // The upgrade line only makes sense while she is actually on the local tier
  // and the provider that would lift her out of it is free.
  const showFreeHint = activeTier !== 'live' && !selectedRealtime?.ready;

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

      {/* S14: speech-to-speech loop (spec section 4/6). */}
      <div style={s.card}>
        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-mode-default">Voice mode default</label>
          <select
            id="voice-mode-default"
            style={{ ...s.select, width: '100%' }}
            value={voice.voiceMode ?? 'off'}
            onChange={(e) => patch({ voiceMode: e.target.value as MedusaVoice['voiceMode'] })}
          >
            <option value="off">Off</option>
            <option value="push-to-talk">Push to talk</option>
            <option value="always-on">Always on</option>
          </select>
          <p style={s.hint}>
            The mic icon in the input bar is a plain on/off toggle for always-on voice.
            Choosing "Push to talk" here is the only way to get hold-Space behavior instead:
            hold Space to talk (only while the text box is empty), release to stop. While voice
            is on, clicking the mic once interrupts a reply that is currently speaking; a
            long-press (or Esc) always stops the loop.
          </p>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-vad">
            VAD sensitivity {(voice.vadSensitivity ?? 0.5).toFixed(2)}
          </label>
          <input
            id="voice-vad"
            type="range"
            min={0}
            max={1}
            step={0.05}
            style={s.slider}
            value={voice.vadSensitivity ?? 0.5}
            onChange={(e) => patch({ vadSensitivity: Number(e.target.value) })}
          />
          <p style={s.hint}>
            Higher picks up softer speech but is more likely to trigger on background noise.
          </p>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-silence">
            Silence timeout {voice.silenceTimeoutMs ?? 600} ms
          </label>
          <input
            id="voice-silence"
            type="range"
            min={200}
            max={2000}
            step={50}
            style={s.slider}
            value={voice.silenceTimeoutMs ?? 600}
            onChange={(e) => patch({ silenceTimeoutMs: Number(e.target.value) })}
          />
          <p style={s.hint}>How long you can pause mid-sentence before an utterance ends.</p>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-interrupt">Interrupt behavior</label>
          <select
            id="voice-interrupt"
            style={{ ...s.select, width: '100%' }}
            value={voice.interruptBehavior ?? 'abort'}
            onChange={(e) =>
              patch({ interruptBehavior: e.target.value as MedusaVoice['interruptBehavior'] })
            }
          >
            <option value="abort">Stop and answer the new question</option>
            <option value="queue">Finish speaking, then answer</option>
          </select>
        </div>

        <div style={s.spread}>
          <span style={s.fieldLabel}>Mute assistant's speaker during voice</span>
          <Toggle
            on={speakerMuted}
            label="Mute assistant's speaker during voice"
            onChange={setSpeakerMuted}
          />
        </div>

        <div style={s.row}>
          <button style={s.btnPrimary} onClick={handleSave}>Save voice loop settings</button>
        </div>
      </div>

      {/* Echo guard + barge-in: catches her own voice coming back through the
          mic on laptop speakers so a reply doesn't silently drop to text. */}
      <div style={s.card}>
        <div style={s.spread}>
          <span style={s.fieldLabel}>Echo guard (duck mic while she talks)</span>
          <Toggle
            on={echoGuardEnabled}
            label="Echo guard"
            onChange={setEchoGuardEnabled}
          />
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-echo-duck">
            Echo guard duck level {Math.round(echoGuardDuckFactor * 100)}%
          </label>
          <input
            id="voice-echo-duck"
            type="range"
            min={0}
            max={1}
            step={0.05}
            style={s.slider}
            value={echoGuardDuckFactor}
            disabled={!echoGuardEnabled}
            onChange={(e) => setEchoGuardDuckFactor(Number(e.target.value))}
          />
          <p style={s.hint}>
            How much the sent mic level is turned down while she is speaking (and for 400 ms
            after). Lower is safer against echo but also quieter for a real interruption to cut
            through; 15% is the default.
          </p>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-bargein-energy">
            Barge-in loudness bar {bargeInEnergyThreshold}
          </label>
          <input
            id="voice-bargein-energy"
            type="range"
            min={500}
            max={8000}
            step={100}
            style={s.slider}
            value={bargeInEnergyThreshold}
            onChange={(e) => setBargeInEnergyThreshold(Number(e.target.value))}
          />
          <p style={s.hint}>
            How loud, in raw mic energy, a sound has to be while she's thinking or speaking
            before it can count as you talking over her. The server also raises this
            automatically above whatever it measures as your own echo level, so loud speaker
            volume can't defeat it; this is the floor. Default 2000 (4x normal listening
            sensitivity).
          </p>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-bargein-ms">
            Barge-in hold time {bargeInMinSpeechMs} ms
          </label>
          <input
            id="voice-bargein-ms"
            type="range"
            min={100}
            max={800}
            step={50}
            style={s.slider}
            value={bargeInMinSpeechMs}
            onChange={(e) => setBargeInMinSpeechMs(Number(e.target.value))}
          />
          <p style={s.hint}>
            How long a loud sound has to keep going, continuously, before it's treated as a real
            interruption instead of a click or a stray echo. Lower interrupts faster but is more
            likely to catch a brief noise; default 300 ms.
          </p>
        </div>
      </div>

      <div style={s.card}>
        {/* S16: everything that makes a spoken turn start sooner. */}
        <div style={s.spread}>
          <span style={s.fieldLabel}>Warm engine (faster replies)</span>
          <Toggle
            on={voice.warmEngine ?? true}
            label="Warm engine (faster replies)"
            onChange={(next) => patch({ warmEngine: next })}
          />
        </div>
        <p style={s.hint}>
          Keeps one engine process alive for the whole voice chat instead of
          starting a new one every time you speak, which is where most of the
          wait before her first word used to go. Falls back to the normal path
          for engines that cannot run warm.
        </p>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-partials">Live transcript while you talk</label>
          <select
            id="voice-partials"
            style={{ ...s.select, width: '100%' }}
            value={voice.partials ?? 'local'}
            onChange={(e) => patch({ partials: e.target.value as MedusaVoice['partials'] })}
          >
            <option value="local">Local (re-transcribes as you speak)</option>
            <option value="deepgram">Deepgram streaming (needs a key)</option>
            <option value="off">Off</option>
          </select>
          <p style={s.hint}>
            The local option re-runs the whole utterance through your own voice
            server about every {loop?.defaults?.partialIntervalMs ?? 700} ms, so
            it costs nothing but a little CPU.
          </p>
        </div>

        <div style={s.spread}>
          <span style={s.fieldLabel}>Answer before you finish (speculative start)</span>
          <Toggle
            on={voice.speculativeStart ?? true}
            label="Answer before you finish"
            onChange={(next) => patch({ speculativeStart: next })}
          />
        </div>
        <p style={s.hint}>
          When the live transcript has held still for about
          {' '}{loop?.defaults?.speculationStableMs ?? 400} ms and reads like a
          finished thought, she starts thinking on it. If what you actually said
          turns out to be different, that turn is dropped and she starts again.
        </p>

        <div style={s.spread}>
          <span style={s.fieldLabel}>Speak the first clause early</span>
          <Toggle
            on={voice.firstClauseAudio ?? true}
            label="Speak the first clause early"
            onChange={(next) => patch({ firstClauseAudio: next })}
          />
        </div>
        <p style={s.hint}>
          Sends the opening clause (up to
          {' '}{loop?.defaults?.firstClauseChars ?? 60} characters) to the voice
          server as soon as it exists, rather than waiting for a whole sentence.
        </p>

        <div style={s.row}>
          <button style={s.btnPrimary} onClick={handleSave}>Save live settings</button>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-model-override">
            Voice model override (this chat)
          </label>
          <select
            id="voice-model-override"
            style={{ ...s.select, width: '100%' }}
            value={activeSession?.voiceModel ?? ''}
            disabled={!activeSession}
            onChange={(e) => void handleVoiceModelChange(e.target.value)}
          >
            <option value="">Use the chat's model</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
                {m.cheap ? ' · cheap' : ''}
              </option>
            ))}
          </select>
          <p style={s.hint}>
            Runs a different (for example faster) model for voice turns in this chat only.
          </p>
          {voiceModelStatus && <p style={s.note}>{voiceModelStatus}</p>}
        </div>
      </div>

      {/* S17: Live voice. Voice always works; this only picks which tier. */}
      <div style={s.card}>
        <div style={s.spread}>
          <span style={s.fieldLabel}>Live voice</span>
          <span
            style={{
              ...s.hint,
              color: activeTier === 'live' ? '#4aa8ff' : 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.3,
            }}
          >
            {activeTier === 'live' ? 'Live' : 'Local'}
          </span>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-live-tier">Tier</label>
          <select
            id="voice-live-tier"
            style={{ ...s.select, width: '100%' }}
            value={liveTier}
            onChange={(e) => patch({ liveTier: e.target.value as 'auto' | 'pipeline' | 'live' })}
          >
            <option value="auto">Auto (best available)</option>
            <option value="pipeline">Pipeline only (local Whisper and Kokoro)</option>
            <option value="live">Live only (fall back if the key is missing)</option>
          </select>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-live-provider">Provider</label>
          <select
            id="voice-live-provider"
            style={{ ...s.select, width: '100%' }}
            value={liveProviderId}
            onChange={(e) => patch({ liveProvider: e.target.value, liveModel: '' })}
          >
            {realtimeProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
                {p.ready ? '' : ' · no key'}
              </option>
            ))}
          </select>
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="voice-live-model">Model</label>
          <select
            id="voice-live-model"
            style={{ ...s.select, width: '100%' }}
            value={voice.liveModel ?? ''}
            onChange={(e) => patch({ liveModel: e.target.value })}
          >
            <option value="">
              Default{selectedRealtime?.defaultModel ? ` (${selectedRealtime.defaultModel})` : ''}
            </option>
            {modelOptionsLive.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <p style={s.hint}>
          Live voice is true speech to speech: your voice goes straight to a
          realtime model and its voice comes straight back, instead of being
          transcribed, answered and re-synthesized. She still keeps Medusa's own
          tools (spawn_agent, agent_status, agent_result, list_agents,
          cancel_agent), so subagents run here as usual and both sides of the
          conversation land in the chat as normal messages. If the realtime
          service fails mid-conversation she says so and drops to the local
          pipeline, so voice never stops working.
        </p>
        {tierReason && <p style={s.hint}>{tierReason}</p>}
        {showFreeHint && (
          <p style={s.hint}>
            Live voice is free with a Google AI Studio key.{' '}
            <a href={freeKeyUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
              Get one here
            </a>
            , then add it as <code>providers.gemini.apiKey</code> in{' '}
            <code>~/.claude-chat/settings.json</code>, or set{' '}
            <code>GEMINI_API_KEY</code>.
          </p>
        )}
        {selectedRealtime?.reason && <p style={s.hint}>{selectedRealtime.reason}</p>}

        <div style={s.row}>
          <button style={s.btnPrimary} onClick={handleSave}>
            Save live voice
          </button>
        </div>
      </div>
    </div>
  );
}
