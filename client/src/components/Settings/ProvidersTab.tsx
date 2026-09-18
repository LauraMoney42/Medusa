import { useCallback, useEffect, useState } from 'react';
import * as api from '../../api';
import type { ProviderKeyStatus, ProviderVerifyResult } from '../../api';
import { s } from './settingsStyles';

/**
 * Providers tab (W8): the one place to add an API key without hand-editing
 * ~/.claude-chat/settings.json. Covers OpenRouter (chat) plus the external
 * voice services (Gemini for Live voice, OpenAI, Deepgram) — the same
 * `providers.<id>.apiKey` slot the server has always read, now with a UI in
 * front of it.
 *
 * Each card shows where its key currently comes from (Settings takes
 * precedence over an env var), lets you paste and save a new one, verify it
 * with one cheap authenticated call, or remove it.
 */

interface CardState {
  draft: string;
  saving: boolean;
  verifying: boolean;
  removing: boolean;
  verifyResult: ProviderVerifyResult | null;
  error: string | null;
}

const emptyCard: CardState = {
  draft: '',
  saving: false,
  verifying: false,
  removing: false,
  verifyResult: null,
  error: null,
};

export default function ProvidersTab() {
  const [providers, setProviders] = useState<ProviderKeyStatus[] | null>(null);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .fetchProviderKeys()
      .then((r) => setProviders(r.providers))
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cardFor = (id: string): CardState => cards[id] ?? emptyCard;
  const patchCard = (id: string, fields: Partial<CardState>) =>
    setCards((prev) => ({ ...prev, [id]: { ...cardFor(id), ...fields } }));

  const handleSave = useCallback(async (id: string) => {
    const draft = cardFor(id).draft.trim();
    if (!draft) return;
    patchCard(id, { saving: true, error: null, verifyResult: null });
    try {
      await api.saveProviderKey(id, draft);
      patchCard(id, { saving: false, draft: '' });
      load();
    } catch (e) {
      patchCard(id, { saving: false, error: e instanceof Error ? e.message : 'Save failed' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, load]);

  const handleVerify = useCallback(async (id: string) => {
    const draft = cardFor(id).draft.trim();
    patchCard(id, { verifying: true, error: null, verifyResult: null });
    try {
      const result = await api.verifyProviderKey(id, draft || undefined);
      patchCard(id, { verifying: false, verifyResult: result });
    } catch (e) {
      patchCard(id, { verifying: false, error: e instanceof Error ? e.message : 'Verify failed' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  const handleRemove = useCallback(async (id: string) => {
    patchCard(id, { removing: true, error: null, verifyResult: null });
    try {
      await api.removeProviderKey(id);
      patchCard(id, { removing: false });
      load();
    } catch (e) {
      patchCard(id, { removing: false, error: e instanceof Error ? e.message : 'Remove failed' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  if (!providers) {
    return <div style={s.pane}><p style={s.hint}>{loadError ?? 'Loading…'}</p></div>;
  }

  return (
    <div style={s.pane}>
      <p style={s.hint}>
        API keys for the providers below, stored in ~/.claude-chat/settings.json with
        owner-only file permissions. A key set here is picked up the next time it's
        used — nothing needs a restart.
      </p>

      {providers.map((p) => {
        const card = cardFor(p.id);
        return (
          <div key={p.id} style={s.card}>
            <div style={s.spread}>
              <span style={s.fieldLabel}>{p.displayName}</span>
              <StatusPill status={p} />
            </div>

            {p.hasKey && (
              <p style={s.hint}>
                {p.source === 'settings' ? 'Key' : 'Env var key'} ending in{' '}
                <code>{p.last4 ?? '????'}</code>.
              </p>
            )}

            <div style={s.field}>
              <label style={s.fieldLabel} htmlFor={`provider-key-${p.id}`}>
                {p.hasKey ? 'Replace key' : 'API key'}
              </label>
              <input
                id={`provider-key-${p.id}`}
                type="password"
                autoComplete="off"
                style={s.input}
                placeholder={p.hasKey ? 'Paste a new key to replace it' : 'Paste your API key'}
                value={card.draft}
                onChange={(e) => patchCard(p.id, { draft: e.target.value, verifyResult: null })}
              />
            </div>

            <div style={s.row}>
              <button
                style={s.btnPrimary}
                onClick={() => handleSave(p.id)}
                disabled={card.saving || !card.draft.trim()}
              >
                {card.saving ? 'Saving…' : 'Save'}
              </button>
              <button
                style={s.btn}
                onClick={() => handleVerify(p.id)}
                disabled={card.verifying || (!card.draft.trim() && !p.hasKey)}
              >
                {card.verifying ? 'Verifying…' : 'Verify'}
              </button>
              {p.hasKey && p.source === 'settings' && (
                <button style={s.btnDanger} onClick={() => handleRemove(p.id)} disabled={card.removing}>
                  {card.removing ? 'Removing…' : 'Remove'}
                </button>
              )}
              {p.keyUrl && (
                <a href={p.keyUrl} target="_blank" rel="noreferrer" style={{ ...s.hint, marginLeft: 'auto' }}>
                  Get a key
                </a>
              )}
            </div>

            {card.verifyResult && (
              <p style={card.verifyResult.ok ? s.note : s.error}>{card.verifyResult.message}</p>
            )}
            {card.error && <p style={s.error}>{card.error}</p>}
          </div>
        );
      })}
    </div>
  );
}

function StatusPill({ status }: { status: ProviderKeyStatus }) {
  const label =
    status.source === 'settings' ? 'Set via settings' : status.source === 'env' ? 'Set via env' : 'Not set';
  const color = status.hasKey ? '#4aba6a' : 'var(--text-muted)';
  const bg = status.hasKey ? 'rgba(74,186,106,0.15)' : 'rgba(255,255,255,0.08)';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color,
        background: bg,
        padding: '2px 8px',
        borderRadius: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}
    >
      {label}
    </span>
  );
}
