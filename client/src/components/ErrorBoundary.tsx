import { Component } from 'react';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary to catch React rendering errors and prevent white screen crashes.
 * Wraps critical sections of the app with graceful error handling.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={styles.container}>
          <div style={styles.card}>
            <h2 style={styles.title}>⚠️ Something went wrong</h2>
            <p style={styles.message}>
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <button
              onClick={() => window.location.reload()}
              style={styles.button}
            >
              Reload App
            </button>
            <details style={styles.details}>
              <summary style={styles.summary}>Error details</summary>
              <pre style={styles.pre}>
                {this.state.error?.stack}
              </pre>
            </details>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
    padding: '40px',
    backgroundColor: 'var(--bg-darker)',
  },
  card: {
    maxWidth: '600px',
    padding: '32px',
    backgroundColor: 'var(--bg-dark)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    textAlign: 'center',
  },
  title: {
    margin: '0 0 16px 0',
    color: 'var(--text)',
    fontSize: '24px',
    fontWeight: 600,
  },
  message: {
    margin: '0 0 24px 0',
    color: 'var(--text-muted)',
    fontSize: '14px',
    lineHeight: 1.6,
  },
  button: {
    padding: '12px 24px',
    backgroundColor: 'var(--accent)',
    color: 'var(--bg-darker)',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'opacity 0.2s',
  },
  details: {
    marginTop: '24px',
    textAlign: 'left',
  },
  summary: {
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: '12px',
    marginBottom: '8px',
  },
  pre: {
    backgroundColor: 'var(--bg-darker)',
    padding: '16px',
    borderRadius: '4px',
    overflow: 'auto',
    fontSize: '11px',
    color: 'var(--text-muted)',
    maxHeight: '200px',
  },
};
