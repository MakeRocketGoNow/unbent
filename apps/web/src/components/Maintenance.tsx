import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as api from '../notes-api.js';
import { Confirm } from './Confirm.js';
import { useMaintenance } from './use-maintenance.js';
import { noteCountQuery, trashCountQuery } from '../queries.js';

type Pending = 'trashed' | 'all' | null;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Irreversible operations, gathered into one page.
 *
 * These lived at the bottom of the import panel, which meant the only route to "delete
 * all notes" was through Import — and they vanished mid-run, when a failed import is
 * exactly when you want them. A maintenance page has to list every destructive operation
 * to be worth trusting, so emptying the trash appears here as well as in the trash view.
 *
 * Weight runs opposite to blast radius: sweeping is an ordinary button, wiping the
 * account is the quietest control on the page.
 */
export function Maintenance() {
  const [pending, setPending] = useState<Pending>(null);
  const [sweep, setSweep] = useState<api.GcResult | null>(null);
  const { busy, result, error, run, reset } = useMaintenance();

  const trashCount = useQuery(trashCountQuery());
  const noteCount = useQuery(noteCountQuery());
  const trashed = trashCount.data ?? 0;
  const notes = noteCount.data ?? 0;

  const purge = (scope: 'trashed' | 'all') =>
    run(async () => {
      const r = await api.purgeNotes(scope);
      setPending(null);
      return `Deleted ${plural(r.notesDeleted, 'note')} and ${plural(r.filesDeleted, 'file')}.`;
    });

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Maintenance</h2>
      </div>

      <p className="muted small">
        Everything on this page is permanent. None of it touches the export, so take one
        first if you are unsure.
      </p>

      <section className="settings-section">
        <h3>Empty trash</h3>
        <p className="muted small">
          Permanently deletes every note in the Trash, and their attachments. Deleting a
          note normally only moves it here, so this is the step that actually frees the
          storage.
        </p>
        <button
          type="button"
          className="primary danger"
          disabled={busy || trashed === 0}
          onClick={() => {
            reset();
            setPending('trashed');
          }}
        >
          {trashed === 0 ? 'Trash is empty' : `Empty trash (${plural(trashed, 'note')})`}
        </button>

        {pending === 'trashed' && (
          <Confirm
            label="Confirm empty trash"
            question={`Permanently delete ${plural(trashed, 'note')} and their attachments?`}
            detail={
              <>
                This cannot be undone. <Link to="/trash">Review the trash</Link> first if
                you want to restore anything.
              </>
            }
            busy={busy}
            onCancel={() => setPending(null)}
            actions={[
              {
                label: 'Empty trash',
                busyLabel: 'Deleting…',
                tone: 'danger',
                onConfirm: () => purge('trashed'),
              },
            ]}
          />
        )}
      </section>

      <section className="settings-section">
        <h3>Orphaned files</h3>
        <p className="muted small">
          Storage objects with no attachment record — leftovers from an interrupted upload
          or import. Files you unlinked from a note still have a record and are not
          orphans; delete those from the note&apos;s Attachments list.
        </p>

        {/*
            Checked before deleting, using the dry run the API has always supported. The
            old single button destroyed first and reported the count afterwards, which is
            no help at all if the number is a surprise.
        */}
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => {
            reset();
            setSweep(null);
            void run(async () => {
              const r = await api.gcBlobs(false);
              setSweep(r);
              return r.orphaned === 0
                ? `Nothing to sweep — ${plural(r.stored, 'file')}, all referenced.`
                : `${r.orphaned} of ${plural(r.stored, 'file')} stored have no attachment record.`;
            });
          }}
        >
          Check for orphaned files
        </button>

        {sweep && sweep.orphaned > 0 && (
          <>
            <details className="failures">
              <summary className="small">
                {sweep.orphaned > sweep.keys.length
                  ? `Show the first ${sweep.keys.length} of ${sweep.orphaned}`
                  : `Show ${plural(sweep.orphaned, 'file')}`}
              </summary>
              <ul className="small">
                {sweep.keys.map((key) => (
                  <li key={key}>{key}</li>
                ))}
              </ul>
            </details>

            <button
              type="button"
              className="primary danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.gcBlobs(true);
                  setSweep(null);
                  return `Removed ${plural(r.deleted, 'orphaned file')}.`;
                })
              }
            >
              Delete {plural(sweep.orphaned, 'orphaned file')}
            </button>
          </>
        )}
      </section>

      <section className="settings-section">
        <h3>Delete all notes</h3>
        <p className="muted small">
          Empties the account: every note, trashed or not, and every attachment. Mainly
          useful for repeating a trial import.
        </p>
        {/* The quietest control here on purpose — nothing else on this page can do as much. */}
        <button
          type="button"
          className="link danger"
          disabled={busy}
          onClick={() => {
            reset();
            setPending(pending === 'all' ? null : 'all');
          }}
        >
          Delete all notes
        </button>

        {pending === 'all' && (
          <Confirm
            label="Confirm delete all notes"
            question={`Permanently delete all ${plural(notes, 'note')} and their attachments?`}
            detail={
              <>
                There is no undo. <Link to="/settings/export">Export first</Link> if you
                want a copy. Type <code>DELETE</code> to confirm.
              </>
            }
            requireTyped="DELETE"
            busy={busy}
            onCancel={() => setPending(null)}
            actions={[
              {
                label: 'Delete everything',
                busyLabel: 'Deleting…',
                tone: 'danger',
                onConfirm: () => purge('all'),
              },
            ]}
          />
        )}
      </section>

      {result && <p className="good small">{result}</p>}
      {error && <p className="bad small">{error}</p>}
    </div>
  );
}
