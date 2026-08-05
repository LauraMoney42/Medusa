import { useState, useEffect, useCallback } from 'react';
import { getSocket } from '../../socket';
import { fetchApprovals, approveRequest, denyRequest } from '../../api';
import type { ApprovalRequest } from '../../types/approval';

/**
 * Human-in-the-loop guardrail banner. Shows pending bot escalations
 * (`[HUB-POST: @You APPROVAL NEEDED: ...]`) as actionable Approve/Deny cards,
 * so a request can't be missed in a busy Hub feed. Self-contained socket
 * subscription (mirrors CoworkPane) — safe to mount in multiple views.
 */
export default function ApprovalBanner() {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchApprovals()
      .then((all) => { if (!cancelled) setPending(all.filter((a) => a.status === 'pending')); })
      .catch(() => {});

    const socket = getSocket();
    const onNew = (approval: ApprovalRequest) => {
      setPending((prev) => (prev.some((p) => p.id === approval.id) ? prev : [approval, ...prev]));
    };
    const onResolved = (approval: ApprovalRequest) => {
      setPending((prev) => prev.filter((p) => p.id !== approval.id));
    };
    socket.on('approval:new', onNew);
    socket.on('approval:resolved', onResolved);
    return () => {
      cancelled = true;
      socket.off('approval:new', onNew);
      socket.off('approval:resolved', onResolved);
    };
  }, []);

  const handle = useCallback(async (id: string, action: 'approve' | 'deny') => {
    setWorking(id);
    try {
      await (action === 'approve' ? approveRequest(id) : denyRequest(id));
      setPending((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error(`Failed to ${action} approval:`, err);
      alert(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setWorking(null);
    }
  }, []);

  if (pending.length === 0) return null;

  return (
    <div style={styles.container}>
      {pending.map((req) => (
        <div key={req.id} style={styles.card}>
          <div style={styles.iconWrap}>🚨</div>
          <div style={styles.body}>
            <div style={styles.header}>
              <span style={styles.from}>{req.from}</span>
              <span style={styles.badge}>Approval needed</span>
            </div>
            <div style={styles.description}>{req.description}</div>
          </div>
          <div style={styles.actions}>
            <button
              onClick={() => handle(req.id, 'approve')}
              disabled={working === req.id}
              style={styles.approveBtn}
            >
              {working === req.id ? '…' : 'Approve'}
            </button>
            <button
              onClick={() => handle(req.id, 'deny')}
              disabled={working === req.id}
              style={styles.denyBtn}
            >
              {working === req.id ? '…' : 'Deny'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '10px 16px 0',
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    background: 'rgba(240, 180, 41, 0.08)',
    border: '1px solid rgba(240, 180, 41, 0.35)',
    borderRadius: 'var(--radius-sm)',
  } as React.CSSProperties,
  iconWrap: {
    fontSize: 18,
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  from: {
    fontSize: 12,
    fontWeight: 700,
    color: '#f0b429',
  },
  badge: {
    fontSize: 9,
    fontWeight: 700,
    color: '#f0b429',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  } as React.CSSProperties,
  description: {
    fontSize: 13,
    color: 'var(--text-primary)',
    lineHeight: 1.4,
    wordBreak: 'break-word' as const,
  },
  actions: {
    display: 'flex',
    gap: 6,
    flexShrink: 0,
  },
  approveBtn: {
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    color: '#fff',
    background: 'rgba(74, 186, 106, 0.35)',
    border: '1px solid rgba(74, 186, 106, 0.5)',
    borderRadius: 6,
    cursor: 'pointer',
  } as React.CSSProperties,
  denyBtn: {
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    color: '#ef6461',
    background: 'rgba(239, 100, 97, 0.1)',
    border: '1px solid rgba(239, 100, 97, 0.3)',
    borderRadius: 6,
    cursor: 'pointer',
  } as React.CSSProperties,
};
