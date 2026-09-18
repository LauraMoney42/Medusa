import { useLayoutStore } from '../../stores/layoutStore';

/**
 * The chat header's top-right icon group: Browser, Simulator, Activity Log.
 * Icons only, tooltips on hover, Claude-desktop style.
 *
 * Everything else this component used to own is gone: the agent selector went
 * with the bots, and the provider and model pickers moved under the input
 * (the addendum is explicit that nothing model-related stays in the header).
 */
export default function ChatHeaderControls() {
  const panelState = useLayoutStore((s) => s.panelState);
  const panelTab = useLayoutStore((s) => s.panelTab);
  const toggleTab = useLayoutStore((s) => s.toggleTab);
  const activityOpen = useLayoutStore((s) => s.activityOpen);
  const toggleActivity = useLayoutStore((s) => s.toggleActivity);

  const panelOpen = panelState !== 'hidden';
  const browserOn = panelOpen && panelTab === 'browser';
  const simulatorOn = panelOpen && panelTab === 'simulator';

  return (
    <div style={styles.row}>
      <IconButton
        on={browserOn}
        onClick={() => toggleTab('browser')}
        title="Browser (⌘B)"
        label="Browser"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
      </IconButton>

      <IconButton
        on={simulatorOn}
        onClick={() => toggleTab('simulator')}
        title="Simulator"
        label="Simulator"
      >
        <rect x="7" y="2" width="10" height="20" rx="2" />
        <line x1="11" y1="18.5" x2="13" y2="18.5" />
      </IconButton>

      <IconButton
        on={activityOpen}
        onClick={toggleActivity}
        title="Activity Log (⌘L)"
        label="Activity Log"
      >
        <line x1="4" y1="7" x2="20" y2="7" />
        <line x1="4" y1="12" x2="16" y2="12" />
        <line x1="4" y1="17" x2="19" y2="17" />
      </IconButton>
    </div>
  );
}

function IconButton({
  on,
  onClick,
  title,
  label,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={label}
      aria-pressed={on}
      style={{
        ...styles.iconBtn,
        color: on ? '#4aba6a' : 'var(--text-secondary)',
        background: on ? 'rgba(26, 122, 60, 0.14)' : 'transparent',
        borderColor: on ? 'var(--border-glow)' : 'transparent',
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
  },
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: 'var(--radius-sm)',
    // Longhand on purpose: the "on" state below overrides only borderColor,
    // and mixing that with a `border` shorthand on the same element trips
    // React's "Removing borderColor border" style-conflict warning on every
    // toggle.
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    cursor: 'pointer',
    transition: 'color 0.15s, background 0.15s',
  },
};
