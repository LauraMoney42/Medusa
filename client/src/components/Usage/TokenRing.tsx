import { useState, useEffect, useRef } from 'react';
import { fetchTokenUsage, type TokenUsagePeriod } from '../../api';

// Read the user-configured daily budget (USD) from localStorage, falling back to 20.
// Only accept a positive, finite number; otherwise use the default.
function getDailyBudget(): number {
  try {
    const raw = localStorage.getItem('medusa-daily-budget');
    if (raw != null) {
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // localStorage may be unavailable (private mode, etc.) — fall through to default.
  }
  return 20;
}

// Compact cost formatting: no decimals once we hit triple digits to keep the ring center tidy.
function formatCost(cost: number): string {
  if (cost >= 100) return `$${Math.round(cost)}`;
  return `$${cost.toFixed(2)}`;
}

// SVG geometry for the ring. Kept as module constants so we only compute the
// circumference once.
const RING_SIZE = 32;
const RING_STROKE = 4;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const ACCENT_GREEN = '#4aba6a';

export default function TokenRing() {
  const [day, setDay] = useState<TokenUsagePeriod | null>(null);
  const [week, setWeek] = useState<TokenUsagePeriod | null>(null);
  const [month, setMonth] = useState<TokenUsagePeriod | null>(null);
  const [hasError, setHasError] = useState(false);
  const [open, setOpen] = useState(false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Poll usage on mount and every 30s. On error we keep the last good data
  // (never overwrite state with nulls) and flip the error flag so the center
  // can show dashes if we have nothing yet.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [d, w, m] = await Promise.all([
          fetchTokenUsage('day'),
          fetchTokenUsage('week'),
          fetchTokenUsage('month'),
        ]);
        if (cancelled) return;
        setDay(d);
        setWeek(w);
        setMonth(m);
        setHasError(false);
      } catch {
        if (cancelled) return;
        // Keep the last good data; just note that the latest fetch failed.
        setHasError(true);
      }
    }

    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Close the popover on outside click (while open) and on Escape.
  useEffect(() => {
    if (!open) return;

    function onWindowClick(e: MouseEvent) {
      if (wrapperRef.current && e.target instanceof Node && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }

    window.addEventListener('click', onWindowClick);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', onWindowClick);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const dailyBudget = getDailyBudget();
  const todayCost = day?.totalCostUsd ?? 0;
  const fraction = Math.min(1, dailyBudget > 0 ? todayCost / dailyBudget : 0);
  const dashOffset = RING_CIRCUMFERENCE * (1 - fraction);

  // Center label: dashes when we have no data at all and the last fetch failed.
  const centerLabel = day == null && hasError ? '--' : formatCost(todayCost);

  // Top bots this week, sorted by cost desc, top 5.
  const topBots = week
    ? Object.entries(week.byBot)
        .sort((a, b) => b[1].costUsd - a[1].costUsd)
        .slice(0, 5)
    : [];

  // Toggle the popover. Stop propagation so the window click-away listener
  // (registered on the same click) doesn't immediately re-close it.
  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    setOpen((v) => !v);
  }

  function renderPeriodRow(label: string, data: TokenUsagePeriod | null) {
    return (
      <div style={styles.row}>
        <span style={styles.rowLabel}>{label}</span>
        <span style={styles.rowValues}>
          <span style={styles.cost}>{data ? formatCost(data.totalCostUsd) : '--'}</span>
          <span style={styles.msgs}>{data ? `${data.totalMessages} msgs` : '-- msgs'}</span>
        </span>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} style={styles.wrapper}>
      <button
        type="button"
        onClick={handleToggle}
        style={styles.ringButton}
        aria-label={`Token usage: ${centerLabel} today`}
        aria-expanded={open}
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={RING_STROKE}
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke={ACCENT_GREEN}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </svg>
        <span style={styles.centerLabel}>{centerLabel}</span>
      </button>

      {open && (
        <div style={styles.popover} role="dialog" aria-label="Usage breakdown">
          <div style={styles.header}>Usage</div>

          {renderPeriodRow('Today', day)}
          {renderPeriodRow('This Week', week)}
          {renderPeriodRow('This Month', month)}

          <div style={styles.section}>
            <div style={styles.sectionTitle}>Top bots (this week)</div>
            {topBots.length > 0 ? (
              topBots.map(([name, stats]) => (
                <div key={name} style={styles.botRow}>
                  <span style={styles.botName}>{name}</span>
                  <span style={styles.cost}>{formatCost(stats.costUsd)}</span>
                </div>
              ))
            ) : (
              <div style={styles.empty}>No data</div>
            )}
          </div>

          <div style={styles.footnote}>Reflects logged API cost.</div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'relative',
    display: 'inline-flex',
  },
  ringButton: {
    position: 'relative',
    width: RING_SIZE,
    height: RING_SIZE,
    padding: 0,
    margin: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  },
  centerLabel: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    fontSize: 8,
    fontWeight: 600,
    color: 'var(--text-primary)',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  },
  popover: {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    right: 0,
    background: '#2c2c2e',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 'var(--radius)',
    padding: 12,
    boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
    minWidth: 240,
    zIndex: 300,
    fontSize: 13,
    color: 'var(--text-primary)',
  },
  header: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 8,
  },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    padding: '3px 0',
  },
  rowLabel: {
    color: 'var(--text-secondary)',
    fontSize: 12,
  },
  rowValues: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: 8,
  },
  cost: {
    color: ACCENT_GREEN,
    fontWeight: 600,
    fontSize: 12,
  },
  msgs: {
    color: 'var(--text-muted)',
    fontSize: 11,
  },
  section: {
    marginTop: 10,
    paddingTop: 8,
    borderTop: '1px solid rgba(255,255,255,0.08)',
  },
  sectionTitle: {
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 4,
  },
  botRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    padding: '2px 0',
  },
  botName: {
    color: 'var(--text-primary)',
    fontSize: 12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 160,
  },
  empty: {
    color: 'var(--text-muted)',
    fontSize: 12,
  },
  footnote: {
    marginTop: 10,
    color: 'var(--text-muted)',
    fontSize: 11,
  },
};
