import { useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import type { ProjectSummary } from '../../types/project';
import ProjectDetailCard from './ProjectDetailCard';

// Sort key: extract numeric priority from field or title (e.g. "P2: Foo" → 2)
function extractPriority(project: ProjectSummary): number {
  if (project.priority) {
    const match = project.priority.match(/P(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  const titleMatch = project.title.match(/^P(\d+):/i);
  return titleMatch ? parseInt(titleMatch[1], 10) : 999;
}

export default function ProjectList() {
  const projects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded);
  const projectsError = useProjectStore((s) => s.projectsError);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);

  // Re-fetch on mount + every 30s so external status changes (bot PATCHes) are reflected
  useEffect(() => {
    fetchProjects().catch(console.error);
    const interval = setInterval(() => fetchProjects().catch(console.error), 30_000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  // While the first fetch is in-flight, show nothing — avoids false empty flash on restart
  if (!projectsLoaded) return null;

  // Surface fetch failures with a retry button — previously returned null here,
  // indistinguishable from empty (P1-A fix).
  if (projectsError) return (
    <div style={styles.errorState}>
      <span style={styles.errorText}>Projects failed to load</span>
      <button style={styles.retryBtn} onClick={() => fetchProjects().catch(console.error)}>
        Retry
      </button>
    </div>
  );

  // Confirmed empty after successful fetch — hide section entirely
  if (projects.length === 0) return null;

  // Sort: active projects first, then by priority (P0→P3), then by recency
  const sortedProjects = [...projects].sort((a, b) => {
    if (a.status === 'complete' && b.status !== 'complete') return 1;
    if (a.status !== 'complete' && b.status === 'complete') return -1;
    const pa = extractPriority(a);
    const pb = extractPriority(b);
    if (pa !== pb) return pa - pb;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <div style={styles.container}>
      <div style={styles.sectionHeader}>Projects</div>
      <div style={styles.scrollArea}>
        {sortedProjects.map((project) => (
          <ProjectDetailCard key={project.id} project={project} />
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  errorState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 14px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
  },
  errorText: {
    fontSize: 11,
    color: '#8B2E2E',
  },
  retryBtn: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 4,
    padding: '2px 7px',
    cursor: 'pointer',
  },
  container: {
    padding: '4px 0',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
  },
  // Taller scroll area to accommodate expanded project detail cards
  scrollArea: {
    maxHeight: 380,
    overflowY: 'auto',
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(255,255,255,0.15) transparent',
  } as React.CSSProperties,
  sectionHeader: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    padding: '8px 18px 4px',
  } as React.CSSProperties,
};
