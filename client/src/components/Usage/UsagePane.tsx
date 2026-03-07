import { useEffect, useState, useCallback } from 'react';
import { fetchTokenUsage, type TokenUsagePeriod } from '../../api';

interface UsagePaneProps {
  onMenuToggle?: () => void;
}

type Period = 'day' | 'week' | 'month';

const PERIOD_LABELS: Record<Period, string> = {
  day: 'Today',
  week: 'This Week',
  month: 'This Month',
};

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatMessages(n: number): string {
  return n.toLocaleString();
}

export default function UsagePane({ onMenuToggle }: UsagePaneProps) {
  const [period, setPeriod] = useState<Period>('day');
  const [data, setData] = useState<TokenUsagePeriod | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTokenUsage(p);
      setData(result);
    } catch (err) {
      setError('Failed to load usage data');
      console.error('[UsagePane] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [period, load]);

  const byBotEntries = data
    ? Object.entries(data.byBot).sort((a, b) => b[1].costUsd - a[1].costUsd)
    : [];

  return (
    <div style={styles.container}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div className="mobile-header" style={styles.mobileHeader}>
          <button onClick={onMenuToggle} style={styles.menuBtn}>&#9776;</button>
        </div>
        <span style={styles.title}>Token Usage</span>
        {/* Period selector */}
        <div style={styles.periodGroup}>
          {(['day', 'week', 'month'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                ...styles.periodBtn,
                background: period === p ? 'rgba(74, 186, 106, 0.15)' : 'transparent',
                color: period === p ? '#4aba6a' : 'var(--text-muted)',
                borderColor: period === p ? 'rgba(74, 186, 106, 0.3)' : 'rgba(255,255,255,0.08)',
              }}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={styles.content}>
        {loading && <p style={styles.hint}>Loading...</p>}
        {error && <p style={styles.error}>{error}</p>}

        {data && !loading && (
          <>
            {/* Summary cards */}
            <div style={styles.cardRow}>
              <div style={styles.card}>
                <div style={styles.cardLabel}>Total Cost</div>
                <div style={styles.cardValue}>{formatCost(data.totalCostUsd)}</div>
                <div style={styles.cardSub}>{PERIOD_LABELS[period]}</div>
              </div>
              <div style={styles.card}>
                <div style={styles.cardLabel}>Messages</div>
                <div style={styles.cardValue}>{formatMessages(data.totalMessages)}</div>
                <div style={styles.cardSub}>Claude CLI calls</div>
              </div>
              <div style={styles.card}>
                <div style={styles.cardLabel}>Avg Cost</div>
                <div style={styles.cardValue}>
                  {data.totalMessages > 0
                    ? formatCost(data.totalCostUsd / data.totalMessages)
                    : '$0.00'}
                </div>
                <div style={styles.cardSub}>per message</div>
              </div>
            </div>

            {/* Per-bot breakdown table */}
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Cost by Bot</div>
              {byBotEntries.length === 0 ? (
                <p style={styles.hint}>No data for this period.</p>
              ) : (
                <div style={styles.table}>
                  <div style={styles.tableHeader}>
                    <span style={{ ...styles.col, flex: 2 }}>Bot</span>
                    <span style={styles.col}>Messages</span>
                    <span style={styles.col}>Cost</span>
                    <span style={styles.col}>% of Total</span>
                  </div>
                  {byBotEntries.map(([name, stats]) => {
                    const pct = data.totalCostUsd > 0
                      ? ((stats.costUsd / data.totalCostUsd) * 100).toFixed(1)
                      : '0.0';
                    return (
                      <div key={name} style={styles.tableRow}>
                        <span style={{ ...styles.col, flex: 2, color: 'var(--text-primary)', fontWeight: 500 }}>
                          {name}
                        </span>
                        <span style={styles.col}>{formatMessages(stats.messages)}</span>
                        <span style={{ ...styles.col, color: '#4aba6a' }}>{formatCost(stats.costUsd)}</span>
                        <span style={styles.col}>{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {!data && !loading && !error && (
          <p style={styles.hint}>No usage data yet. Start chatting with bots to see costs here.</p>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--bg-primary)',
    minWidth: 0,
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 130px 10px 16px', // paddingRight 130px clears fixed CaffeineToggle (top:12, right:14)
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(26, 26, 28, 0.75)',
    backdropFilter: 'blur(20px) saturate(1.2)',
    WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
    flexShrink: 0,
  } as React.CSSProperties,
  mobileHeader: { alignItems: 'center' },
  menuBtn: {
    fontSize: 20,
    padding: '4px 8px',
    color: 'var(--text-secondary)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
  },
  title: {
    fontSize: 15,
    fontWeight: 600,
    color: '#4aba6a',
    marginRight: 'auto',
  },
  periodGroup: {
    display: 'flex',
    gap: 4,
  },
  periodBtn: {
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
  } as React.CSSProperties,
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  } as React.CSSProperties,
  cardRow: {
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap',
  } as React.CSSProperties,
  card: {
    flex: '1 1 140px',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 'var(--radius-md, 10px)',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  } as React.CSSProperties,
  cardLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  } as React.CSSProperties,
  cardValue: {
    fontSize: 24,
    fontWeight: 700,
    color: '#4aba6a',
    lineHeight: 1.2,
  },
  cardSub: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    letterSpacing: '0.02em',
  },
  table: {
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 'var(--radius-md, 10px)',
    overflow: 'hidden',
  },
  tableHeader: {
    display: 'flex',
    padding: '8px 14px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    gap: 8,
  } as React.CSSProperties,
  tableRow: {
    display: 'flex',
    padding: '10px 14px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
    fontSize: 13,
    color: 'var(--text-secondary)',
    gap: 8,
    alignItems: 'center',
  },
  col: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  hint: {
    fontSize: 13,
    color: 'var(--text-muted)',
    textAlign: 'center',
    padding: '24px 0',
  } as React.CSSProperties,
  error: {
    fontSize: 13,
    color: 'var(--danger)',
    textAlign: 'center',
    padding: '16px 0',
  } as React.CSSProperties,
};
