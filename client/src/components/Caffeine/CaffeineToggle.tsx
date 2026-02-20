import { useState, useEffect, useCallback } from 'react';

/**
 * Caffeine toggle — prevents macOS from sleeping while enabled.
 * Sits fixed in the top-right corner. No label; identity comes from
 * the coffee cup icon. Tooltip appears on hover.
 *
 * Server runs `caffeinate -d -i` when enabled, released immediately on disable.
 */
export default function CaffeineToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    fetch('/api/caffeine/status')
      .then((r) => r.json())
      .then((data: { enabled: boolean }) => setEnabled(data.enabled))
      .catch(() => {});
  }, []);

  const toggle = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = enabled ? '/api/caffeine/disable' : '/api/caffeine/enable';
      const res = await fetch(endpoint, { method: 'POST' });
      const data: { enabled: boolean } = await res.json();
      setEnabled(data.enabled);
    } catch {
      // non-fatal — don't flip state on error
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        right: 14,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Hover tooltip */}
      {hovered && (
        <div style={tooltipStyle}>
          {/* Arrow pointing up toward the control */}
          <div style={tooltipArrowStyle} />
          <span style={{ fontWeight: 700, color: enabled ? 'var(--accent)' : 'var(--text-primary)', display: 'block', marginBottom: 3 }}>
            Caffeine {enabled ? 'ON' : 'OFF'}
          </span>
          {enabled
            ? 'Your computer will stay awake while Medusa works.'
            : 'Toggle on to keep your computer awake while Medusa works.'}
        </div>
      )}

      {/* Coffee cup — inline SVG, matches camera icon style exactly */}
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          color: 'var(--text-secondary)',
          flexShrink: 0,
          pointerEvents: 'none',
        }}
        aria-hidden="true"
      >
        {/* Steam wisps */}
        <path d="M8 2c0 1.2-1.5 1.8-1.5 3" />
        <path d="M12.5 2c0 1.2-1.5 1.8-1.5 3" />
        {/* Cup body — slight trapezoid taper */}
        <path d="M4.5 7h15l-1.8 10.2a1 1 0 0 1-1 .8H7.3a1 1 0 0 1-1-.8L4.5 7z" />
        {/* Handle */}
        <path d="M18 10.5h1.5a2 2 0 0 1 0 4H18" />
        {/* Saucer line */}
        <line x1="2.5" y1="21" x2="21.5" y2="21" />
      </svg>

      {/* iPhone-style toggle */}
      <button
        onClick={toggle}
        disabled={loading}
        role="switch"
        aria-checked={enabled}
        style={{
          position: 'relative',
          width: 34,
          height: 20,
          borderRadius: 10,
          background: enabled ? 'var(--accent)' : 'rgba(255,255,255,0.13)',
          border: 'none',
          padding: 0,
          cursor: loading ? 'wait' : 'pointer',
          transition: 'background 0.2s ease',
          flexShrink: 0,
          outline: 'none',
          boxShadow: enabled ? 'none' : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
        } as React.CSSProperties}
      >
        {/* Thumb */}
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: enabled ? 16 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#ffffff',
            boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
            transition: 'left 0.22s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
            pointerEvents: 'none',
          } as React.CSSProperties}
        />
      </button>
    </div>
  );
}

const tooltipStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 10px)',
  right: 0,
  width: 218,
  padding: '9px 12px',
  borderRadius: 8,
  background: 'rgba(18, 18, 22, 0.96)',
  border: '1px solid rgba(255, 255, 255, 0.09)',
  boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.55,
  pointerEvents: 'none',
  textAlign: 'left',
  zIndex: 1001,
};

// Small notch pointing up at the toggle
const tooltipArrowStyle: React.CSSProperties = {
  position: 'absolute',
  top: -5,
  right: 18,
  width: 9,
  height: 9,
  background: 'rgba(18, 18, 22, 0.96)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderBottom: 'none',
  borderRight: 'none',
  transform: 'rotate(45deg)',
};
