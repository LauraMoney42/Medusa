import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useProjectStore } from '../../stores/projectStore';
import { getSocket } from '../../socket';
import SkillPicker from '../Chat/SkillPicker';

type FormMode = 'none' | 'menu' | 'bot' | 'project';

export default function NewSessionButton() {
  const [mode, setMode] = useState<FormMode>('none');

  // Bot form state
  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [botSkills, setBotSkills] = useState<string[]>([]);
  const [showSkillPicker, setShowSkillPicker] = useState(false);

  // Project form state
  const [projTitle, setProjTitle] = useState('');
  const [projSummary, setProjSummary] = useState('');
  const [projContent, setProjContent] = useState('');

  const [error, setError] = useState('');

  const createSession = useSessionStore((s) => s.createSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const createProject = useProjectStore((s) => s.createProject);
  const setActiveView = useSessionStore((s) => s.setActiveView);

  // Close dropdown on outside click
  useEffect(() => {
    if (mode !== 'menu') return;
    const close = () => setMode('none');
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [mode]);

  const resetAll = () => {
    setMode('none');
    setName('');
    setWorkingDir('');
    setSystemPrompt('');
    setBotSkills([]);
    setProjTitle('');
    setProjSummary('');
    setProjContent('');
    setError('');
  };

  const handleToggleSkill = useCallback((slug: string) => {
    setBotSkills((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  }, []);

  const handleBotSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setError('');
    try {
      const session = await createSession(
        trimmed,
        workingDir.trim() || undefined,
        systemPrompt.trim() || undefined,
      );

      // Emit skills if any selected
      if (botSkills.length > 0) {
        const socket = getSocket();
        socket.emit('session:update-skills', {
          sessionId: session.id,
          skills: botSkills,
        });
      }

      setActiveSession(session.id);
      resetAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create bot');
    }
  };

  const handleProjectSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = projTitle.trim();
    if (!trimmed) return;

    setError('');
    try {
      await createProject(trimmed, projSummary.trim(), projContent.trim());
      setActiveView('project');
      resetAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    }
  };

  // Bot creation form
  if (mode === 'bot') {
    return (
      <div style={styles.formWrapper}>
        <div style={styles.formLabel}>New Bot</div>
        <form onSubmit={handleBotSubmit} style={styles.form}>
          <input
            placeholder="Bot name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={styles.input}
            autoFocus
          />
          <input
            placeholder="Working directory (optional)"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            style={styles.input}
          />
          <textarea
            placeholder="Custom instructions / personality (optional)"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            style={styles.promptTextarea}
            rows={3}
          />

          {/* Skills */}
          <div style={styles.skillsSection}>
            <div style={styles.skillsHeader}>
              <span style={styles.skillsLabel}>Skills (optional)</span>
              <span style={styles.skillsCount}>{botSkills.length} selected</span>
            </div>
            <button
              type="button"
              onClick={() => setShowSkillPicker(true)}
              style={styles.manageSkillsBtn}
            >
              Select Skills
            </button>
            {botSkills.length > 0 && (
              <div style={styles.skillsList}>
                {botSkills.map((slug) => (
                  <span key={slug} style={styles.skillTag}>
                    {slug.replace(/-/g, ' ')}
                  </span>
                ))}
              </div>
            )}
          </div>

          {error && <div style={styles.error}>{error}</div>}
          <div style={styles.formActions}>
            <button type="submit" style={styles.createBtn}>Create</button>
            <button type="button" onClick={resetAll} style={styles.cancelBtn}>Cancel</button>
          </div>
        </form>

        {/* Skill picker modal */}
        {showSkillPicker && (
          <SkillPicker
            activeSkills={botSkills}
            onToggleSkill={handleToggleSkill}
            onClose={() => setShowSkillPicker(false)}
          />
        )}
      </div>
    );
  }

  // Project creation form
  if (mode === 'project') {
    return (
      <div style={styles.formWrapper}>
        <div style={styles.formLabel}>New Project</div>
        <form onSubmit={handleProjectSubmit} style={styles.form}>
          <input
            placeholder="Project title"
            value={projTitle}
            onChange={(e) => setProjTitle(e.target.value)}
            style={styles.input}
            autoFocus
          />
          <input
            placeholder="Summary (optional)"
            value={projSummary}
            onChange={(e) => setProjSummary(e.target.value)}
            style={styles.input}
          />
          <textarea
            placeholder="Plan content — markdown (optional)"
            value={projContent}
            onChange={(e) => setProjContent(e.target.value)}
            style={styles.promptTextarea}
            rows={4}
          />
          {error && <div style={styles.error}>{error}</div>}
          <div style={styles.formActions}>
            <button type="submit" style={styles.createBtn}>Create</button>
            <button type="button" onClick={resetAll} style={styles.cancelBtn}>Cancel</button>
          </div>
        </form>
      </div>
    );
  }

  // Default: + button with dropdown menu
  return (
    <div style={styles.buttonWrapper}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setMode(mode === 'menu' ? 'none' : 'menu');
        }}
        style={styles.newBtn}
      >
        +
      </button>

      {mode === 'menu' && (
        <div style={styles.dropdown} onClick={(e) => e.stopPropagation()}>
          <button
            style={styles.dropdownItem}
            onClick={() => setMode('bot')}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={styles.icon}>
              <rect x="6" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="2"/>
              <circle cx="10" cy="13" r="1" fill="currentColor"/>
              <circle cx="14" cy="13" r="1" fill="currentColor"/>
              <path d="M9 4v4M15 4v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span>New Bot</span>
          </button>
          <button
            style={styles.dropdownItem}
            onClick={() => setMode('project')}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={styles.icon}>
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M9 12h6M9 16h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span>New Project</span>
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  buttonWrapper: {
    padding: '10px 14px',
    borderTop: '1px solid var(--border)',
    position: 'relative',
  } as React.CSSProperties,
  newBtn: {
    width: '100%',
    padding: '10px 0',
    background: 'rgba(26, 122, 60, 0.18)',
    color: '#a8d8b8',
    borderRadius: 'var(--radius-sm)',
    fontWeight: 700,
    fontSize: 18,
    border: '1px solid rgba(26, 122, 60, 0.25)',
    transition: 'background 0.15s, box-shadow 0.3s',
    boxShadow: '0 0 12px rgba(26, 122, 60, 0.10)',
    cursor: 'pointer',
  } as React.CSSProperties,
  dropdown: {
    position: 'absolute',
    bottom: '100%',
    left: 14,
    right: 14,
    marginBottom: 6,
    background: '#2c2c2e',
    border: '1px solid rgba(255, 255, 255, 0.10)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
    padding: 4,
    zIndex: 50,
  } as React.CSSProperties,
  dropdownItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '10px 12px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: 'background 0.1s, color 0.1s',
  },
  icon: {
    color: 'var(--text-muted)',
    flexShrink: 0,
  } as React.CSSProperties,
  formWrapper: {
    padding: '10px 14px',
    borderTop: '1px solid var(--border)',
  },
  formLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 8,
  } as React.CSSProperties,
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  input: {
    padding: '8px 10px',
    background: 'rgba(0, 0, 0, 0.2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 13,
  },
  promptTextarea: {
    padding: '8px 10px',
    background: 'rgba(0, 0, 0, 0.2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 13,
    resize: 'vertical' as const,
    minHeight: 50,
    maxHeight: 150,
    fontFamily: 'inherit',
  },
  formActions: {
    display: 'flex',
    gap: 8,
  },
  createBtn: {
    flex: 1,
    padding: '8px 0',
    background: 'rgba(26, 122, 60, 0.18)',
    color: '#a8d8b8',
    borderRadius: 'var(--radius-sm)',
    fontWeight: 600,
    fontSize: 13,
    border: '1px solid rgba(26, 122, 60, 0.25)',
    cursor: 'pointer',
  },
  cancelBtn: {
    flex: 1,
    padding: '8px 0',
    background: 'rgba(255, 255, 255, 0.08)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    cursor: 'pointer',
  },
  error: {
    fontSize: 12,
    color: 'var(--danger)',
    padding: '4px 0',
  },
  skillsSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  } as React.CSSProperties,
  skillsHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as React.CSSProperties,
  skillsLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  skillsCount: {
    fontSize: 12,
    color: 'var(--text-muted)',
    fontWeight: 400,
  },
  manageSkillsBtn: {
    padding: '8px 10px',
    background: 'rgba(26, 122, 60, 0.18)',
    color: '#a8d8b8',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid rgba(26, 122, 60, 0.25)',
    cursor: 'pointer',
  },
  skillsList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  } as React.CSSProperties,
  skillTag: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 10px',
    background: 'rgba(26, 122, 60, 0.12)',
    border: '1px solid rgba(26, 122, 60, 0.20)',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    textTransform: 'capitalize' as const,
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
};
