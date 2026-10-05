import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import * as api from '../notes-api.js';
import { LabelEditor, type LabelItem } from './LabelEditor.js';
import { NotebookChooser } from './NotebookChooser.js';
import { rememberedSort } from '../notebook-sort.js';
import { DeleteNotebookConfirm } from './DeleteNotebookConfirm.js';
import { DownloadIcon, FieldsIcon } from './icons.js';
import { startExport, useExportRunning } from '../export-archive.js';

interface SettingsProps {
  /** Called after any change, so the note list and sidebar refetch. */
  onChanged: () => void;
  /**
   * Set when the page was opened to make a notebook — the rail's New notebook, which
   * links here with `?new=1` — so the chooser is open on arrival. Each request is acted
   * on once and handed back through `onCreateRequested`, which drops it from the URL, so
   * the rail's row opens the chooser again when the page is already here.
   */
  createRequested?: boolean;
  onCreateRequested?: () => void;
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
 * custom fields, and a download of the notebook as a zip.
 *
 * That download left once and came back. It went because a row carrying Fields, Export
 * and Delete was three verbs beside a name that mostly wanted to be read, and the note
 * list's export filtered to the notebook is the same archive. It returned because that
 * route is buried — filter the list, then find the export beneath the filters — and this
 * page is where a person thinking "I want a copy of this notebook" already is. It comes
 * back as a glyph rather than a word, so the row still reads as a name — and drawn as
 * the pencil is, a muted icon button, not as a link. In the link's green at text size it
 * read as part of "Fields"; grey beside the pencil it reads as what it is, one of the
 * row's two actions, with Fields left alone as the row's one navigation.
 */
export function Settings({ onChanged, createRequested = false, onCreateRequested }: SettingsProps) {
  const exportRunning = useExportRunning();
  const navigate = useNavigate();
  /*
   * Whether the chooser is open. Null until someone opens or closes it, and while it is
   * null an empty list has it open: with no notebooks, the chooser is what the page is
   * for. Derived rather than set by an effect when the list arrives, so it is open in the
   * first frame that knows the list is empty and never flickers shut first.
   */
  const [chooserChoice, setChooserChoice] = useState<boolean | null>(null);

  useEffect(() => {
    if (!createRequested) return;
    setChooserChoice(true);
    onCreateRequested?.();
  }, [createRequested, onCreateRequested]);
  const [notebooks, setNotebooks] = useState<api.Notebook[] | null>(null);
  /** Notebook awaiting an explicit delete choice. */
  const [pendingDelete, setPendingDelete] = useState<api.Notebook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chooserOpen = chooserChoice ?? notebooks?.length === 0;

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
        /* A notebook's name is edited on its own page now, so the list does not rename in
           place; `onRename` stays only to satisfy the shared editor's contract and is never
           reached while `rowHref` is set. */
        onRename={(item, name) => run(() => api.renameNotebook(item.id, name))}
        onDelete={(item) => {
          const nb = byId(item);
          if (nb) setPendingDelete(nb);
        }}
        /* The row leads to the notebook's own page — its name, purpose, fields and delete.
           The list is a way in, not a place to correct a name in passing. */
        rowHref={(item) => `/settings/notebooks/${item.id}`}
        /* The note count sits right after the name, the way a field's value count sits
           after the field name on the notebook's own page. It said at the far right, a
           second bare number beside "Fields N", read as more fields; against the name it
           is plainly the notebook's size. Silent at zero, as it is there. */
        renderNameCount={(item) =>
          item.count > 0 ? (
            <span className="tag-count" title={`${item.count} note${item.count === 1 ? '' : 's'}`}>
              {item.count}
            </span>
          ) : null
        }
        /* The row leads to the notebook's page now, so the old "Fields" link here — a second
           way to the same place — is gone. What it also carried, the field count, comes back
           as a plain glyph-and-number: how many custom fields the notebook has, which is what
           says at a glance which notebooks are collections of records. Silent at zero, the
           way the note count is, so a notebook with no fields shows nothing rather than a grey
           zero. Not a link, since the row already leads to where the fields are edited.

           The download is a button: the archive is built in this tab from pages of notes
           (see `export-archive.ts`), and a browser that can asks where to save it first.
           It wears `icon-btn` for the 44px box; the class is only styling. One export runs
           at a time, so the button waits while another does. */
        renderExtra={(item) => {
          const fields = byId(item)?.fields ?? 0;
          return (
            <>
              {fields > 0 && (
                <span
                  className="label-field-count muted small"
                  title={`${fields} custom field${fields === 1 ? '' : 's'}`}
                >
                  <FieldsIcon />
                  {fields}
                </span>
              )}
              <button
                type="button"
                className="icon-btn label-download"
                disabled={exportRunning}
                onClick={() => startExport({ notebook: item.name })}
                title={`Download ${item.name} as a zip`}
                aria-label={`Download ${item.name} as a zip`}
              >
                <DownloadIcon />
              </button>
            </>
          );
        }}
        chooser={{
          open: chooserOpen,
          onOpenChange: setChooserChoice,
          render: (startBlank, close) => (
            <NotebookChooser
              existing={notebooks ?? []}
              intro={
                notebooks?.length === 0
                  ? 'Each note lives in one notebook. Tags can cut across them.'
                  : undefined
              }
              onBlank={startBlank}
              onClose={close}
              onApplied={() => {
                void refresh();
                onChanged();
              }}
              /* The new notebook, as its table: the columns are its fields, which is what
                 the template was for. On a phone the table cannot be drawn and the URL's
                 `view` is ignored, so the list opens instead. */
              onDone={(name) => {
                void navigate({
                  to: '/notes',
                  search: { notebook: name, view: 'table', ...rememberedSort(name) },
                });
              }}
            />
          ),
        }}
        emptyText="No notebooks yet."
        /* Hidden while there are none: it describes rows that do not exist yet, and returns
           with the first one. */
        hint={
          notebooks?.length
            ? 'Open a notebook to change its name and emoji, its purpose, or its fields. Deleting one leaves its notes unfiled unless you choose to move them to Trash.'
            : null
        }
      />

      {pendingDelete && (
        <DeleteNotebookConfirm
          name={pendingDelete.name}
          count={pendingDelete.count}
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
