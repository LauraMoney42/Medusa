import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { getSocket } from '../../socket';
import SkillPicker from '../Chat/SkillPicker';
import type { SessionMeta } from '../../types/session';

interface SessionEditorProps {
  session: SessionMeta;
  onClose: () => void;
}

export default function SessionEditor({ session, onClose }: SessionEditorProps) {
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const renameSession = useSessionStore((s) => s.renameSession);

  const [name, setName] = useState(session.name);
  const [instructions, setInstructions] = useState(session.systemPrompt ?? '');
  const [workingDir, setWorkingDir] = useState(session.workingDir);
  const [yolo, setYolo] = useState(session.yoloMode ?? false);
  const [skills, setSkills] = useState(session.skills ?? []);
  const [showSkillPicker, setShowSkillPicker] = useState(false);

  // Sync if the session changes externally
  useEffect(() => {
    setName(session.name);
    setInstructions(session.systemPrompt ?? '');
    setWorkingDir(session.workingDir);
    setYolo(session.yoloMode ?? false);
    setSkills(session.skills ?? []);
  }, [session.name, session.systemPrompt, session.workingDir, session.yoloMode, session.skills]);

  const handleSave = useCallback(() => {
    const socket = getSocket();

    // Rename if changed
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== session.name) {
      renameSession(session.id, trimmedName);
    }

    // Emit updates for each changed field
    if (instructions.trim() !== (session.systemPrompt ?? '')) {
      socket.emit('session:update-system-prompt', {
        sessionId: session.id,
        systemPrompt: instructions.trim(),
      });
    }

    if (workingDir.trim() !== session.workingDir) {
      socket.emit('session:update-working-dir', {
        sessionId: session.id,
        workingDir: workingDir.trim(),
      });
    }

    if (yolo !== (session.yoloMode ?? false)) {
      socket.emit('session:set-yolo', {
        sessionId: session.id,
        yoloMode: yolo,
      });
    }

    if (JSON.stringify(skills) !== JSON.stringify(session.skills ?? [])) {
      socket.emit('session:update-skills', {
        sessionId: session.id,
        skills,
      });
    }

    onClose();
  }, [session, name, instructions, workingDir, yolo, skills, renameSession, onClose]);

  const handleToggleSkill = useCallback(
    (slug: string) => {
      setSkills((prev) =>
        prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
      );
    },
    [],
  );

  const handleDelete = useCallback(() => {
    if (window.confirm(`Delete "${session.name}"? This cannot be undone.`)) {
      deleteSession(session.id);
      onClose();
    }
  }, [session, deleteSession, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  return (
    <div style={styles.overlay} onClick={onClose} onKeyDown={handleKeyDown}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={styles.title}>Edit Bot</h3>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>

        <div style={styles.body}>
          {/* Bot Name */}
          <label style={styles.label}>Bot Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Bot name"
            style={styles.nameInput}
          />

          {/* Instructions */}
          <label style={styles.label}>Instructions / Personality</label>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Custom instructions for this bot..."
            style={styles.textarea}
            rows={5}
          />

          {/* Working Directory */}
          <label style={styles.label}>Working Directory</label>
          <input
            type="text"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="/path/to/project"
            style={styles.input}
          />

          {/* Skills */}
          <div style={styles.skillsSection}>
            <div style={styles.skillsHeader}>
              <label style={styles.label}>Skills</label>
              <span style={styles.skillsCount}>{skills.length} active</span>
            </div>
            <button
              type="button"
              onClick={() => setShowSkillPicker(true)}
              style={styles.manageSkillsBtn}
            >
              Manage Skills
            </button>
            {skills.length > 0 && (
              <div style={styles.skillsList}>
                {skills.map((slug) => (
                  <span key={slug} style={styles.skillTag}>
                    {slug.replace(/-/g, ' ')}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* YOLO Mode */}
          <div style={styles.toggleRow}>
            <div>
              <span style={styles.toggleLabel}>YOLO Mode</span>
              <span style={styles.toggleDesc}>Skip permission prompts</span>
            </div>
            <button
              onClick={() => setYolo(!yolo)}
              style={{
                ...styles.toggle,
                background: yolo ? 'var(--warning)' : 'rgba(255, 255, 255, 0.10)',
              }}
            >
              <span
                style={{
                  ...styles.toggleKnob,
                  transform: yolo ? 'translateX(18px)' : 'translateX(0)',
                }}
              />
            </button>
          </div>
        </div>

        <div style={styles.footer}>
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button onClick={onClose} style={styles.cancelBtn}>Cancel</button>
            <button onClick={handleSave} style={styles.saveBtn}>Save</button>
          </div>
        </div>

        <div style={styles.dangerZone}>
          <button onClick={handleDelete} style={styles.deleteBtn}>
            Delete Bot
          </button>
        </div>

        {/* Skill picker modal */}
        {showSkillPicker && (
          <SkillPicker
            activeSkills={skills}
            onToggleSkill={handleToggleSkill}
            onClose={() => setShowSkillPicker(false)}
          />
        )}
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
    borderRadius: 'var(--radius-lg, 18px)',
    boxShadow: '0 12px 64px rgba(0, 0, 0, 0.55)',
    width: '90%',
    maxWidth: 480,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
  },
  title: {
    margin: 0,
    flex: 1,
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
  body: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  nameInput: {
    width: '100%',
    padding: '8px 10px',
    background: 'rgba(0, 0, 0, 0.2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 14,
    fontWeight: 600,
    boxSizing: 'border-box' as const,
  },
  textarea: {
    width: '100%',
    padding: '8px 10px',
    background: 'rgba(0, 0, 0, 0.2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 13,
    lineHeight: 1.5,
    resize: 'vertical' as const,
    minHeight: 80,
    maxHeight: 200,
    fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
  },
  input: {
    width: '100%',
    padding: '8px 10px',
    background: 'rgba(0, 0, 0, 0.2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    boxSizing: 'border-box' as const,
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 0',
  },
  toggleLabel: {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text-primary)',
    display: 'block',
  },
  toggleDesc: {
    fontSize: 12,
    color: 'var(--text-muted)',
  },
  toggle: {
    width: 42,
    height: 24,
    borderRadius: 12,
    border: 'none',
    cursor: 'pointer',
    position: 'relative',
    transition: 'background 0.2s',
    flexShrink: 0,
    padding: 0,
  } as React.CSSProperties,
  toggleKnob: {
    display: 'block',
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: '#fff',
    position: 'absolute',
    top: 3,
    left: 3,
    transition: 'transform 0.2s',
  } as React.CSSProperties,
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: '12px 16px',
    borderTop: '1px solid var(--border)',
  },
  dangerZone: {
    padding: '10px 16px 14px',
    borderTop: '1px solid var(--border)',
  },
  deleteBtn: {
    width: '100%',
    padding: '7px 14px',
    background: 'transparent',
    color: 'var(--danger)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid var(--danger)',
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '6px 14px',
    background: 'rgba(255, 255, 255, 0.08)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    border: 'none',
    cursor: 'pointer',
  },
  saveBtn: {
    padding: '6px 18px',
    background: 'var(--accent)',
    color: '#fff',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
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
    textTransform: 'capitalize',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
};
