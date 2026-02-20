import { useState, useMemo, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  useDroppable,
  useDraggable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useProjectStore } from '../../stores/projectStore';
import type { Assignment } from '../../types/project';

// Medusa-palette dark-tinted post-it colors — style-guide compliant (no neon)
// Colors derived from Medusa's official palette: Green, Info, Warning, Muted
const CARD_COLORS = [
  { bg: 'rgba(26, 77, 46, 0.45)',   border: 'rgba(45, 106, 79, 0.55)' },    // Medusa green
  { bg: 'rgba(46, 77, 139, 0.45)',  border: 'rgba(60, 100, 180, 0.50)' },   // info blue
  { bg: 'rgba(181, 135, 58, 0.35)', border: 'rgba(181, 135, 58, 0.50)' },   // warning amber
  { bg: 'rgba(82, 121, 111, 0.45)', border: 'rgba(82, 121, 111, 0.60)' },   // muted teal
  { bg: 'rgba(50, 50, 75, 0.55)',   border: 'rgba(80, 80, 120, 0.55)' },    // slate
];

// Light text on dark-tinted card backgrounds (Text Primary per style guide)
const CARD_TEXT_COLOR = '#F5F5F5';

const MAX_CARDS_PER_COLUMN = 4;

interface KanbanCard {
  assignmentId: string;
  projectId: string;
  task: string;
  owner: string;
  status: Assignment['status'];
  projectTitle: string;
  colorIndex: number;
  rotation: number;
}

interface KanbanStripProps {
  botName: string;
}

/** Stable random — seeded from string hash so colors don't change on re-render */
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export default function KanbanStrip({ botName }: KanbanStripProps) {
  const projects = useProjectStore((s) => s.projects);
  const projectCache = useProjectStore((s) => s.projectCache);
  const updateProject = useProjectStore((s) => s.updateProject);
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded);
  const projectsError = useProjectStore((s) => s.projectsError);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedCard, setExpandedCard] = useState<KanbanCard | null>(null);
  const [draggingCard, setDraggingCard] = useState<KanbanCard | null>(null);

  // Trimmed bot name — guards against empty string matching everything before sessions load
  const trimmedBotName = botName.trim();

  // K4: Derive cards from Project assignments filtered by bot name
  const cards = useMemo(() => {
    // Don't compute until we know which bot this is
    if (!trimmedBotName) return [];
    const result: KanbanCard[] = [];

    for (const project of projects) {
      if (project.status !== 'active') continue;

      // Use cached full project if available, otherwise use summary
      const p = projectCache[project.id] ?? project;

      for (const assignment of p.assignments) {
        // Trim + case-insensitive partial match (bidirectional).
        // Trimming catches accidental whitespace in owner names written by bots.
        // Bidirectional allows "Full Stack Dev (Cosmo)" to match session "Full Stack Dev".
        const ownerLower = assignment.owner.trim().toLowerCase();
        const botLower = trimmedBotName.toLowerCase();
        if (!ownerLower.includes(botLower) && !botLower.includes(ownerLower)) continue;

        const hash = hashCode(assignment.task + assignment.owner);
        result.push({
          assignmentId: assignment.id,
          projectId: project.id,
          task: assignment.task,
          owner: assignment.owner,
          status: assignment.status,
          projectTitle: project.title,
          colorIndex: hash % CARD_COLORS.length,
          rotation: 0, // flat — no skew per user request
        });
      }
    }

    return result;
  }, [projects, projectCache, botName]);

  const thinking = cards.filter((c) => c.status === 'pending');
  const doing = cards.filter((c) => c.status === 'in_progress');
  const done = cards.filter((c) => c.status === 'done');

  // K5: Handle drag end — PATCH the project with updated assignment status
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const card = event.active.data.current as KanbanCard;
    setDraggingCard(card);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingCard(null);
    const { active, over } = event;
    if (!over) return;

    const draggedCard = active.data.current as KanbanCard;
    const targetStatus = over.id as Assignment['status'];

    if (draggedCard.status === targetStatus) return;

    // Get full project from cache or summary list (both have assignments)
    const project =
      projectCache[draggedCard.projectId] ??
      projects.find((p) => p.id === draggedCard.projectId);
    if (!project) return;

    const updatedAssignments = project.assignments.map((a) =>
      a.id === draggedCard.assignmentId ? { ...a, status: targetStatus } : a,
    );

    updateProject(draggedCard.projectId, { assignments: updatedAssignments });
  }, [projectCache, projects, updateProject]);

  // Still loading — hide; component re-renders once projects arrive
  if (!projectsLoaded) return null;

  // Load failed — show a non-intrusive error so it's not silently invisible
  if (projectsError && cards.length === 0) {
    return (
      <div style={styles.container}>
        <div style={{ ...styles.header, cursor: 'default' }}>
          <span style={styles.headerLabel}>Tasks</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
            Failed to load · refresh to retry
          </span>
        </div>
      </div>
    );
  }

  // Loaded successfully but no tasks for this bot — hide cleanly
  if (cards.length === 0) return null;

  return (
    <div style={styles.container}>
      {/* Collapse/expand toggle */}
      <div style={styles.header} onClick={() => setCollapsed(!collapsed)}>
        <span style={styles.headerIcon}>{collapsed ? '▸' : '▾'}</span>
        <span style={styles.headerLabel}>Tasks</span>
        <span style={styles.headerCount}>
          {doing.length > 0 && <span style={styles.countDoing}>{doing.length} doing</span>}
          {thinking.length > 0 && <span style={styles.countPending}>{thinking.length} pending</span>}
          {done.length > 0 && <span style={styles.countDone}>{done.length} done</span>}
        </span>
      </div>

      {!collapsed && (
        <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div style={styles.columns}>
            <KanbanColumn
              title="Thinking"
              columnId="pending"
              cards={thinking}
              onCardClick={setExpandedCard}
            />
            <KanbanColumn
              title="Doing"
              columnId="in_progress"
              cards={doing}
              onCardClick={setExpandedCard}
            />
            <KanbanColumn
              title="Done"
              columnId="done"
              cards={done}
              onCardClick={setExpandedCard}
            />
          </div>

          {/* Floating card preview while dragging */}
          <DragOverlay>
            {draggingCard && <PostItCardView card={draggingCard} overlay />}
          </DragOverlay>
        </DndContext>
      )}

      {/* K6: Card detail overlay */}
      {expandedCard && (
        <CardDetail card={expandedCard} onClose={() => setExpandedCard(null)} />
      )}
    </div>
  );
}

// --- Column (drop target) ---

function KanbanColumn({
  title,
  columnId,
  cards,
  onCardClick,
}: {
  title: string;
  columnId: string;
  cards: KanbanCard[];
  onCardClick: (card: KanbanCard) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId });
  const visible = cards.slice(0, MAX_CARDS_PER_COLUMN);
  const overflow = cards.length - MAX_CARDS_PER_COLUMN;

  return (
    <div
      ref={setNodeRef}
      style={{
        ...styles.column,
        // Subtle highlight while a card is hovering over this column
        background: isOver ? 'rgba(255, 255, 255, 0.04)' : 'transparent',
        borderRadius: isOver ? 6 : 0,
        transition: 'background 0.15s',
      }}
    >
      <div style={styles.columnTitle}>{title}</div>
      <div style={styles.cardStack}>
        {visible.map((card) => (
          <PostItCard
            key={card.assignmentId}
            card={card}
            onClick={() => onCardClick(card)}
          />
        ))}
        {overflow > 0 && (
          <div style={styles.overflow}>+{overflow} more</div>
        )}
        {cards.length === 0 && (
          <div style={styles.emptyCol}>&mdash;</div>
        )}
      </div>
    </div>
  );
}

// --- Post-It Card (draggable wrapper) ---

function PostItCard({ card, onClick }: { card: KanbanCard; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.assignmentId,
    data: card,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      style={{
        ...styles.card,
        background: CARD_COLORS[card.colorIndex].bg,
        borderColor: CARD_COLORS[card.colorIndex].border,
        transform: `rotate(${card.rotation}deg)`,
        // Ghost out the original while it's being dragged
        opacity: isDragging ? 0.35 : 1,
        cursor: 'grab',
      }}
      title={card.task}
    >
      <span style={{ ...styles.cardText, color: CARD_TEXT_COLOR }}>
        {card.task}
      </span>
    </div>
  );
}

// --- Pure visual card (used in DragOverlay so no DnD hooks) ---

function PostItCardView({ card, overlay }: { card: KanbanCard; overlay?: boolean }) {
  return (
    <div
      style={{
        ...styles.card,
        background: CARD_COLORS[card.colorIndex].bg,
        borderColor: CARD_COLORS[card.colorIndex].border,
        transform: `rotate(${card.rotation}deg)`,
        cursor: overlay ? 'grabbing' : 'grab',
        // Slight scale-up while floating
        scale: overlay ? '1.05' : '1',
        boxShadow: overlay ? '2px 6px 16px rgba(0,0,0,0.35)' : styles.card.boxShadow,
      }}
    >
      <span style={{ ...styles.cardText, color: CARD_TEXT_COLOR }}>
        {card.task}
      </span>
    </div>
  );
}

// --- Card Detail ---

function CardDetail({ card, onClose }: { card: KanbanCard; onClose: () => void }) {
  return (
    <div style={styles.detailOverlay} onClick={onClose}>
      <div style={styles.detailCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.detailHeader}>
          <span style={styles.detailTitle}>{card.task}</span>
          <button onClick={onClose} style={styles.detailClose}>&times;</button>
        </div>
        <div style={styles.detailBody}>
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Owner</span>
            <span style={styles.detailValue}>{card.owner}</span>
          </div>
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Status</span>
            <span style={{
              ...styles.detailPill,
              background: card.status === 'done'
                ? 'rgba(0, 232, 123, 0.12)'
                : card.status === 'in_progress'
                ? 'rgba(255, 204, 0, 0.12)'
                : 'rgba(255, 255, 255, 0.06)',
              color: card.status === 'done'
                ? 'var(--success)'
                : card.status === 'in_progress'
                ? 'var(--warning)'
                : 'var(--text-muted)',
            }}>
              {card.status === 'in_progress' ? 'In Progress' : card.status === 'done' ? 'Done' : 'Pending'}
            </span>
          </div>
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Project</span>
            <span style={styles.detailValue}>{card.projectTitle}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Styles ---

const styles: Record<string, React.CSSProperties> = {
  container: {
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    background: 'rgba(255, 255, 255, 0.02)',
    flexShrink: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 16px',
    cursor: 'pointer',
    userSelect: 'none',
  } as React.CSSProperties,
  headerIcon: {
    fontSize: 10,
    color: 'var(--text-muted)',
    width: 12,
  },
  headerLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  } as React.CSSProperties,
  headerCount: {
    marginLeft: 'auto',
    display: 'flex',
    gap: 8,
    fontSize: 10,
  },
  countDoing: {
    color: 'var(--warning)',
    fontWeight: 600,
  },
  countPending: {
    color: 'var(--text-muted)',
    fontWeight: 500,
  },
  countDone: {
    color: 'var(--success)',
    fontWeight: 500,
  },
  columns: {
    display: 'flex',
    gap: 0,
    padding: '0 12px 10px',
  },
  column: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '0 4px',
    minWidth: 0,
  },
  columnTitle: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    textAlign: 'center',
    marginBottom: 4,
  } as React.CSSProperties,
  cardStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minHeight: 28,
  },
  card: {
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid',
    cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s',
    boxShadow: '1px 2px 8px rgba(0, 0, 0, 0.25)',
  },
  cardText: {
    fontFamily: "var(--font)",
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.2,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as React.CSSProperties,
  overflow: {
    fontSize: 10,
    color: 'var(--text-muted)',
    textAlign: 'center',
    padding: '2px 0',
    fontWeight: 500,
  } as React.CSSProperties,
  emptyCol: {
    fontSize: 12,
    color: 'var(--text-muted)',
    textAlign: 'center',
    padding: '4px 0',
    opacity: 0.4,
  } as React.CSSProperties,
  // Card detail overlay
  detailOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 400,
    background: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as React.CSSProperties,
  detailCard: {
    width: 340,
    background: '#242424',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    overflow: 'hidden',
  },
  detailHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
    padding: '16px 16px 12px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  },
  detailTitle: {
    fontFamily: "var(--font)",
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--text-primary)',
    lineHeight: 1.3,
  },
  detailClose: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: 20,
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
  },
  detailBody: {
    padding: '12px 16px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  detailRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  detailLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    width: 60,
    flexShrink: 0,
  } as React.CSSProperties,
  detailValue: {
    fontSize: 13,
    color: 'var(--text-primary)',
  },
  detailPill: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 10px',
    borderRadius: 10,
  },
};
