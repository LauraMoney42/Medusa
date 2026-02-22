import { useEffect, useState, useCallback, useRef } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import type { Project, Assignment, ProjectSummary } from '../../types/project';
import ProjectDetailCard from './ProjectDetailCard';
import QuickTaskSection from './QuickTaskSection';

interface ProjectPaneProps {
  onMenuToggle?: () => void;
}

/** Numeric priority for sorting (lower = higher priority) */
function priorityNum(p: ProjectSummary['priority']): number {
  if (!p) return 999;
  const m = p.match(/P(\d+)/);
  return m ? parseInt(m[1], 10) : 999;
}

// ─────────────────────────────────────────────────────────────
// Main export — switches between dashboard view and edit mode
// ─────────────────────────────────────────────────────────────

export default function ProjectPane({ onMenuToggle }: ProjectPaneProps) {
  const [editingId, setEditingId] = useState<string | null>(null);

  if (editingId) {
    return (
      <ProjectEditView
        projectId={editingId}
        onClose={() => setEditingId(null)}
        onMenuToggle={onMenuToggle}
      />
    );
  }

  return (
    <ProjectDashboard
      onEdit={(id) => setEditingId(id)}
      onMenuToggle={onMenuToggle}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// Dashboard — all projects as expandable cards
// ─────────────────────────────────────────────────────────────

function ProjectDashboard({
  onEdit,
  onMenuToggle,
}: {
  onEdit: (id: string) => void;
  onMenuToggle?: () => void;
}) {
  const projects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  // Refs per card so we can scroll the highlighted project into view
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Scroll to the active project whenever it changes
  useEffect(() => {
    if (activeProjectId && cardRefs.current[activeProjectId]) {
      cardRefs.current[activeProjectId]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [activeProjectId]);

  // Sort: active before complete, then by priority (P0 first), then by updatedAt desc
  const sorted = [...projects].sort((a, b) => {
    if (a.status === 'complete' && b.status !== 'complete') return 1;
    if (a.status !== 'complete' && b.status === 'complete') return -1;
    const pa = priorityNum(a.priority);
    const pb = priorityNum(b.priority);
    if (pa !== pb) return pa - pb;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <div style={styles.container}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div className="mobile-header" style={styles.mobileHeader}>
          <button onClick={onMenuToggle} style={styles.menuBtn}>&#9776;</button>
        </div>
        <span style={styles.topTitle}>Projects</span>
        {projectsLoaded && projects.length > 0 && (
          <span style={styles.projectCount}>
            {projects.length} project{projects.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Content */}
      <div style={styles.content}>
        {/* Loading state */}
        {!projectsLoaded && (
          <div style={styles.centred}>
            <p style={styles.mutedText}>Loading projects…</p>
          </div>
        )}

        {/* Empty state */}
        {projectsLoaded && projects.length === 0 && (
          <div style={styles.centred}>
            <p style={styles.emptyText}>No projects yet</p>
            <p style={styles.emptyHint}>
              Projects created by bots will appear here with full task breakdowns.
            </p>
          </div>
        )}

        {/* Quick Tasks — lightweight alternative to full projects */}
        <QuickTaskSection />

        {/* Project cards */}
        {sorted.map((project) => (
          <div
            key={project.id}
            ref={(el) => { cardRefs.current[project.id] = el; }}
          >
            <ProjectDetailCard
              project={project}
              isHighlighted={project.id === activeProjectId}
              onEdit={() => onEdit(project.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Edit view — full edit form for a single project
// (extracted from the original ProjectPane implementation)
// ─────────────────────────────────────────────────────────────

function ProjectEditView({
  projectId,
  onClose,
  onMenuToggle,
}: {
  projectId: string;
  onClose: () => void;
  onMenuToggle?: () => void;
}) {
  const fetchProject = useProjectStore((s) => s.fetchProject);
  const updateProject = useProjectStore((s) => s.updateProject);
  const projectCache = useProjectStore((s) => s.projectCache);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'complete'>('active');
  const [editPriority, setEditPriority] = useState<'P0' | 'P1' | 'P2' | 'P3' | ''>('');
  const [editContent, setEditContent] = useState('');
  const [editAssignments, setEditAssignments] = useState<Assignment[]>([]);

  const project: Project | undefined = projectCache[projectId];

  // Fetch the full project (includes `content`) if not already cached
  useEffect(() => {
    if (projectCache[projectId]) return;
    setLoading(true);
    setError(null);
    fetchProject(projectId)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load project'))
      .finally(() => setLoading(false));
  }, [projectId, fetchProject, projectCache]);

  // Populate form once project is available
  useEffect(() => {
    if (!project) return;
    setEditTitle(project.title);
    setEditSummary(project.summary);
    setEditStatus(project.status);
    setEditPriority(project.priority || '');
    setEditContent(project.content);
    setEditAssignments(project.assignments.map((a) => ({ ...a })));
  }, [project]);

  const saveEdits = useCallback(async () => {
    if (!projectId) return;
    setSaving(true);
    setError(null);
    try {
      await updateProject(projectId, {
        title: editTitle,
        summary: editSummary,
        status: editStatus,
        priority: editPriority || undefined,
        content: editContent,
        assignments: editAssignments,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [projectId, updateProject, editTitle, editSummary, editStatus, editPriority, editContent, editAssignments, onClose]);

  const updateAssignment = (index: number, field: keyof Assignment, value: string) => {
    setEditAssignments((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const removeAssignment = (index: number) => {
    setEditAssignments((prev) => prev.filter((_, i) => i !== index));
  };

  const addAssignment = () => {
    setEditAssignments((prev) => [
      ...prev,
      { id: crypto.randomUUID(), owner: '', task: '', status: 'pending' },
    ]);
  };

  return (
    <div style={styles.container}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div className="mobile-header" style={styles.mobileHeader}>
          <button onClick={onMenuToggle} style={styles.menuBtn}>&#9776;</button>
        </div>

        <input
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          style={styles.editTitleInput}
          placeholder="Project title"
        />

        <select
          value={editStatus}
          onChange={(e) => setEditStatus(e.target.value as 'active' | 'complete')}
          style={styles.statusSelect}
        >
          <option value="active">Active</option>
          <option value="complete">Complete</option>
        </select>

        <select
          value={editPriority}
          onChange={(e) => setEditPriority(e.target.value as 'P0' | 'P1' | 'P2' | 'P3' | '')}
          style={styles.statusSelect}
        >
          <option value="">No Priority</option>
          <option value="P0">P0 (Critical)</option>
          <option value="P1">P1 (High)</option>
          <option value="P2">P2 (Medium)</option>
          <option value="P3">P3 (Low)</option>
        </select>

        <div style={{ flex: 1 }} />

        <div style={styles.editActions}>
          <button onClick={onClose} style={styles.cancelBtn} disabled={saving}>
            Cancel
          </button>
          <button onClick={saveEdits} style={styles.saveBtn} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Form body */}
      <div style={styles.content}>
        {loading && <div style={styles.loading}>Loading project…</div>}
        {error && <div style={styles.errorBox}>{error}</div>}

        {project && (
          <>
            <div style={styles.editSection}>
              <label style={styles.editLabel}>Summary</label>
              <textarea
                value={editSummary}
                onChange={(e) => setEditSummary(e.target.value)}
                style={styles.editTextarea}
                rows={3}
                placeholder="Project summary…"
              />
            </div>

            <EditableAssignments
              assignments={editAssignments}
              onUpdate={updateAssignment}
              onRemove={removeAssignment}
              onAdd={addAssignment}
            />

            <div style={styles.editSection}>
              <label style={styles.editLabel}>Plan Content</label>
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                style={{
                  ...styles.editTextarea,
                  minHeight: 300,
                  fontFamily: 'monospace',
                  fontSize: 13,
                }}
                placeholder="Markdown plan content…"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Editable assignments sub-component (unchanged from original)
// ─────────────────────────────────────────────────────────────

function EditableAssignments({
  assignments,
  onUpdate,
  onRemove,
  onAdd,
}: {
  assignments: Assignment[];
  onUpdate: (i: number, field: keyof Assignment, value: string) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
}) {
  return (
    <div style={styles.editSection}>
      <label style={styles.editLabel}>Assignments</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {assignments.map((a, i) => (
          <div key={i} style={styles.assignmentEditRow}>
            <input
              value={a.task}
              onChange={(e) => onUpdate(i, 'task', e.target.value)}
              placeholder="Task"
              style={{ ...styles.editInput, flex: 2 }}
            />
            <input
              value={a.owner}
              onChange={(e) => onUpdate(i, 'owner', e.target.value)}
              placeholder="Owner"
              style={{ ...styles.editInput, flex: 1 }}
            />
            <select
              value={a.status}
              onChange={(e) => onUpdate(i, 'status', e.target.value)}
              style={{ ...styles.editInput, width: 110, flex: 'none' }}
            >
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="done">Done</option>
            </select>
            <button onClick={() => onRemove(i)} style={styles.removeBtn} title="Remove">
              &times;
            </button>
          </div>
        ))}
        <button onClick={onAdd} style={styles.addAssignmentBtn}>
          + Add Assignment
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────

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
    padding: '10px 16px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(26, 26, 28, 0.75)',
    backdropFilter: 'blur(20px) saturate(1.2)',
    WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
    flexShrink: 0,
  } as React.CSSProperties,
  mobileHeader: {
    alignItems: 'center',
  },
  menuBtn: {
    fontSize: 20,
    padding: '4px 8px',
    color: 'var(--text-secondary)',
  },
  topTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  projectCount: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontWeight: 500,
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  } as React.CSSProperties,
  centred: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingTop: 60,
  } as React.CSSProperties,
  mutedText: {
    fontSize: 14,
    color: 'var(--text-muted)',
    margin: 0,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    margin: 0,
  },
  emptyHint: {
    fontSize: 13,
    color: 'var(--text-muted)',
    textAlign: 'center',
    maxWidth: 340,
    lineHeight: 1.5,
    margin: 0,
  } as React.CSSProperties,
  loading: {
    padding: '32px 0',
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 14,
  } as React.CSSProperties,
  errorBox: {
    padding: '12px 16px',
    background: 'rgba(192, 57, 43, 0.12)',
    border: '1px solid rgba(192, 57, 43, 0.25)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--danger)',
    fontSize: 13,
  },
  // Edit view
  editTitleInput: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary)',
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: 6,
    padding: '4px 10px',
    outline: 'none',
    minWidth: 180,
    flex: 'none',
  } as React.CSSProperties,
  statusSelect: {
    fontSize: 11,
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: 6,
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    color: 'var(--text-primary)',
    outline: 'none',
    flexShrink: 0,
  } as React.CSSProperties,
  editActions: {
    display: 'flex',
    gap: 6,
    flexShrink: 0,
  },
  cancelBtn: {
    padding: '5px 12px',
    borderRadius: 6,
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
  saveBtn: {
    padding: '5px 14px',
    borderRadius: 6,
    background: 'var(--accent)',
    border: 'none',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  editSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  editLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  } as React.CSSProperties,
  editInput: {
    fontSize: 13,
    color: 'var(--text-primary)',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: 6,
    padding: '6px 10px',
    outline: 'none',
  } as React.CSSProperties,
  editTextarea: {
    fontSize: 14,
    color: 'var(--text-primary)',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: 6,
    padding: '10px 12px',
    outline: 'none',
    resize: 'vertical',
    lineHeight: 1.6,
    minHeight: 80,
  } as React.CSSProperties,
  assignmentEditRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  removeBtn: {
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    background: 'rgba(192, 57, 43, 0.12)',
    border: 'none',
    color: 'var(--danger)',
    fontSize: 16,
    cursor: 'pointer',
    flexShrink: 0,
  },
  addAssignmentBtn: {
    alignSelf: 'flex-start',
    padding: '4px 12px',
    borderRadius: 6,
    background: 'rgba(26, 122, 60, 0.1)',
    border: '1px solid rgba(26, 122, 60, 0.2)',
    color: '#4aba6a',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
  },
};

