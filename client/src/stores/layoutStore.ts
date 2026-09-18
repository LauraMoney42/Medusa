import { create } from 'zustand';

/**
 * Widths and open/closed state for the two right-hand panels.
 *
 * Everything here is persisted to localStorage rather than the server: these
 * are per-browser view preferences, not chat data, and the addendum's "Both
 * panels persist their widths in local storage" is explicit about it.
 */

/** Right panel sizes. `full` covers the chat column entirely. */
export type PanelState = 'hidden' | 'slim' | 'wide' | 'full';
export type PanelTab = 'browser' | 'simulator' | 'tasks';

const KEYS = {
  state: 'medusa.panel.state',
  tab: 'medusa.panel.tab',
  slim: 'medusa.panel.slimWidth',
  wide: 'medusa.panel.wideWidth',
  activityOpen: 'medusa.activity.open',
  activityWidth: 'medusa.activity.width',
} as const;

export const PANEL_MIN_WIDTH = 260;
export const PANEL_MAX_WIDTH = 1100;
/** Below this, a drag is treated as "the user wants slim". */
export const SLIM_WIDE_BOUNDARY = 520;
export const ACTIVITY_MIN_WIDTH = 220;
export const ACTIVITY_MAX_WIDTH = 720;

function readNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = localStorage.getItem(key);
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampPanel(px: number): number {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(px)));
}

interface LayoutState {
  panelState: PanelState;
  panelTab: PanelTab;
  /** Remembered width for each of the two resizable states. */
  slimWidth: number;
  wideWidth: number;
  activityOpen: boolean;
  activityWidth: number;
}

interface LayoutActions {
  setPanelState: (state: PanelState) => void;
  setPanelTab: (tab: PanelTab) => void;
  /** Open the panel on a tab; clicking the tab that is already showing hides it. */
  toggleTab: (tab: PanelTab) => void;
  /** Cmd+B: hidden <-> the last non-hidden size. */
  togglePanel: () => void;
  /** Double-click on the drag bar. */
  toggleSlimWide: () => void;
  /** Live drag: picks slim or wide from the width itself. */
  setPanelWidth: (px: number) => void;
  setActivityOpen: (open: boolean) => void;
  toggleActivity: () => void;
  setActivityWidth: (px: number) => void;
  /** Current pixel width of the right panel, 0 when hidden. */
  panelWidth: () => number;
}

export const useLayoutStore = create<LayoutState & LayoutActions>((set, get) => ({
  panelState: ((): PanelState => {
    const stored = localStorage.getItem(KEYS.state);
    return stored === 'slim' || stored === 'wide' || stored === 'full' ? stored : 'hidden';
  })(),
  panelTab: (() => {
    const stored = localStorage.getItem(KEYS.tab);
    return stored === 'simulator' || stored === 'tasks' ? stored : 'browser';
  })(),
  slimWidth: readNumber(KEYS.slim, 360, PANEL_MIN_WIDTH, SLIM_WIDE_BOUNDARY),
  wideWidth: readNumber(KEYS.wide, 680, SLIM_WIDE_BOUNDARY, PANEL_MAX_WIDTH),
  activityOpen: localStorage.getItem(KEYS.activityOpen) === '1',
  activityWidth: readNumber(KEYS.activityWidth, 320, ACTIVITY_MIN_WIDTH, ACTIVITY_MAX_WIDTH),

  setPanelState: (state) => {
    localStorage.setItem(KEYS.state, state);
    set({ panelState: state });
  },

  setPanelTab: (tab) => {
    localStorage.setItem(KEYS.tab, tab);
    set({ panelTab: tab });
  },

  toggleTab: (tab) => {
    const { panelState, panelTab } = get();
    if (panelState !== 'hidden' && panelTab === tab) {
      get().setPanelState('hidden');
      return;
    }
    get().setPanelTab(tab);
    if (panelState === 'hidden') get().setPanelState('slim');
  },

  togglePanel: () => {
    const { panelState } = get();
    get().setPanelState(panelState === 'hidden' ? 'slim' : 'hidden');
  },

  toggleSlimWide: () => {
    const { panelState } = get();
    get().setPanelState(panelState === 'wide' ? 'slim' : 'wide');
  },

  setPanelWidth: (px) => {
    const width = clampPanel(px);
    if (width < SLIM_WIDE_BOUNDARY) {
      localStorage.setItem(KEYS.slim, String(width));
      localStorage.setItem(KEYS.state, 'slim');
      set({ slimWidth: width, panelState: 'slim' });
    } else {
      localStorage.setItem(KEYS.wide, String(width));
      localStorage.setItem(KEYS.state, 'wide');
      set({ wideWidth: width, panelState: 'wide' });
    }
  },

  setActivityOpen: (open) => {
    localStorage.setItem(KEYS.activityOpen, open ? '1' : '0');
    set({ activityOpen: open });
  },

  toggleActivity: () => get().setActivityOpen(!get().activityOpen),

  setActivityWidth: (px) => {
    const width = Math.min(ACTIVITY_MAX_WIDTH, Math.max(ACTIVITY_MIN_WIDTH, Math.round(px)));
    localStorage.setItem(KEYS.activityWidth, String(width));
    set({ activityWidth: width });
  },

  panelWidth: () => {
    const { panelState, slimWidth, wideWidth } = get();
    if (panelState === 'hidden') return 0;
    if (panelState === 'slim') return slimWidth;
    return wideWidth;
  },
}));
