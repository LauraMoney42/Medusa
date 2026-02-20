import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSkills, type SkillInfo } from '../../api';

interface SkillPickerProps {
  activeSkills: string[];
  onToggleSkill: (slug: string) => void;
  onClose: () => void;
}

export default function SkillPicker({ activeSkills, onToggleSkill, onClose }: SkillPickerProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchSkills()
      .then((data) => {
        if (cancelled) return;
        setSkills(data.skills);
        setReady(data.ready);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Refresh when catalog is still loading in background
  useEffect(() => {
    if (ready || loading) return;
    const interval = setInterval(() => {
      fetchSkills().then((data) => {
        setSkills(data.skills);
        if (data.ready) {
          setReady(true);
          clearInterval(interval);
        }
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [ready, loading]);

  const filtered = useMemo(() => {
    if (!search.trim()) return skills;
    const q = search.toLowerCase();
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, search]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  const activeSet = useMemo(() => new Set(activeSkills), [activeSkills]);

  return (
    <div style={styles.overlay} onClick={onClose} onKeyDown={handleKeyDown}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={styles.title}>Add Skills</h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills..."
          style={styles.searchInput}
          autoFocus
        />

        {loading ? (
          <div style={styles.loading}>Loading skills catalog...</div>
        ) : skills.length === 0 ? (
          <div style={styles.loading}>
            {ready ? 'No skills found' : 'Fetching skills from GitHub...'}
          </div>
        ) : (
          <div style={styles.list}>
            {filtered.length === 0 && (
              <div style={styles.noResults}>No skills match "{search}"</div>
            )}
            {filtered.map((skill) => {
              const isActive = activeSet.has(skill.slug);
              return (
                <div
                  key={skill.slug}
                  style={{
                    ...styles.skillRow,
                    background: isActive ? 'rgba(255, 255, 255, 0.07)' : 'transparent',
                  }}
                >
                  <div style={styles.skillInfo}>
                    <span style={styles.skillName}>{skill.name}</span>
                    <span style={styles.skillDesc}>{skill.description}</span>
                  </div>
                  <button
                    onClick={() => onToggleSkill(skill.slug)}
                    style={{
                      ...styles.toggleBtn,
                      background: isActive ? 'var(--error)' : 'var(--accent)',
                    }}
                  >
                    {isActive ? 'Remove' : 'Add'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {!ready && !loading && skills.length > 0 && (
          <div style={styles.refreshNote}>
            Catalog is still loading in background... more skills may appear.
          </div>
        )}

        <div style={styles.footer}>
          <span style={styles.footerCount}>
            {activeSkills.length} skill{activeSkills.length !== 1 ? 's' : ''} active
          </span>
          <button onClick={onClose} style={styles.doneBtn}>Done</button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.4)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  } as React.CSSProperties,
  modal: {
    background: '#1c1c1e',
    border: '1px solid rgba(255, 255, 255, 0.10)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: '0 12px 64px rgba(0, 0, 0, 0.55)',
    width: '90%',
    maxWidth: 520,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px 0',
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 22,
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
  },
  searchInput: {
    margin: '12px 16px 8px',
    padding: '8px 12px',
    background: 'rgba(0, 0, 0, 0.2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 14,
    outline: 'none',
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 16px',
    minHeight: 0,
  },
  skillRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px',
    borderRadius: 'var(--radius-sm)',
    marginBottom: 2,
    gap: 10,
  },
  skillInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    flex: 1,
  },
  skillName: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  skillDesc: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toggleBtn: {
    flexShrink: 0,
    padding: '4px 12px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    fontWeight: 600,
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  loading: {
    padding: '32px 16px',
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 14,
  },
  noResults: {
    padding: '24px 0',
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 13,
  },
  refreshNote: {
    padding: '6px 16px',
    fontSize: 11,
    color: 'var(--text-muted)',
    textAlign: 'center',
    fontStyle: 'italic',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 16px 14px',
    borderTop: '1px solid var(--border)',
  },
  footerCount: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  doneBtn: {
    padding: '6px 18px',
    background: 'var(--accent)',
    color: '#fff',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
  },
};
