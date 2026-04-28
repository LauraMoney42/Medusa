import { useEffect, useState } from 'react';

interface LaunchScreenProps {
  onDismiss: () => void;
}

/**
 * Full-viewport launch splash shown on cold start.
 * Auto-dismisses after 1.8s with a fade-out.
 * Uses sessionStorage so it shows once per browser session (not every nav).
 */
export default function LaunchScreen({ onDismiss }: LaunchScreenProps) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    // Start fade-out at 1.4s, remove at 1.8s
    const fadeTimer = setTimeout(() => setFading(true), 1400);
    const dismissTimer = setTimeout(() => onDismiss(), 1800);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(dismissTimer);
    };
  }, [onDismiss]);

  return (
    <div
      style={{
        ...styles.overlay,
        opacity: fading ? 0 : 1,
        transition: fading ? 'opacity 0.4s ease-out' : 'none',
      }}
      onClick={onDismiss}
    >
      <div style={styles.card}>
        {/* Medusa icon */}
        <img
          src="/MedusaIcon.png"
          alt="Medusa"
          style={styles.icon}
        />

        {/* App name */}
        <h1 style={styles.title}>Medusa</h1>

        {/* Tagline */}
        <p style={styles.tagline}>AI-Powered Development Hub</p>

        {/* About blurb */}
        <p style={styles.about}>
          Coordinate your dev team, track projects, and ship faster —
          with AI bots that work while you sleep.
        </p>

        {/* Version / tap hint */}
        <p style={styles.hint}>Tap anywhere to continue</p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    background: '#0d0d0f',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: '48px 40px',
    maxWidth: 400,
    textAlign: 'center',
  },
  icon: {
    width: 96,
    height: 96,
    borderRadius: '50%',
    border: '2px solid rgba(74, 186, 106, 0.4)',
    boxShadow: '0 0 48px rgba(74, 186, 106, 0.25), 0 0 16px rgba(74, 186, 106, 0.1)',
    marginBottom: 8,
  },
  title: {
    fontSize: 32,
    fontWeight: 800,
    color: '#4aba6a',
    margin: 0,
    letterSpacing: '0.02em',
  },
  tagline: {
    fontSize: 14,
    fontWeight: 500,
    color: 'rgba(255,255,255,0.6)',
    margin: 0,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  },
  about: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.45)',
    lineHeight: 1.6,
    margin: '12px 0 0',
  },
  hint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.2)',
    margin: '20px 0 0',
    letterSpacing: '0.03em',
  },
};
