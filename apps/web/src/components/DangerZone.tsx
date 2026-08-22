import { useState } from 'react';
import * as api from '../notes-api.js';

interface DangerZoneProps {
  onChanged: () => void;
}

type Pending = 'trashed' | 'all' | null;

/**
 * Irreversible maintenance: emptying the trash, wiping the account, sweeping orphaned
 * blobs. Useful mainly for repeating a trial import.
 *
 * A full wipe asks for typed confirmation rather than a yes/no dialog. Deleting every note
 * is not a thing to do by muscle memory, and the extra friction is the point.
 */
export function DangerZone({ onChanged }: DangerZoneProps) {
  const [pending, setPending] = useState<Pending>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await action());
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
      setTyped('');
    }
  }

  const purge = (scope: 'trashed' | 'all') =>
    run(async () => {
      const r = await api.purgeNotes(scope);
      return `Deleted ${r.notesDeleted} note${r.notesDeleted === 1 ? '' : 's'} and ${
        r.filesDeleted
      } file${r.filesDeleted === 1 ? '' : 's'}.`;
    });

  const sweep = () =>
    run(async () => {
      const r = await api.gcBlobs(true);
      return r.orphaned === 0
        ? `Nothing to sweep — ${r.stored} file${r.stored === 1 ? '' : 's'}, all referenced.`
        : `Removed ${r.deleted} orphaned file${r.deleted === 1 ? '' : 's'}.`;
    });

  return (
    <div className="danger-zone">
      <h3>Maintenance</h3>

      <div className="danger-actions">
        <button type="button" className="link" disabled={busy} onClick={() => void purge('trashed')}>
          Empty trash
        </button>
        <button type="button" className="link" disabled={busy} onClick={() => void sweep()}>
          Sweep orphaned files
        </button>
        <button
          type="button"
          className="link danger"
          disabled={busy}
          onClick={() => setPending(pending === 'all' ? null : 'all')}
        >
          Delete all notes
        </button>
      </div>

      {pending === 'all' && (
        <div className="danger-confirm">
          <p className="small">
            This permanently deletes every note and attachment in this account. Export first
            if you want a copy. Type <code>DELETE</code> to confirm.
          </p>
          <div className="danger-confirm-row">
            <input
              className="search-field"
              value={typed}
              placeholder="DELETE"
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
            <button
              type="button"
              className="primary"
              disabled={typed !== 'DELETE' || busy}
              onClick={() => void purge('all')}
            >
              {busy ? 'Deleting…' : 'Delete everything'}
            </button>
            <button type="button" className="link" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && <p className="good small">{result}</p>}
      {error && <p className="bad small">{error}</p>}
    </div>
  );
}
