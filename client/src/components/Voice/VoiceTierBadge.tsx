import { useEffect, useState } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSettingsTabStore } from '../../stores/settingsTabStore';
import { fetchVoiceLoopStatus } from '../../api';

/**
 * The tier label that sits beside the mic (S17).
 *
 * The product rule is that voice always works and Medusa says which tier she
 * is on: "Live" when a realtime speech-to-speech model is driving the
 * conversation, "Local" when the Whisper/Kokoro pipeline is. The `reason` the
 * server sends is shown as the tooltip, because on the local tier it is also
 * the sentence that says how to move up for free.
 *
 * Nothing renders until `voice:tier` arrives, so an older server, or a chat
 * with voice switched off, looks exactly as it did before.
 *
 * W8: when the badge reads Local, a quick check of GET /api/voice/status
 * says whether ANY realtime provider has a key at all. If none do, a small
 * banner underneath points at Settings > Providers instead of leaving the
 * owner to guess why Live voice never engages (this is exactly the "tried
 * to enable Gemini Live and nothing happened" gap this workstream closes).
 */
export default function VoiceTierBadge() {
  const tier = useVoiceStore((s) => s.tier);
  const reason = useVoiceStore((s) => s.tierReason);
  const model = useVoiceStore((s) => s.tierModel);
  const active = useVoiceStore((s) => s.active);
  const mode = useVoiceStore((s) => s.mode);
  const requestSettingsTab = useSettingsTabStore((st) => st.requestTab);

  const [hasRealtimeKey, setHasRealtimeKey] = useState<boolean | null>(null);
  const live = tier === 'live';
  const showLocal = tier === 'pipeline';

  useEffect(() => {
    if (!showLocal) return;
    let cancelled = false;
    fetchVoiceLoopStatus()
      .then((status) => {
        if (cancelled) return;
        const providers = status.realtime?.providers ?? [];
        setHasRealtimeKey(providers.some((p) => p.ready));
      })
      .catch(() => { if (!cancelled) setHasRealtimeKey(null); });
    return () => { cancelled = true; };
  }, [showLocal]);

  if (!tier || (!active && mode === 'off')) return null;

  return (
    <span style={styles.wrap}>
      <span
        title={[reason, live && model ? model : null].filter(Boolean).join('\n')}
        data-voice-tier={tier}
        style={{
          ...styles.badge,
          color: live ? '#4aa8ff' : 'var(--text-muted)',
          borderColor: live ? 'rgba(74, 168, 255, 0.45)' : 'var(--border, rgba(128,128,128,0.3))',
        }}
      >
        {live ? 'Live' : 'Local'}
      </span>
      {showLocal && hasRealtimeKey === false && (
        <button
          type="button"
          onClick={() => requestSettingsTab('providers')}
          style={styles.banner}
          title="Open Settings > Providers"
        >
          Local voice. Add a Gemini key in Settings &gt; Providers for live speech
        </button>
      )}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'relative',
    display: 'inline-flex',
    flexShrink: 0,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 18,
    padding: '0 6px',
    borderRadius: 9,
    border: '1px solid',
    background: 'transparent',
    fontSize: 10,
    lineHeight: '18px',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    flexShrink: 0,
    userSelect: 'none',
    cursor: 'default',
  },
  // Taken out of flow (absolute) so it never widens the flex row the badge
  // and mic button share; it just floats under the badge.
  banner: {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: 4,
    width: 220,
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid rgba(74, 168, 255, 0.35)',
    background: 'var(--bg-secondary, #232325)',
    color: 'var(--text-secondary)',
    fontSize: 10,
    lineHeight: 1.4,
    textAlign: 'left',
    textTransform: 'none',
    letterSpacing: 'normal',
    cursor: 'pointer',
    zIndex: 20,
  },
};
