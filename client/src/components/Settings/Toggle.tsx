import { toggleStyles } from './settingsStyles';

/** A labelled on/off switch. Shared by the Persona, Voice and Toolbox panes. */
export default function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={on ? 'On' : 'Off'}
      onClick={() => onChange(!on)}
      style={toggleStyles.track(on)}
    >
      <span style={toggleStyles.knob(on)} />
    </button>
  );
}
