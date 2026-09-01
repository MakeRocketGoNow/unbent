import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../notes-api.js';
import { trashQuery, invalidateNoteMembership } from '../queries.js';
import { useNotesLayout, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from '../useNotesLayout.js';
import { ResizeHandle } from './ResizeHandle.js';
import { NoteListItem } from './NoteListItem.js';
import { Confirm } from './Confirm.js';
import { Button } from './Button.js';
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
  // `open` is undefined unless a trashed note is on screen; used both to leave the view
  // when that note disappears and, on mobile, to decide which pane is showing.
  const layout = useNotesLayout('/trash/$noteId');
  const open = layout.open;
  /** Note awaiting an explicit "delete forever", or 'all' for emptying the trash. */
  const [pending, setPending] = useState<{ id: string; title: string } | 'all' | null>(null);
  const empty = useMaintenance();

  const notes = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? notes.length;

  /** Refetches the trash, and steps away from the open note if it is the one that left. */
  async function afterRemoval(id: string) {
    await queryClient.invalidateQueries({ queryKey: ['trash'] });
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    // Restoring files a note back into its notebook and tags; destroying it takes those
    // counts down for good. Both move the sidebar.
    invalidateNoteMembership(queryClient);
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
    <div className={layout.className} style={layout.style} ref={layout.containerRef}>
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

        {/* The way out is the topbar, which marks Trash active while you are here — the
            same link that got you in. A second one in the sidebar was the old toggle's
            leftover, from when there was nothing in the chrome to go back to. */}
        <Link to="/notes" className="trash-back">
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
                  {/* Quiet, not outlined: these repeat on every row, and a grid of
                      bordered buttons would out-shout the notes they act on. */}
                  <Button variant="quiet" size="small" onClick={() => void restore(n.id)}>
                    Restore
                  </Button>
                  <Button
                    variant="quiet"
                    tone="danger"
                    size="small"
                    onClick={() => setPending({ id: n.id, title: n.title })}
                  >
                    Delete forever
                  </Button>
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

      <ResizeHandle
        label="Resize sidebar"
        containerRef={layout.containerRef}
        toValue={(clientX, rect) => clientX - rect.left}
        value={layout.width}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        step={16}
        defaultValue={SIDEBAR_DEFAULT}
        onResize={layout.onResize}
        onCommit={layout.onResizeCommit}
      />

      {children}
    </div>
  );
}
