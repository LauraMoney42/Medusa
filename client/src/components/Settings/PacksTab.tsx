import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api';
import type { InstalledPack } from '../../api';
import { downloadPack, importPackFile, PACK_EXTENSION } from '../../packs';
import { s } from './settingsStyles';

/**
 * Packs: export the current setup as one file, import someone else's, and
 * manage what is installed.
 *
 * Importing always backs the current set up first (the server writes a
 * snapshot under the Medusa folder), so trying a pack is never a one-way door.
 * A pack can also be dropped anywhere on the window; App.tsx routes those here
 * through the same importer.
 */

export default function PacksTab() {
  const [packs, setPacks] = useState<InstalledPack[]>([]);
  const [name, setName] = useState('My Medusa setup');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(() => {
    api.fetchPacks().then((r) => setPacks(r.packs)).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(refresh, [refresh]);

  const handleExport = useCallback(async () => {
    setBusy(true);
    try {
      const pack = await api.exportPack({ name, author, description });
      downloadPack(pack, pack.manifest.name.replace(/[^\w.-]+/g, '-').toLowerCase());
      setStatus(`Exported ${pack.manifest.name}${PACK_EXTENSION}.`);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }, [name, author, description]);

  const handleImport = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      try {
        const manifest = await importPackFile(file);
        setStatus(`Applied ${manifest.name}. Your previous setup was backed up.`);
        setError(null);
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Import failed');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const handleApply = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const result = await api.applyPack(id);
      setStatus(`Applied ${result.manifest.name}.`);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRemove = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const result = await api.removePack(id);
      setPacks(result.packs);
      setStatus('Pack removed. Your current settings are unchanged.');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div style={s.pane}>
      <div style={s.section}>
        <span style={s.label}>Export this setup</span>
        <div style={s.card}>
          <div style={s.field}>
            <label style={s.fieldLabel} htmlFor="pack-name">Pack name</label>
            <input id="pack-name" style={s.input} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div style={s.field}>
            <label style={s.fieldLabel} htmlFor="pack-author">Author</label>
            <input
              id="pack-author"
              style={s.input}
              placeholder="Your name or handle"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            />
          </div>
          <div style={s.field}>
            <label style={s.fieldLabel} htmlFor="pack-desc">Description</label>
            <input
              id="pack-desc"
              style={s.input}
              placeholder="What makes this setup worth sharing"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div style={s.row}>
            <button style={s.btnPrimary} onClick={handleExport} disabled={busy}>
              Export current setup
            </button>
            <button style={s.btn} onClick={() => fileRef.current?.click()} disabled={busy}>
              Import a pack
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={`${PACK_EXTENSION},application/json,.json`}
              style={{ display: 'none' }}
              onChange={(e) => void handleImport(e.target.files?.[0])}
            />
          </div>
          <p style={s.hint}>
            One file carries the persona, rules, theme, voice and toolbox. You can also
            drop a {PACK_EXTENSION} file anywhere on the window.
          </p>
        </div>
      </div>

      <div style={s.section}>
        <span style={s.label}>Installed packs</span>
        <div style={s.card}>
          {packs.length === 0 ? (
            <p style={s.hint}>Nothing imported yet.</p>
          ) : (
            packs.map((p) => (
              <div key={p.id} style={s.listRow}>
                <div style={s.listText}>
                  <span style={s.listLabel}>
                    {p.manifest.name} <span style={s.listDetail}>v{p.manifest.version}</span>
                  </span>
                  <span style={s.listDetail}>
                    {p.manifest.description || p.manifest.author || `${p.ruleCount} rules`}
                  </span>
                </div>
                <button style={s.btnPrimary} onClick={() => void handleApply(p.id)} disabled={busy}>
                  Apply
                </button>
                <button style={s.btnDanger} onClick={() => void handleRemove(p.id)} disabled={busy}>
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {status && <p style={s.note}>{status}</p>}
      {error && <p style={s.error}>{error}</p>}
    </div>
  );
}
