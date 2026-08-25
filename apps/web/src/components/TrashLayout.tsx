import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../notes-api.js';
import { trashQuery } from '../queries.js';
import { NoteListItem } from './NoteListItem.js';
import { Confirm } from './Confirm.js';
import { useMaintenance } from './use-maintenance.js';

/**
 * The trash sidebar.
 *
 * No search or filters here: the trash is a flat record of what was deleted, and a filter
 * hiding the note someone is hunting for would defeat the point of the view.
 */
export function TrashLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useInfiniteQuery(trashQuery());
  // Undefined unless a trashed note is open; used to leave the view when it disappears.
  const open = useParams({ from: '/trash/$noteId', shouldThrow: false })?.noteId;
  /** Note awaiting an explicit "delete forever", or 'all' for emptying the trash. */
  const [pending, setPending] = useState<{ id: string; title: string } | 'all' | null>(null);
  const empty = useMaintenance();

  const notes = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? notes.length;

  /** Refetches the trash, and steps away from the open note if it is the one that left. */
  async function afterRemoval(id: string) {
    await queryClient.invalidateQueries({ queryKey: ['trash'] });
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    if (open === id) void navigate({ to: '/trash' });
  }

  async function restore(id: string) {
    await api.restoreNote(id);
    await afterRemoval(id);
  }

  /**
   * Destroys one trashed note for good.
   *
   * Confirmed because it is the only irreversible action reachable from the note list —
   * the ordinary Delete is a move to trash, which this view exists to undo.
   */
  async function destroy(id: string) {
    await api.deleteNotePermanently(id);
    setPending(null);
    await afterRemoval(id);
  }

  return (
    <div className="notes">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="count">{total} in trash</span>
          {/* Offered here as well as on the maintenance page: this is the one place you
              can see what you are about to destroy, and restore something instead. */}
          {total > 0 && (
            <button
              type="button"
              className="link danger small"
              disabled={empty.busy}
              onClick={() => setPending('all')}
            >
              Empty trash
            </button>
          )}
        </div>

        {pending === 'all' && (
          <Confirm
            label="Confirm empty trash"
            question={`Permanently delete all ${total} note${total === 1 ? '' : 's'} and their attachments?`}
            detail="This cannot be undone. Restore anything you want to keep first."
            busy={empty.busy}
            onCancel={() => setPending(null)}
            actions={[
              {
                label: 'Empty trash',
                busyLabel: 'Deleting…',
                tone: 'danger',
                onConfirm: () =>
                  empty.run(async () => {
                    const r = await api.purgeNotes('trashed');
                    setPending(null);
                    if (open) void navigate({ to: '/trash' });
                    return `Deleted ${r.notesDeleted} note${r.notesDeleted === 1 ? '' : 's'}.`;
                  }),
              },
            ]}
          />
        )}

        {/* Rendered at the top of the sidebar rather than inside the row: a list item is
            too narrow to hold a question and two buttons, and the note is named here. */}
        {pending && pending !== 'all' && (
          <Confirm
            label="Confirm delete note forever"
            question={
              <>
                Permanently delete <strong>{pending.title || 'Untitled'}</strong>?
              </>
            }
            detail="Its attachments go too. This cannot be undone."
            onCancel={() => setPending(null)}
            actions={[
              {
                label: 'Delete forever',
                tone: 'danger',
                onConfirm: () => void destroy(pending.id),
              },
            ]}
          />
        )}

        {empty.error && <p className="bad small">{empty.error}</p>}

        <Link to="/notes" className="trash-toggle active">
          ← Back to notes
        </Link>

        {list.error && <p className="bad small">{(list.error as Error).message}</p>}

        <ul className="note-list">
          {notes.map((n) => (
            <NoteListItem
              key={n.id}
              note={n}
              to="/trash/$noteId"
              actions={
                <div className="trash-actions">
                  <button type="button" className="link" onClick={() => void restore(n.id)}>
                    Restore
                  </button>
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => setPending({ id: n.id, title: n.title })}
                  >
                    Delete forever
                  </button>
                </div>
              }
            />
          ))}

          {list.hasNextPage && (
            <li>
              <button
                type="button"
                className="load-more"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </li>
          )}

          {notes.length === 0 && !list.error && (
            <li className="muted small empty">Trash is empty.</li>
          )}
        </ul>
      </aside>

      {children}
    </div>
  );
}
