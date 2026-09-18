import { toggleStyles } from './settingsStyles';

/** A labelled on/off switch. Shared by the Persona, Voice and Toolbox panes. */
export default function Toggle({
  on,
  onChange,
  label,
  disabled = false,
  title,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** A switch for something that is not available yet (S16: Live mode). */
  disabled?: boolean;
  /** Overrides the default On/Off tooltip, e.g. to say why it is disabled. */
  title?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      title={title ?? (on ? 'On' : 'Off')}
      onClick={() => !disabled && onChange(!on)}
      style={{ ...toggleStyles.track(on), ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
    >
      <span style={toggleStyles.knob(on)} />
    </button>
  );
}
