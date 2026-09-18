import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import type { MedusaTheme } from '../../api';
import { applyTheme } from '../../theme';
import { s } from './settingsStyles';

/**
 * Theme editor. Each picker writes straight through `applyTheme`, which
 * rewrites the CSS variables, so the whole app repaints as the color changes
 * and Save only persists what is already on screen. Export and Import move the
 * same tokens as a small JSON file, independent of a full pack.
 */

const TOKENS: Array<{ key: keyof MedusaTheme; label: string }> = [
  { key: 'background', label: 'Background' },
  { key: 'surface', label: 'Surface' },
  { key: 'accent', label: 'Accent' },
  { key: 'text', label: 'Text' },
  { key: 'muted', label: 'Muted' },
  { key: 'danger', label: 'Danger' },
];

export default function ThemeTab() {
  const [theme, setTheme] = useState<MedusaTheme | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api.fetchTheme().then(setTheme).catch((e: Error) => setError(e.message));
  }, []);

  const patch = useCallback((fields: Partial<MedusaTheme>) => {
    setTheme((t) => {
      if (!t) return t;
      const next = { ...t, ...fields };
      applyTheme(next); // instant preview, before anything is saved
      return next;
    });
    setStatus(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!theme) return;
    try {
      const saved = await api.saveTheme(theme);
      setTheme(saved);
      applyTheme(saved);
      setStatus('Theme saved.');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }, [theme]);

  const handleExport = useCallback(() => {
    if (!theme) return;
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'medusa-theme.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [theme]);

  const handleImport = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as MedusaTheme;
        const saved = await api.saveTheme(parsed);
        setTheme(saved);
        applyTheme(saved);
        setStatus(`Imported ${file.name}.`);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That file is not a Medusa theme.');
      }
    };
    reader.readAsText(file);
  }, []);

  if (!theme) {
    return <div style={s.pane}><p style={s.hint}>{error ?? 'Loading…'}</p></div>;
  }

  return (
    <div style={s.pane}>
      <div style={s.card}>
        <div style={s.swatchGrid}>
          {TOKENS.map(({ key, label }) => (
            <div key={key} style={s.swatchRow}>
              <input
                type="color"
                aria-label={label}
                style={s.colorInput}
                value={String(theme[key])}
                onChange={(e) => patch({ [key]: e.target.value } as Partial<MedusaTheme>)}
              />
              <div style={s.listText}>
                <span style={s.listLabel}>{label}</span>
                <span style={s.listDetail}>{String(theme[key])}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={s.card}>
        <div style={s.spread}>
          <span style={s.fieldLabel}>Appearance</span>
          <div style={s.row}>
            {(['dark', 'light'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => patch({ mode })}
                style={theme.mode === mode ? s.btnPrimary : s.btn}
              >
                {mode === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        </div>
        <div style={s.spread}>
          <span style={s.fieldLabel}>Density</span>
          <select
            style={s.select}
            value={theme.density}
            onChange={(e) => patch({ density: e.target.value as MedusaTheme['density'] })}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </div>
        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="theme-font">Font stack (optional)</label>
          <input
            id="theme-font"
            style={s.input}
            placeholder="system-ui, -apple-system, sans-serif"
            value={theme.font}
            onChange={(e) => patch({ font: e.target.value })}
          />
        </div>
      </div>

      <div style={s.row}>
        <button style={s.btnPrimary} onClick={handleSave}>Save theme</button>
        <button style={s.btn} onClick={handleExport}>Export JSON</button>
        <button style={s.btn} onClick={() => fileRef.current?.click()}>Import JSON</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => handleImport(e.target.files?.[0])}
        />
      </div>
      {status && <p style={s.note}>{status}</p>}
      {error && <p style={s.error}>{error}</p>}
      <p style={s.hint}>
        Colors preview as you pick them. Save writes them to your Medusa folder so
        they come back next time the app loads.
      </p>
    </div>
  );
}
