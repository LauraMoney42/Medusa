import { useVoiceStore } from '../../stores/voiceStore';

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
 */
export default function VoiceTierBadge() {
  const tier = useVoiceStore((s) => s.tier);
  const reason = useVoiceStore((s) => s.tierReason);
  const model = useVoiceStore((s) => s.tierModel);
  const active = useVoiceStore((s) => s.active);
  const mode = useVoiceStore((s) => s.mode);

  if (!tier || (!active && mode === 'off')) return null;

  const live = tier === 'live';
  return (
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
  );
}

const styles: Record<string, React.CSSProperties> = {
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
};
