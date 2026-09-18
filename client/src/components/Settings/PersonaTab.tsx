import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import type { Persona } from '../../api';
import { s } from './settingsStyles';

/**
 * Persona editor: name, avatar, personality prose and greeting, with a live
 * preview of the prompt the engine will actually receive.
 *
 * The preview comes from GET /api/medusa/preview rather than being assembled
 * here, so what is shown is the same composition every engine gets. The avatar
 * is read as a data URL and travels inside the pack; nothing is uploaded.
 */

const AVATAR_MAX_BYTES = 1_000_000;

export default function PersonaTab() {
  const [persona, setPersona] = useState<Persona | null>(null);
  const [preview, setPreview] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api.fetchPersona().then(setPersona).catch((e: Error) => setError(e.message));
  }, []);

  // Debounced so typing in the personality box does not fire a request a key.
  useEffect(() => {
    if (!persona) return;
    const id = setTimeout(() => {
      api
        .fetchPromptPreview(persona.personality)
        .then((r) => setPreview(r.prompt))
        .catch(() => setPreview(''));
    }, 350);
    return () => clearTimeout(id);
  }, [persona]);

  const patch = useCallback((fields: Partial<Persona>) => {
    setPersona((p) => (p ? { ...p, ...fields } : p));
    setStatus(null);
  }, []);

  const handleAvatar = useCallback((file: File | undefined) => {
    if (!file) return;
    if (file.size > AVATAR_MAX_BYTES) {
      setError('Pick an image under 1MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setError(null);
      patch({ avatar: typeof reader.result === 'string' ? reader.result : null });
    };
    reader.onerror = () => setError('That image could not be read.');
    reader.readAsDataURL(file);
  }, [patch]);

  const handleSave = useCallback(async () => {
    if (!persona) return;
    setSaving(true);
    setError(null);
    try {
      setPersona(await api.savePersona(persona));
      setStatus('Saved. New chats pick this up on their next turn.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [persona]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    try {
      setPersona(await api.resetPersona());
      setStatus('Back to the default Medusa persona.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setSaving(false);
    }
  }, []);

  if (!persona) {
    return <div style={s.pane}><p style={s.hint}>{error ?? 'Loading…'}</p></div>;
  }

  return (
    <div style={s.pane}>
      <div style={s.card}>
        <div style={s.row}>
          {persona.avatar ? (
            <img src={persona.avatar} alt="" style={s.avatar} />
          ) : (
            <div style={s.avatarBlank}>No image</div>
          )}
          <div style={{ ...s.field, flex: 1 }}>
            <label style={s.fieldLabel} htmlFor="persona-name">Name</label>
            <input
              id="persona-name"
              style={s.input}
              value={persona.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>
        </div>

        <div style={s.row}>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => handleAvatar(e.target.files?.[0])}
          />
          <button style={s.btn} onClick={() => fileRef.current?.click()}>Choose avatar</button>
          {persona.avatar && (
            <button style={s.btn} onClick={() => patch({ avatar: null })}>Remove avatar</button>
          )}
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="persona-greeting">Greeting</label>
          <input
            id="persona-greeting"
            style={s.input}
            placeholder="What the empty chat says first"
            value={persona.greeting}
            onChange={(e) => patch({ greeting: e.target.value })}
          />
        </div>

        <div style={s.field}>
          <label style={s.fieldLabel} htmlFor="persona-text">Personality</label>
          <textarea
            id="persona-text"
            style={s.textarea}
            value={persona.personality}
            onChange={(e) => patch({ personality: e.target.value })}
          />
        </div>

        <div style={s.row}>
          <button style={s.btnPrimary} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save persona'}
          </button>
          <button style={s.btn} onClick={handleReset} disabled={saving}>
            Reset to default
          </button>
        </div>
        {status && <p style={s.note}>{status}</p>}
        {error && <p style={s.error}>{error}</p>}
      </div>

      <div style={s.section}>
        <span style={s.label}>Composed prompt</span>
        <pre style={s.pre}>{preview || 'Building preview…'}</pre>
        <p style={s.hint}>
          This is the prompt every engine receives, persona first, then the working
          folder, subagents, style and your enabled rules.
        </p>
      </div>
    </div>
  );
}
