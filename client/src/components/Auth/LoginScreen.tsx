import { useState, type FormEvent } from 'react';
import { login } from '../../api';

interface LoginScreenProps {
  onLogin: () => void;
}

export default function LoginScreen({ onLogin }: LoginScreenProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError('Please enter an auth token');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await login(trimmed);
      // Server validated the token and set an httpOnly cookie.
      // Nothing is stored in localStorage.
      onLogin();
    } catch {
      setError('Invalid token');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.wrapper}>
      <form onSubmit={handleSubmit} style={styles.card}>

        {/* Logo */}
        <div style={styles.logoWrapper}>
          <img
            src="/MedusaIcon.png"
            alt="Medusa"
            style={styles.logo}
          />
        </div>

        <h1 style={styles.title}>Medusa</h1>
        <p style={styles.subtitle}>Enter your authentication token to connect</p>

        <input
          type="password"
          placeholder="Auth token"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setError('');
          }}
          style={styles.input}
          autoFocus
        />

        {error && <p style={styles.error}>{error}</p>}

        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? 'Connecting…' : 'Connect'}
        </button>

        {/* Credits */}
        <div style={styles.credits}>
          <span style={styles.creditText}>Created by </span>
          <a
            href="https://www.linkedin.com/in/laura-money/"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.creditLink}
          >
            Laura Money
          </a>
          <span style={styles.creditDivider}> · </span>
          <a
            href="https://kindcode.us/"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.creditLink}
          >
            KindCode
          </a>
        </div>

      </form>
    </div>
  );
}

const MEDUSA_GREEN = '#1A4D2E';

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    background: '#141416',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: 44,
    background: '#1c1c1e',
    borderRadius: 'var(--radius-lg, 18px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 12px 48px rgba(0, 0, 0, 0.5)',
    width: 400,
    maxWidth: '90vw',
    alignItems: 'center',
  } as React.CSSProperties,
  logoWrapper: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 4,
  },
  logo: {
    width: 120,
    height: 120,
    objectFit: 'contain',
    filter: 'drop-shadow(0 0 24px rgba(26, 122, 60, 0.35))',
  } as React.CSSProperties,
  title: {
    fontSize: 32,
    fontWeight: 700,
    color: MEDUSA_GREEN,
    textAlign: 'center' as const,
    textShadow: '0 0 20px rgba(26, 122, 60, 0.25)',
    margin: 0,
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--text-secondary)',
    textAlign: 'center' as const,
    margin: 0,
  },
  input: {
    width: '100%',
    padding: '12px 16px',
    background: 'rgba(0, 0, 0, 0.25)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 15,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  error: {
    color: 'var(--danger)',
    fontSize: 13,
    margin: 0,
  },
  button: {
    width: '100%',
    padding: '12px 0',
    background: 'var(--accent)',
    color: '#fff',
    borderRadius: 'var(--radius-sm)',
    fontWeight: 600,
    fontSize: 15,
    transition: 'background 0.15s',
    cursor: 'pointer',
    border: 'none',
  } as React.CSSProperties,
  credits: {
    marginTop: 8,
    fontSize: 12,
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
  },
  creditText: {
    color: 'var(--text-muted)',
  },
  creditLink: {
    color: MEDUSA_GREEN,
    textDecoration: 'none',
    fontWeight: 500,
    transition: 'opacity 0.15s',
  } as React.CSSProperties,
  creditDivider: {
    color: 'var(--text-muted)',
    margin: '0 2px',
  },
};
