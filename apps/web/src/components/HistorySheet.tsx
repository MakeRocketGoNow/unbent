import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NoteRevisionSummary } from '@unbent/shared';
import { useOffline } from '../connectivity.js';
import * as api from '../notes-api.js';
import { keys, revisionQuery, revisionsQuery } from '../queries.js';
import * as actions from '../store/actions.js';
import { Button } from './Button.js';
import { formatRevisionWhen } from './format-when.js';
import { RowChevronIcon } from './icons.js';
import { Preview } from './Preview.js';
import { Sheet } from './Sheet.js';

interface HistorySheetProps {
  open: boolean;
  onClose: () => void;
  noteId: string;
  /** The ⋯ menu it was opened from, which the desktop panel lines up under. */
  anchor?: RefObject<HTMLElement | null>;
  /**
   * Resolves when what was on screen as the sheet opened has been handed to the save —
   * the workspace's flush. The list waits for it, and then for the outbox; see `list`.
   */
  saved?: () => Promise<unknown>;
  /**
   * Puts the copy back. Rejects with a message worth showing when it could not; the
   * sheet stays open on that and says so, and is closed by the caller on success.
   */
  onRestore: (revision: NoteRevisionSummary) => Promise<void>;
}

/**
 * What a copy is, in a few words under its time: what replaced it, when that was not
 * ordinary typing, and how much text it holds. The size is the useful half. The copy
 * someone opens this sheet for is nearly always "the long one, before it was gutted",
 * and a count says which that is without opening each in turn.
 */
export function describeRevision(revision: Pick<NoteRevisionSummary, 'cause' | 'size'>): string {
  const size =
    revision.size === 0
      ? 'Empty'
      : `${revision.size.toLocaleString()} ${revision.size === 1 ? 'character' : 'characters'}`;
  const before =
    revision.cause === 'assistant'
      ? 'Before an assistant’s edit'
      : revision.cause === 'restore'
        ? 'Before a restore'
        : null;
  return before ? `${before} · ${size}` : size;
}

/**
 * A note's history: the copies kept of what a write replaced, and a way to put one back
 * (MAK-119).
 *
 * A sheet, from the note's ⋯ menu. It is about the whole note rather than a place in it,
 * it holds a list that can run to twenty rows and then a page of text, and it is looked
 * at rarely — when something has gone wrong — so it earns no room in the note's own
 * chrome. Two pages in the one dialog, the list and then a copy, for the reason `Sheet`
 * gives for `onBack`: a second sheet over the first is two scrims.
 *
 * Read from the server every time it opens. History is not in the local copy of the
 * library, which is why the menu item fades offline with its neighbours.
 *
 * Restore has no confirmation, and that is a decision rather than an omission: `Confirm`
 * is for what cannot be taken back, and the server keeps what a restore replaces as the
 * newest copy in this same list. The line beside the button says so, because a button
 * that overwrites a note should say why it is safe to press.
 *
 * The copy is drawn by `Preview`, as the note itself would read, rather than as its
 * Markdown source: the question on this page is "is this the version I want", and that
 * is recognised by reading it. Its files resolve against the note as it is now, since
 * history keeps text and not files; one deleted since draws as a missing file would.
 */
export function HistorySheet({ open, onClose, noteId, anchor, saved, onRestore }: HistorySheetProps) {
  const queryClient = useQueryClient();
  /*
     The connection can go while the sheet is open, though the menu it opened from fades
     without one. What needs the server then fades in place, as that menu does: opening
     a version, and Restore.
  */
  const offline = useOffline();
  const offlineTitle = offline ? 'Not available offline' : undefined;
  const [picked, setPicked] = useState<NoteRevisionSummary | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /*
     The list is asked for only once this note's own writes have reached the server.

     The sheet is opened most urgently straight after the mistake: paste over a note,
     see it, open History. The save carrying that paste is the write that makes the
     server keep the text from before it, and it is still in the autosave's delay or the
     outbox when the sheet opens. Asked at once, the server answered without it, and the
     sheet said "No earlier versions yet" about a note whose earlier version arrived a
     moment later. A queue that will not drain is not waited out for ever (`synced`
     gives up); the list is then whatever the server has.
  */
  const list = useQuery({
    ...revisionsQuery(noteId),
    queryFn: async () => {
      await saved?.();
      await actions.synced(noteId);
      return api.listRevisions(noteId);
    },
    enabled: open,
  });
  const copy = useQuery({ ...revisionQuery(noteId, picked?.id ?? 0), enabled: open && picked !== null });

  // Opens on the list each time, and never on a copy of the note that was open before.
  useEffect(() => {
    if (open) return;
    setPicked(null);
    setFailure(null);
    setRestoring(false);
    /*
       And on "Loading…", not on the last opening's list. The sheet stays mounted, so its
       query keeps what it last read whatever `gcTime` says, and a reopen drew that — the
       list from before the restore that closed it — until the new answer landed.
    */
    queryClient.removeQueries({ queryKey: keys.revisions(noteId), exact: true });
  }, [open, noteId, queryClient]);

  const restore = async () => {
    if (!picked || restoring) return;
    setRestoring(true);
    setFailure(null);
    try {
      await onRestore(picked);
    } catch (err) {
      setFailure((err as Error).message.replace(/^\d{3}[^:]*: /, ''));
    } finally {
      setRestoring(false);
    }
  };

  const back = () => {
    setPicked(null);
    setFailure(null);
  };

  /*
     Focus follows the page. Choosing a row removes the row, and Back removes the page it
     was on, so focus fell to the dialog and a keyboard or a screen reader was left
     nowhere, on a page it had not been told had changed. Into a version, focus goes to
     Back — the first control of the new page, and its name says there is a way out; out
     of one, to the row that was opened, so the list is where it was left.
  */
  const page = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<number, HTMLButtonElement>());
  const cameFrom = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    if (picked) {
      cameFrom.current = picked.id;
      page.current?.closest('dialog')?.querySelector<HTMLElement>('.sheet-back')?.focus();
    } else if (cameFrom.current !== null) {
      rows.current.get(cameFrom.current)?.focus();
      cameFrom.current = null;
    }
  }, [picked, open]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={picked ? formatRevisionWhen(picked.createdAt) : 'History'}
      className="history-sheet"
      anchor={anchor}
      {...(picked ? { onBack: back } : {})}
    >
      {picked ? (
        <div className="history-page" ref={page}>
          <p className="history-what muted small">{describeRevision(picked)}</p>
          <div className="history-copy">
            {copy.isPending ? (
              <p className="muted small">Loading…</p>
            ) : copy.isError ? (
              <p className="bad small" role="alert">
                This version could not be loaded.
              </p>
            ) : (
              <>
                <h3 className="history-copy-title">{copy.data.title || 'Untitled'}</h3>
                {copy.data.body === '' ? (
                  <p className="muted small">This version had no text.</p>
                ) : (
                  <Preview markdown={copy.data.body} noteId={noteId} />
                )}
              </>
            )}
          </div>
          {failure && (
            <p className="bad small" role="alert">
              {failure}
            </p>
          )}
          <div className="history-foot">
            <p className="muted small">The note as it is now is kept in History, so this can be undone.</p>
            <Button
              variant="primary"
              disabled={restoring || !copy.isSuccess || offline}
              title={offlineTitle}
              onClick={() => void restore()}
            >
              {restoring ? 'Restoring…' : 'Restore this version'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="history-page">
          {list.isPending ? (
            <p className="muted small">Loading…</p>
          ) : list.isError ? (
            <div className="history-failed">
              <p className="bad small" role="alert">
                This note’s history could not be loaded.
              </p>
              <Button size="small" onClick={() => void list.refetch()}>
                Try again
              </Button>
            </div>
          ) : list.data.length === 0 ? (
            <p className="history-empty">No earlier versions yet.</p>
          ) : (
            <ul className="history-list">
              {list.data.map((revision) => (
                <li key={revision.id}>
                  <button
                    type="button"
                    className="history-row"
                    ref={(el) => {
                      if (el) rows.current.set(revision.id, el);
                      else rows.current.delete(revision.id);
                    }}
                    disabled={offline}
                    title={offlineTitle}
                    onClick={() => setPicked(revision)}
                  >
                    <span className="history-row-text">
                      <span className="history-when">{formatRevisionWhen(revision.createdAt)}</span>
                      <span className="history-what muted small">{describeRevision(revision)}</span>
                    </span>
                    <RowChevronIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* What the list is, under it in both states: it is the answer to "why is the
              version I want not here" as much as to "why is this empty". */}
          {list.isSuccess && (
            <p className="history-about muted small">
              A version is kept when this note’s text is changed: about one for each half hour of typing, and
              one before any edit by a connected assistant. The last 20 are kept, for 90 days.
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
