import { useEffect, useState, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts';

type PeriodName = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month';

interface PeriodSummary {
  label: string;
  from: string;
  to: string;
  totalCostUsd: number;
  totalMessages: number;
  byBot: Record<string, { costUsd: number; messages: number }>;
}

interface CompareResponse {
  a: PeriodSummary;
  b: PeriodSummary;
}

const PERIOD_OPTIONS: { value: PeriodName; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This Week' },
  { value: 'last_week', label: 'Last Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
];

async function fetchCompare(a: PeriodName, b: PeriodName): Promise<CompareResponse> {
  const res = await fetch(`/api/metrics/compare?a=${a}&b=${b}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Compare fetch failed: ${res.status}`);
  return res.json() as Promise<CompareResponse>;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.001) return `$${(usd * 1000).toFixed(2)}m`;
  return `$${usd.toFixed(4)}`;
}

/** Custom tooltip for the recharts bar chart */
function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; fill: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div style={tooltipStyles.container}>
      <div style={tooltipStyles.label}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={tooltipStyles.row}>
          <span style={{ ...tooltipStyles.dot, background: p.fill }} />
          <span style={tooltipStyles.name}>{p.name}:</span>
          <span style={tooltipStyles.value}>{formatCost(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

const tooltipStyles: Record<string, React.CSSProperties> = {
  container: {
    background: '#2c2c2e',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 12,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  label: { fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  name: { color: 'var(--text-muted)', flex: 1 },
  value: { color: 'var(--text-primary)', fontWeight: 600 },
};

export default function ComparisonChart() {
  const [periodA, setPeriodA] = useState<PeriodName>('today');
  const [periodB, setPeriodB] = useState<PeriodName>('yesterday');
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (a: PeriodName, b: PeriodName) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCompare(a, b);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(periodA, periodB);
  }, [periodA, periodB, load]);

  // Build chart data: one bar group per bot, two bars (A and B) per group
  // Also add a "Total" group
  const chartData = (() => {
    if (!data) return [];

    const allBots = new Set([
      ...Object.keys(data.a.byBot),
      ...Object.keys(data.b.byBot),
    ]);

    const rows = [...allBots].map((bot) => ({
      name: bot,
      [data.a.label]: data.a.byBot[bot]?.costUsd ?? 0,
      [data.b.label]: data.b.byBot[bot]?.costUsd ?? 0,
    }));

    // Sort by combined cost descending
    rows.sort((x, y) => {
      const xTotal = (x[data.a.label] as number) + (x[data.b.label] as number);
      const yTotal = (y[data.a.label] as number) + (y[data.b.label] as number);
      return yTotal - xTotal;
    });

    // Add summary row at top
    return [
      {
        name: 'Total',
        [data.a.label]: data.a.totalCostUsd,
        [data.b.label]: data.b.totalCostUsd,
      },
      ...rows,
    ];
  })();

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Comparison</span>
        {/* Period pickers */}
        <div style={styles.pickers}>
          <select
            value={periodA}
            onChange={(e) => setPeriodA(e.target.value as PeriodName)}
            style={styles.select}
          >
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span style={styles.vs}>vs</span>
          <select
            value={periodB}
            onChange={(e) => setPeriodB(e.target.value as PeriodName)}
            style={styles.select}
          >
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Summary stats above chart */}
      {data && !loading && (
        <div style={styles.statsRow}>
          <div style={styles.statCard}>
            <span style={{ ...styles.statLabel, color: '#4aba6a' }}>{data.a.label}</span>
            <span style={styles.statCost}>{formatCost(data.a.totalCostUsd)}</span>
            <span style={styles.statMsgs}>{data.a.totalMessages} msgs</span>
          </div>
          <div style={styles.statDivider}>vs</div>
          <div style={styles.statCard}>
            <span style={{ ...styles.statLabel, color: '#60a5fa' }}>{data.b.label}</span>
            <span style={styles.statCost}>{formatCost(data.b.totalCostUsd)}</span>
            <span style={styles.statMsgs}>{data.b.totalMessages} msgs</span>
          </div>
        </div>
      )}

      {/* Bar chart */}
      <div style={styles.chartWrap}>
        {loading ? (
          <div style={styles.loadingText}>Loading...</div>
        ) : chartData.length === 0 ? (
          <div style={styles.loadingText}>No data for selected periods</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="name"
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={formatCost}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
              <Legend
                wrapperStyle={{ fontSize: 12, color: 'var(--text-muted)', paddingTop: 4 }}
              />
              {data && (
                <>
                  <Bar dataKey={data.a.label} fill="#4aba6a" radius={[3, 3, 0, 0]} maxBarSize={40} />
                  <Bar dataKey={data.b.label} fill="#60a5fa" radius={[3, 3, 0, 0]} maxBarSize={40} />
                </>
              )}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: '#232325',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 'var(--radius-md, 10px)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    flexWrap: 'wrap' as const,
    gap: 8,
  },
  title: {
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  pickers: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  select: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6,
    color: 'var(--text-secondary)',
    fontSize: 12,
    padding: '4px 8px',
    cursor: 'pointer',
    outline: 'none',
  },
  vs: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    letterSpacing: '0.05em',
  },
  error: {
    fontSize: 12,
    color: 'var(--danger)',
    padding: '8px 14px',
    background: 'rgba(239,68,68,0.08)',
  },
  statsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
    padding: '10px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
  },
  statCard: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  statLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.04em',
  },
  statCost: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--text-primary)',
    letterSpacing: '-0.02em',
  },
  statMsgs: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  statDivider: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    padding: '0 16px',
    letterSpacing: '0.04em',
  },
  chartWrap: {
    padding: '12px 4px 8px',
  },
  loadingText: {
    padding: '32px 14px',
    fontSize: 13,
    color: 'var(--text-muted)',
    textAlign: 'center' as const,
  },
};
