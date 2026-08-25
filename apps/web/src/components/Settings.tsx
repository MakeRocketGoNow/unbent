import { useCallback, useEffect, useState } from 'react';
import * as api from '../notes-api.js';
import { Confirm } from './Confirm.js';

interface SettingsProps {
  /** Called after any change, so the note list and sidebar refetch. */
  onChanged: () => void;
}

/**
 * Notebook management.
 *
 * A panel rather than a sidebar menu: creating a notebook has no natural home in a
 * dropdown, and keeping management out of the sidebar leaves the reading surface
 * uncluttered. Leaving is the settings section's job now, so there is no Close button —
 * the section header carries one way out for all four pages.
 */
export function Settings({ onChanged }: SettingsProps) {
  const [notebooks, setNotebooks] = useState<api.Notebook[]>([]);
  const [newName, setNewName] = useState('');
  /** Id of the notebook being renamed, with its in-progress value. */
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  /** Notebook awaiting an explicit delete choice. */
  const [pendingDelete, setPendingDelete] = useState<api.Notebook | null>(null);
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

  function confirmDelete(trashNotes: boolean) {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    void run(async () => {
      await api.deleteNotebook(id, { trashNotes });
      setPendingDelete(null);
    });
  }

  const noteLabel =
    pendingDelete && pendingDelete.count > 0
      ? `${pendingDelete.count} note${pendingDelete.count === 1 ? '' : 's'}`
      : null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Notebooks</h2>
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
              onClick={() => {
                setEditing(null);
                setPendingDelete(nb);
              }}
            >
              Delete
            </button>
          </li>
        ))}

        {notebooks.length === 0 && <li className="muted small">No notebooks yet.</li>}
      </ul>

      {pendingDelete && (
        <Confirm
          label="Confirm delete notebook"
          question={
            <>
              Delete the notebook <strong>{pendingDelete.name}</strong>?
            </>
          }
          detail={
            noteLabel
              ? `Its ${noteLabel} will become unfiled, not deleted.`
              : 'It has no notes.'
          }
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          // Order carries the emphasis: keeping the notes is offered first and reads as
          // the button, so the cascade has to be reached for deliberately.
          actions={[
            {
              label: 'Delete notebook',
              busyLabel: 'Deleting…',
              tone: 'primary',
              onConfirm: () => confirmDelete(false),
            },
            ...(noteLabel
              ? [
                  {
                    label: `Delete notebook and move ${noteLabel} to Trash`,
                    tone: 'danger' as const,
                    onConfirm: () => confirmDelete(true),
                  },
                ]
              : []),
          ]}
        />
      )}

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
        Renaming a notebook updates every note in it. Deleting one leaves its notes unfiled
        unless you choose to move them to Trash.
      </p>
    </div>
  );
}
