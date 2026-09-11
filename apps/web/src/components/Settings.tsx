import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import * as api from '../notes-api.js';
import { Confirm } from './Confirm.js';
import { LabelEditor, type LabelItem } from './LabelEditor.js';

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
 * the section header carries one way out for all its pages.
 *
 * The list is the shared `LabelEditor`, Keep's editing screen, which the Android app
 * adopted first. What this page adds is what a notebook has that a tag does not: the
 * two-option delete, because a notebook's notes have somewhere to go, and the way to its
 * custom fields. The per-notebook Export link that used to sit on every row is gone —
 * the note list's export, filtered to the notebook, is the same archive, and a row that
 * carried Fields, Export and Delete was three verbs beside a name that mostly wanted to
 * be read.
 */
export function Settings({ onChanged }: SettingsProps) {
  const [notebooks, setNotebooks] = useState<api.Notebook[] | null>(null);
  /** Notebook awaiting an explicit delete choice. */
  const [pendingDelete, setPendingDelete] = useState<api.Notebook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setNotebooks((await api.listNotebooks()).notebooks);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs a mutation, refreshes both this panel and the app behind it. True when it went through. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      onChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
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

  const byId = (item: LabelItem) => notebooks?.find((n) => n.id === item.id);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Notebooks</h2>
      </div>

      {error && <p className="bad small">{error}</p>}

      <LabelEditor
        kind="notebook"
        items={notebooks}
        busy={busy}
        editingId={pendingDelete?.id ?? null}
        onCreate={(name) => run(() => api.createNotebook(name))}
        onRename={(item, name) => run(() => api.renameNotebook(item.id, name))}
        onDelete={(item) => {
          const nb = byId(item);
          if (nb) setPendingDelete(nb);
        }}
        /* Navigation to the notebook's own page, so a link. The count says at a glance
           which notebooks are collections of records. */
        renderExtra={(item) => {
          const fields = byId(item)?.fields ?? 0;
          return (
            <Link
              to="/settings/notebooks/$notebookId"
              params={{ notebookId: item.id }}
              className="link small label-extra"
            >
              Fields{fields > 0 && <span className="tag-count"> {fields}</span>}
            </Link>
          );
        }}
        emptyText="No notebooks yet."
        hint="Renaming a notebook updates every note in it. Deleting one leaves its notes unfiled unless you choose to move them to Trash."
      />

      {pendingDelete && (
        <Confirm
          label="Confirm delete notebook"
          question={
            <>
              Delete the notebook <strong>{pendingDelete.name}</strong>?
            </>
          }
          detail={
            (noteLabel
              ? `Its ${noteLabel} will become unfiled, not deleted.`
              : 'It has no notes.') +
            (pendingDelete.fields > 0
              ? ` Its ${pendingDelete.fields} custom field${pendingDelete.fields === 1 ? '' : 's'} and their values will be deleted.`
              : '')
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
    </div>
  );
}
