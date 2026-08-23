import { useCallback, useEffect, useState } from 'react';
import * as api from '../notes-api.js';

interface SettingsProps {
  onClose: () => void;
  /** Called after any change, so the note list and sidebar refetch. */
  onChanged: () => void;
}

/**
 * Notebook management.
 *
 * A panel rather than a sidebar menu: creating a notebook has no natural home in a
 * dropdown, and keeping management out of the sidebar leaves the reading surface uncluttered.
 * Follows the same shape as the Import panel so there is one kind of panel in the app.
 */
export function Settings({ onClose, onChanged }: SettingsProps) {
  const [notebooks, setNotebooks] = useState<api.Notebook[]>([]);
  const [newName, setNewName] = useState('');
  /** Id of the notebook being renamed, with its in-progress value. */
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setNotebooks(await api.listNotebooks());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs a mutation, refreshes both this panel and the app behind it. */
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function create() {
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      await api.createNotebook(name);
      setNewName('');
    });
  }

  function commitRename() {
    if (!editing) return;
    const { id, value } = editing;
    const name = value.trim();
    const original = notebooks.find((n) => n.id === id)?.name;
    // A no-op rename would otherwise 409 against the notebook's own name.
    if (!name || name === original) {
      setEditing(null);
      return;
    }
    void run(async () => {
      await api.renameNotebook(id, name);
      setEditing(null);
    });
  }

  function remove(nb: api.Notebook) {
    // Name the consequence: the count is the thing the user needs to weigh.
    const consequence =
      nb.count > 0
        ? `Its ${nb.count} note${nb.count === 1 ? '' : 's'} will become unfiled, not deleted.`
        : 'It has no notes.';
    if (!confirm(`Delete the notebook "${nb.name}"?\n\n${consequence}`)) return;
    void run(() => api.deleteNotebook(nb.id));
  }

  return (
    <div className="import-panel">
      <div className="import-head">
        <h2>Notebooks</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>

      {error && <p className="bad small">{error}</p>}

      <ul className="notebook-admin">
        {notebooks.map((nb) => (
          <li key={nb.id}>
            {editing?.id === nb.id ? (
              <input
                className="search-field"
                value={editing.value}
                autoFocus
                disabled={busy}
                onChange={(e) => setEditing({ id: nb.id, value: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="notebook-admin-name"
                title="Rename"
                onClick={() => setEditing({ id: nb.id, value: nb.name })}
              >
                {nb.name}
                <span className="tag-count">{nb.count}</span>
              </button>
            )}

            <button
              type="button"
              className="link danger small"
              disabled={busy}
              onClick={() => remove(nb)}
            >
              Delete
            </button>
          </li>
        ))}

        {notebooks.length === 0 && <li className="muted small">No notebooks yet.</li>}
      </ul>

      <div className="notebook-admin-new">
        <input
          className="search-field"
          value={newName}
          placeholder="New notebook name"
          disabled={busy}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <button type="button" className="primary" disabled={busy || !newName.trim()} onClick={create}>
          Create
        </button>
      </div>

      <p className="muted small">
        Renaming a notebook updates every note in it. Deleting one leaves its notes in place,
        unfiled.
      </p>
    </div>
  );
}
