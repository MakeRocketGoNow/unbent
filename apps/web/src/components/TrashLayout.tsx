import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import * as actions from '../store/actions.js';
import { trashQuery, invalidateNoteMembership } from '../queries.js';
import { useNotesLayout, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from '../useNotesLayout.js';
import { ResizeHandle } from './ResizeHandle.js';
import { NoteListItem } from './NoteListItem.js';
import { useListKeys } from '../useListKeys.js';
import { Confirm } from './Confirm.js';
import { Button } from './Button.js';
import { BackArrow } from './BackArrow.js';
import { useMaintenance } from './use-maintenance.js';
import { useExactCount } from './use-exact-count.js';
import { useSelection } from '../useSelection.js';
import { SelectionBar } from './SelectionBar.js';
import { RestoreIcon, TrashIcon } from './icons.js';
import { useListMotion } from '../list-motion.js';

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
  // Restored and deleted rows leave rather than vanish; see `list-motion.ts`.
  const listMotionRef = useListMotion<HTMLUListElement>();
  const onListKeys = useListKeys();
  const open = layout.open;
  /**
   * Note awaiting an explicit "delete forever", 'selected' for the selection, or 'all'
   * for emptying the trash.
   */
  const [pending, setPending] = useState<
    { id: string; title: string } | 'selected' | 'all' | null
  >(null);
  const empty = useMaintenance();

  const notes = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? notes.length;
  // The number emptying the trash names, counted from the notes; see `useExactCount`.
  const toEmpty = useExactCount(pending === 'all' ? { trashed: true } : null, total);

  /*
   * Several at once, as the note list has it — see `useSelection`. Restoring a dozen
   * notes trashed by mistake, or destroying the dozen that were not, is the trash's
   * whole job, and it was one row at a time. Nothing here changes the scope, so nothing
   * resets it but opening a note, which drops it as the list's does.
   */
  const rowIds = notes.map((n) => n.id);
  const selection = useSelection(rowIds, { anchor: open, resetKey: 'trash' });
  const { clear: clearSelection } = selection;
  useEffect(() => {
    clearSelection();
  }, [open, clearSelection]);
  const onListKeysWithSelection = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && selection.active) {
      event.preventDefault();
      selection.clear();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selection.selectAll();
      return;
    }
    onListKeys(event);
  };

  /** Refetches the trash, and steps away from the open note if it is the one that left. */
  async function afterRemoval(id: string) {
    await queryClient.invalidateQueries({ queryKey: ['trash'] });
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    // Restoring adds a note back to search results; destroying removes one that was there.
    void queryClient.invalidateQueries({ queryKey: ['search'] });
    // Restoring files a note back into its notebook and tags; destroying it takes those
    // counts down for good. Both move the sidebar.
    invalidateNoteMembership(queryClient);
    if (open === id) void navigate({ to: '/trash' });
  }

  async function restore(id: string) {
    await actions.restoreNote(id);
    await afterRemoval(id);
  }

  /**
   * Destroys one trashed note for good.
   *
   * Confirmed because it is the only irreversible action reachable from the note list —
   * the ordinary Delete is a move to trash, which this view exists to undo.
   */
  async function destroy(id: string) {
    await actions.purgeNote(id);
    setPending(null);
    await afterRemoval(id);
  }

  /**
   * The selection's two verbs, through the same runner as Empty trash: it tracks busy
   * and error, and its unscoped invalidation is right here too, since either changes
   * what every list and count holds. The open note leaves with the rest.
   */
  const restoreSelected = () => {
    const ids = selection.ids;
    return empty.run(async () => {
      const n = await actions.restoreNotes(ids);
      selection.clear();
      if (open && ids.includes(open)) void navigate({ to: '/trash' });
      return `Restored ${n} note${n === 1 ? '' : 's'}.`;
    });
  };
  const destroySelected = () => {
    const ids = selection.ids;
    return empty.run(async () => {
      const n = await actions.purgeNotes(ids);
      setPending(null);
      selection.clear();
      if (open && ids.includes(open)) void navigate({ to: '/trash' });
      return `Deleted ${n} note${n === 1 ? '' : 's'}.`;
    });
  };

  return (
    <div className={layout.className} style={layout.style} ref={layout.containerRef}>
      <aside className="sidebar">
        {/*
            The way back, on a phone only.

            This was a full-width bordered button sitting below the confirms and above the
            list — a third shape for a gesture the note and settings views answer with an
            arrow in the top-left corner. It is that arrow now, and it moved to the top of
            the view because a control that leaves belongs before the thing it leaves, not
            buried in the middle of it.

            Above the breakpoint it is hidden: the rail marks Trash current while you are
            here, strip or open, so the row that got you in is also the way out. That was
            already true when this was a button — the button was the old toggle's
            leftover, from when there was nothing in the chrome to go back to.
        */}
        <div className="trash-head">
          <Link to="/notes" className="view-back" aria-label="Back to notes">
            <BackArrow />
          </Link>
          <h2>Trash</h2>
        </div>

        <div className="sidebar-head">
          <span className="count">{total} in trash</span>
          {/* Offered here as well as on the maintenance page: this is the one place you
              can see what you are about to destroy, and restore something instead. */}
          {total > 0 && (
            <Button
              variant="secondary"
              tone="danger"
              size="small"
              disabled={empty.busy}
              onClick={() => setPending('all')}
            >
              Empty trash
            </Button>
          )}
        </div>

        {pending === 'all' && (
          <Confirm
            label="Confirm empty trash"
            question={`Permanently delete all ${toEmpty} note${toEmpty === 1 ? '' : 's'} and their attachments?`}
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
                    const r = await actions.emptyTrash(notes.map((n) => n.id));
                    setPending(null);
                    if (open) void navigate({ to: '/trash' });
                    return `Deleted ${r.notesDeleted} note${r.notesDeleted === 1 ? '' : 's'}.`;
                  }),
              },
            ]}
          />
        )}

        {pending === 'selected' && selection.active && (
          <Confirm
            label="Confirm delete selected notes forever"
            question={`Permanently delete ${selection.ids.length} ${selection.ids.length === 1 ? 'note' : 'notes'}?`}
            detail="Their attachments go too. This cannot be undone."
            busy={empty.busy}
            onCancel={() => setPending(null)}
            actions={[
              {
                label: 'Delete forever',
                busyLabel: 'Deleting…',
                tone: 'danger',
                onConfirm: destroySelected,
              },
            ]}
          />
        )}

        {/* Rendered at the top of the sidebar rather than inside the row: a list item is
            too narrow to hold a question and two buttons, and the note is named here. */}
        {pending && pending !== 'all' && pending !== 'selected' && (
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

        {list.error && <p className="bad small">{(list.error as Error).message}</p>}

        <ul
          className={selection.active ? 'note-list selecting' : 'note-list'}
          ref={listMotionRef}
          aria-multiselectable
          onKeyDown={onListKeysWithSelection}
        >
          {notes.map((n) => (
            <NoteListItem
              key={n.id}
              note={n}
              to="/trash/$noteId"
              selection={{
                selected: selection.has(n.id),
                active: selection.active,
                onPick: (opts) => selection.pick(n.id, opts),
              }}
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
            <li data-motion-key="more">
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
            <li className="muted small empty" data-motion-key="empty">
              Trash is empty.
            </li>
          )}
        </ul>

        {selection.active && (
          <SelectionBar
            count={selection.ids.length}
            total={rowIds.length}
            onClear={selection.clear}
            onSelectAll={selection.selectAll}
          >
            <button
              type="button"
              className="icon-btn"
              aria-label="Restore"
              title="Restore"
              disabled={empty.busy}
              onClick={() => void restoreSelected()}
            >
              <RestoreIcon />
            </button>
            <button
              type="button"
              className="icon-btn danger"
              aria-label="Delete forever"
              title="Delete forever"
              disabled={empty.busy}
              onClick={() => setPending('selected')}
            >
              <TrashIcon />
            </button>
          </SelectionBar>
        )}
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
