import { useEffect, useState, useCallback } from 'react';
import ComparisonChart from './ComparisonChart';

interface PeriodData {
  period: string;
  from: string;
  to: string;
  totalCostUsd: number;
  totalMessages: number;
  totalDurationMs: number;
  byBot: Record<string, { costUsd: number; messages: number }>;
  bySource: Record<string, { costUsd: number; messages: number }>;
}

async function fetchUsage(period: 'day' | 'week' | 'month'): Promise<PeriodData> {
  const res = await fetch(`/api/token-usage?period=${period}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch usage: ${res.status}`);
  return res.json() as Promise<PeriodData>;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  return `$${usd.toFixed(4)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/** Single summary card for a time period */
function SummaryCard({ label, data, loading }: {
  label: string;
  data: PeriodData | null;
  loading: boolean;
}) {
  return (
    <div style={cardStyles.card}>
      <div style={cardStyles.label}>{label}</div>
      {loading || !data ? (
        <div style={cardStyles.loading}>—</div>
      ) : (
        <>
          <div style={cardStyles.cost}>{formatCost(data.totalCostUsd)}</div>
          <div style={cardStyles.meta}>{data.totalMessages} messages</div>
        </>
      )}
    </div>
  );
}

const cardStyles: Record<string, React.CSSProperties> = {
  card: {
    flex: 1,
    minWidth: 100,
    background: '#232325',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 'var(--radius-md, 10px)',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  label: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  cost: {
    fontSize: 22,
    fontWeight: 700,
    color: '#4aba6a',
    letterSpacing: '-0.02em',
  },
  meta: {
    fontSize: 12,
    color: 'var(--text-muted)',
  },
  loading: {
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--text-muted)',
  },
};

export default function UsageDashboard() {
  const [day, setDay] = useState<PeriodData | null>(null);
  const [week, setWeek] = useState<PeriodData | null>(null);
  const [month, setMonth] = useState<PeriodData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Which period's per-bot table to show
  const [tablePeriod, setTablePeriod] = useState<'day' | 'week' | 'month'>('week');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, w, m] = await Promise.all([
        fetchUsage('day'),
        fetchUsage('week'),
        fetchUsage('month'),
      ]);
      setDay(d);
      setWeek(w);
      setMonth(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tableData = tablePeriod === 'day' ? day : tablePeriod === 'week' ? week : month;
  const botRows = tableData
    ? Object.entries(tableData.byBot).sort((a, b) => b[1].costUsd - a[1].costUsd)
    : [];

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Token Usage</span>
        <button onClick={load} style={styles.refreshBtn} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {error && (
        <div style={styles.error}>{error}</div>
      )}

      {/* Summary cards */}
      <div style={styles.cards}>
        <SummaryCard label="Today" data={day} loading={loading} />
        <SummaryCard label="This Week" data={week} loading={loading} />
        <SummaryCard label="This Month" data={month} loading={loading} />
      </div>

      {/* Per-bot breakdown table */}
      <div style={styles.tableSection}>
        <div style={styles.tableHeader}>
          <span style={styles.tableTitle}>Per-bot breakdown</span>
          {/* Period picker */}
          <div style={styles.periodPicker}>
            {(['day', 'week', 'month'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setTablePeriod(p)}
                style={{
                  ...styles.periodBtn,
                  background: tablePeriod === p ? 'rgba(74, 186, 106, 0.15)' : 'transparent',
                  color: tablePeriod === p ? '#4aba6a' : 'var(--text-muted)',
                  border: tablePeriod === p ? '1px solid rgba(74, 186, 106, 0.3)' : '1px solid transparent',
                }}
              >
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div style={styles.loadingRow}>Loading...</div>
        ) : botRows.length === 0 ? (
          <div style={styles.emptyRow}>No data for this period</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.th, textAlign: 'left' as const }}>Bot</th>
                <th style={styles.th}>Messages</th>
                <th style={styles.th}>Cost</th>
                <th style={styles.th}>Avg/msg</th>
              </tr>
            </thead>
            <tbody>
              {botRows.map(([botName, stats]) => (
                <tr key={botName} style={styles.tr}>
                  <td style={{ ...styles.td, color: 'var(--text-primary)', fontWeight: 500 }}>
                    {botName}
                  </td>
                  <td style={{ ...styles.td, textAlign: 'center' as const }}>{stats.messages}</td>
                  <td style={{ ...styles.td, textAlign: 'right' as const, color: '#4aba6a', fontWeight: 600 }}>
                    {formatCost(stats.costUsd)}
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right' as const, color: 'var(--text-muted)' }}>
                    {formatCost(stats.messages > 0 ? stats.costUsd / stats.messages : 0)}
                  </td>
                </tr>
              ))}
            </tbody>
            {tableData && tableData.totalMessages > 0 && (
              <tfoot>
                <tr style={styles.totalRow}>
                  <td style={{ ...styles.td, fontWeight: 700, color: 'var(--text-secondary)' }}>Total</td>
                  <td style={{ ...styles.td, textAlign: 'center' as const, fontWeight: 700 }}>{tableData.totalMessages}</td>
                  <td style={{ ...styles.td, textAlign: 'right' as const, color: '#4aba6a', fontWeight: 700 }}>
                    {formatCost(tableData.totalCostUsd)}
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right' as const, color: 'var(--text-muted)' }}>
                    {formatDuration(tableData.totalDurationMs)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {/* Comparison chart */}
      <ComparisonChart />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflow: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  refreshBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    transition: 'color 0.15s',
  },
  error: {
    fontSize: 13,
    color: 'var(--danger)',
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.2)',
    borderRadius: 'var(--radius-sm)',
    padding: '8px 12px',
  },
  cards: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap' as const,
  },
  tableSection: {
    background: '#232325',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 'var(--radius-md, 10px)',
    overflow: 'hidden',
  },
  tableHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  },
  tableTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  periodPicker: {
    display: 'flex',
    gap: 4,
  },
  periodBtn: {
    padding: '3px 10px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s',
    letterSpacing: '0.02em',
  } as React.CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
  },
  th: {
    padding: '8px 14px',
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    textAlign: 'right' as const,
  },
  td: {
    padding: '9px 14px',
    fontSize: 13,
    color: 'var(--text-secondary)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
  },
  tr: {
    transition: 'background 0.1s',
  } as React.CSSProperties,
  totalRow: {
    borderTop: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.02)',
  } as React.CSSProperties,
  loadingRow: {
    padding: '20px 14px',
    fontSize: 13,
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
  },
  emptyRow: {
    padding: '20px 14px',
    fontSize: 13,
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
  },
};
