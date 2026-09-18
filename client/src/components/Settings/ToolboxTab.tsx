import { useCallback, useEffect, useState } from 'react';
import * as api from '../../api';
import type { RegistryCandidate, Toolbox, ToolboxEntry, ToolScope } from '../../api';
import { s } from './settingsStyles';
import Toggle from './Toggle';

/**
 * Toolbox: the curated allowlist of MCP servers and skills that are on by
 * default for every new chat, each with a permission scope.
 *
 * "Search registry" opens a modal of candidates and nothing more. Per the
 * addendum's Toolbox note, a search may propose but never install: an entry
 * joins the list only when the person clicks Add.
 */

const SCOPES: ToolScope[] = ['read', 'write', 'shell'];

const SCOPE_HINT: Record<ToolScope, string> = {
  read: 'Look, do not change',
  write: 'May edit files',
  shell: 'May run commands',
};

export default function ToolboxTab() {
  const [toolbox, setToolbox] = useState<Toolbox | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    api.fetchToolbox().then(setToolbox).catch((e: Error) => setError(e.message));
  }, []);

  const persist = useCallback(async (next: Toolbox) => {
    setToolbox(next);
    try {
      setToolbox(await api.saveToolbox(next));
      setStatus('Toolbox saved.');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }, []);

  const updateEntry = useCallback(
    (kind: 'servers' | 'skills', id: string, fields: Partial<ToolboxEntry>) => {
      if (!toolbox) return;
      void persist({
        ...toolbox,
        [kind]: toolbox[kind].map((e) => (e.id === id ? { ...e, ...fields } : e)),
      });
    },
    [toolbox, persist],
  );

  const removeEntry = useCallback(
    (kind: 'servers' | 'skills', id: string) => {
      if (!toolbox) return;
      void persist({ ...toolbox, [kind]: toolbox[kind].filter((e) => e.id !== id) });
    },
    [toolbox, persist],
  );

  const addCandidate = useCallback(
    (candidate: RegistryCandidate) => {
      if (!toolbox) return;
      const kind = candidate.kind === 'server' ? 'servers' : 'skills';
      if (toolbox[kind].some((e) => e.id === candidate.id)) {
        setStatus(`${candidate.label} is already in your toolbox.`);
        return;
      }
      void persist({
        ...toolbox,
        [kind]: [
          ...toolbox[kind],
          {
            id: candidate.id,
            label: candidate.label,
            detail: candidate.detail,
            enabled: true,
            scope: candidate.suggestedScope,
          },
        ],
      });
      setStatus(`Added ${candidate.label}.`);
    },
    [toolbox, persist],
  );

  if (!toolbox) {
    return <div style={s.pane}><p style={s.hint}>{error ?? 'Loading…'}</p></div>;
  }

  const renderList = (kind: 'servers' | 'skills', empty: string) => (
    <div style={s.card}>
      {toolbox[kind].length === 0 ? (
        <p style={s.hint}>{empty}</p>
      ) : (
        toolbox[kind].map((entry) => (
          <div key={entry.id} style={s.listRow}>
            <div style={s.listText}>
              <span style={s.listLabel}>{entry.label || entry.id}</span>
              <span style={s.listDetail}>{entry.detail || entry.id}</span>
            </div>
            <select
              style={s.select}
              aria-label={`${entry.label || entry.id} permission scope`}
              value={entry.scope}
              onChange={(e) => updateEntry(kind, entry.id, { scope: e.target.value as ToolScope })}
            >
              {SCOPES.map((scope) => (
                <option key={scope} value={scope}>{scope}</option>
              ))}
            </select>
            <Toggle
              on={entry.enabled}
              label={entry.label || entry.id}
              onChange={(next) => updateEntry(kind, entry.id, { enabled: next })}
            />
            <button
              style={s.btn}
              title="Remove from the toolbox"
              onClick={() => removeEntry(kind, entry.id)}
            >
              Remove
            </button>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div style={s.pane}>
      <div style={s.section}>
        <span style={s.label}>MCP servers</span>
        {renderList('servers', 'No servers yet. Search the registry to add one.')}
      </div>

      <div style={s.section}>
        <span style={s.label}>Skills</span>
        {renderList('skills', 'No skills yet. Search the registry to add one.')}
      </div>

      <div style={s.row}>
        <button style={s.btnPrimary} onClick={() => setSearchOpen(true)}>Search registry</button>
      </div>
      {status && <p style={s.note}>{status}</p>}
      {error && <p style={s.error}>{error}</p>}
      <p style={s.hint}>
        Scopes: {SCOPES.map((sc) => `${sc} (${SCOPE_HINT[sc].toLowerCase()})`).join(', ')}.
        Nothing is installed automatically; searching only lists candidates.
      </p>

      {searchOpen && (
        <RegistryModal onAdd={addCandidate} onClose={() => setSearchOpen(false)} />
      )}
    </div>
  );
}

/** Candidate list only. Add is always an explicit click, never automatic. */
function RegistryModal({
  onAdd,
  onClose,
}: {
  onAdd: (candidate: RegistryCandidate) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [candidates, setCandidates] = useState<RegistryCandidate[]>([]);

  useEffect(() => {
    const id = setTimeout(() => {
      api.searchRegistry(q).then((r) => setCandidates(r.candidates)).catch(() => setCandidates([]));
    }, 200);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <>
      <div style={modalStyles.overlay} onClick={onClose} />
      <div style={modalStyles.modal}>
        <div style={s.spread}>
          <span style={s.label}>Registry</span>
          <button style={s.btn} onClick={onClose}>Close</button>
        </div>
        <input
          style={s.input}
          autoFocus
          placeholder="Search servers and skills"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div style={modalStyles.list}>
          {candidates.length === 0 ? (
            <p style={s.hint}>Nothing matches that.</p>
          ) : (
            candidates.map((c) => (
              <div key={`${c.kind}:${c.id}`} style={s.listRow}>
                <div style={s.listText}>
                  <span style={s.listLabel}>{c.label}</span>
                  <span style={s.listDetail}>{c.detail}</span>
                </div>
                <span style={s.listDetail}>{c.kind}</span>
                <button style={s.btnPrimary} onClick={() => onAdd(c)}>Add</button>
              </div>
            ))
          )}
        </div>
        <p style={s.hint}>Adding puts an entry in your toolbox. It installs nothing.</p>
      </div>
    </>
  );
}

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1001 },
  modal: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 1002,
    width: 460,
    maxWidth: '92vw',
    maxHeight: '70vh',
    overflowY: 'auto',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-md, 10px)',
    boxShadow: 'var(--glass-shadow-modal)',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  list: { display: 'flex', flexDirection: 'column' },
};
