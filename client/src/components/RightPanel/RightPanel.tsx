import CoworkPane from '../Cowork/CoworkPane';
import SimulatorPane from '../Cowork/SimulatorPane';
import TasksPanel from '../Tasks/TasksPanel';
import { useLayoutStore } from '../../stores/layoutStore';

/**
 * The Browser | Simulator panel to the right of the chat.
 *
 * CoworkPane and SimulatorPane are reused unchanged: they already know how to
 * stream CDP frames and idb frames and to hand input back, and nothing about
 * that changes because they now live in a panel instead of a full-width view.
 */
export default function RightPanel() {
  const tab = useLayoutStore((s) => s.panelTab);
  const setPanelTab = useLayoutStore((s) => s.setPanelTab);
  const panelState = useLayoutStore((s) => s.panelState);
  const setPanelState = useLayoutStore((s) => s.setPanelState);

  return (
    <div style={styles.container}>
      <div style={styles.tabBar}>
        <button
          onClick={() => setPanelTab('browser')}
          style={{ ...styles.tab, ...(tab === 'browser' ? styles.tabActive : {}) }}
        >
          Browser
        </button>
        <button
          onClick={() => setPanelTab('simulator')}
          style={{ ...styles.tab, ...(tab === 'simulator' ? styles.tabActive : {}) }}
        >
          Simulator
        </button>
        <button
          onClick={() => setPanelTab('tasks')}
          style={{ ...styles.tab, ...(tab === 'tasks' ? styles.tabActive : {}) }}
        >
          Tasks
        </button>

        <div style={styles.tabActions}>
          <button
            onClick={() => setPanelState(panelState === 'full' ? 'wide' : 'full')}
            title={panelState === 'full' ? 'Restore' : 'Full width'}
            aria-label={panelState === 'full' ? 'Restore panel' : 'Expand panel to full width'}
            style={styles.actionBtn}
          >
            {panelState === 'full' ? '⤡' : '⤢'}
          </button>
          <button
            onClick={() => setPanelState('hidden')}
            title="Close panel (⌘B)"
            aria-label="Close panel"
            style={styles.actionBtn}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Both panes stay mounted: hiding one with display:none keeps its live
          CDP / idb socket stream alive, so switching tabs does not reconnect. */}
      <div style={{ ...styles.pane, display: tab === 'browser' ? 'flex' : 'none' }}>
        <CoworkPane />
      </div>
      <div style={{ ...styles.pane, display: tab === 'simulator' ? 'flex' : 'none' }}>
        <SimulatorPane />
      </div>
      <div style={{ ...styles.pane, display: tab === 'tasks' ? 'flex' : 'none' }}>
        <TasksPanel />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minWidth: 0,
    background: 'var(--glass-bg-heavy)',
    borderLeft: '1px solid var(--border)',
  },
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '6px 8px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  tab: {
    background: 'transparent',
    // Longhand on purpose: tabActive below overrides only borderColor, and
    // mixing that with a `border` shorthand here trips React's
    // "Removing borderColor border" style-conflict warning on tab switch.
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    color: 'var(--text-muted)',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
  },
  tabActive: {
    color: '#4aba6a',
    background: 'rgba(26, 122, 60, 0.12)',
    borderColor: 'var(--border-glow)',
  },
  tabActions: { marginLeft: 'auto', display: 'flex', gap: 2 },
  actionBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: 12,
    cursor: 'pointer',
    padding: '4px 6px',
    borderRadius: 4,
  },
  pane: {
    flex: 1,
    minHeight: 0,
    flexDirection: 'column',
    overflow: 'hidden',
  },
};
