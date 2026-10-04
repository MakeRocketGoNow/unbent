import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  REVISION_MAX_AGE_MS,
  REVISION_WINDOW_MS,
  REVISIONS_KEPT,
  type NoteRevisionProps,
  type NoteRevisionSummary,
  type RevisionSkip,
} from '@unbent/shared';
import { andList } from '../and-list.js';
import { useOffline } from '../connectivity.js';
import * as api from '../notes-api.js';
import { keys, revisionQuery, revisionsQuery } from '../queries.js';
import * as actions from '../store/actions.js';
import { usePersistentState } from '../usePersistentState.js';
import { Button } from './Button.js';
import { Confirm } from './Confirm.js';
import { formatRevisionWhen } from './format-when.js';
import { HistoryChanges, PropLine, shown, type HistoryCurrent } from './HistoryChanges.js';
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
  /**
   * The note as it is on screen — the workspace's draft, which `saved` has handed to the
   * save — for Changes to compare a version against. Not the stored row: what Restore
   * replaces is what the person is looking at, and a row a save behind would show typing
   * they can see as something Restore takes out, or miss it. Its notebook, tags and
   * field values with it, since a version holds those too (MAK-170).
   */
  current: HistoryCurrent;
}

/** The two ways of looking at a version; see `HistoryChanges` for the second. */
type HistoryView = 'preview' | 'changes';

const VIEWS: { value: HistoryView; label: string; title: string }[] = [
  { value: 'preview', label: 'Preview', title: 'This version as it would read' },
  { value: 'changes', label: 'Changes', title: 'What restoring this version would change' },
];

/**
 * What a copy is, in a few words under its time: what replaced it, when that was not
 * the person's own edit; which parts of the note changed, when it was more than the
 * text; and how much text it holds. The size is the useful half for a note of prose.
 * The copy someone opens this sheet for is nearly always "the long one, before it was
 * gutted", and a count says which that is without opening each in turn.
 *
 * The parts are for the notes that are mostly fields (MAK-170). A version kept because
 * Status changed holds the same text as the one before it, so without them every such
 * row read alike. Said only when something besides the text changed: "Text changed" on
 * every row of an ordinary note would be a label on the common case, and the copies
 * from before this was recorded, which cannot say it, were all kept for their text.
 *
 * "No text", not "Empty", for a body of nothing: a card that is all fields is not empty.
 */
export function describeRevision(revision: Pick<NoteRevisionSummary, 'cause' | 'size' | 'changed'>): string {
  const size =
    revision.size === 0
      ? 'No text'
      : `${revision.size.toLocaleString()} ${revision.size === 1 ? 'character' : 'characters'}`;
  const before =
    revision.cause === 'assistant'
      ? 'Before an assistant’s edit'
      : revision.cause === 'restore'
        ? 'Before a restore'
        : null;
  const parts = revision.changed ?? [];
  const named = andList(parts);
  const what = parts.some((p) => p !== 'text') ? `${named.charAt(0).toUpperCase()}${named.slice(1)} changed` : null;
  return [before, what, size].filter((part) => part !== null).join(' · ');
}

/**
 * How history is kept, as a sentence, from the numbers the store enforces — so the
 * sheet cannot explain a version's absence with a rule the server no longer follows.
 * "Half hour" and "a year" are said the way a person would; any other value is counted.
 *
 * "When this note is changed", and "of edits": its fields, tags and notebook count as
 * its text does. It said "when this note's text is changed" while they did not, which
 * was true and easy to read past in a notebook where the fields are the note.
 *
 * "Before a connected assistant changes it", not "before any change by" one: a run of an
 * assistant's edits leaves one version, the note before the run, and a sentence promising
 * one per edit would send someone looking for versions that were never kept.
 */
export function retentionSentence(): string {
  const minutes = Math.round(REVISION_WINDOW_MS / 60_000);
  const each = minutes === 30 ? 'half hour' : minutes === 60 ? 'hour' : `${minutes} minutes`;
  const days = Math.round(REVISION_MAX_AGE_MS / 86_400_000);
  const age = days === 365 ? 'a year' : `${days} days`;
  return `A version is kept when this note is changed, its fields, tags and notebook included: about one for each ${each} of edits, and one before a connected assistant changes it. The last ${REVISIONS_KEPT} are kept, for ${age}.`;
}

/**
 * What a restore could not put back, as the middle of a sentence: "Status", "Status and
 * the tag “drama”", "its notebook, Status and 2 more". Empty when everything went back.
 *
 * Names, and no reasons: the snackbar is one line with an Undo on it, and the Changes
 * view has already given each reason beside the thing itself. Two names and a count,
 * because a deleted notebook takes every one of its fields with it and a line listing
 * nine of them is a line nobody reads.
 */
export function skippedPhrase(skipped: readonly RevisionSkip[]): string {
  const names = skipped.map((s) => (s.what === 'notebook' ? 'its notebook' : s.what === 'tag' ? `the tag “${s.name}”` : s.name));
  return andList(names.length <= 3 ? names : [...names.slice(0, 2), `${names.length - 2} more`]);
}

/**
 * What a version holds besides its text, in Preview: where the note was filed, its tags
 * and its field values, as a plain list between the title and the body — the note's own
 * head, as it stood. Nothing at all for a note that was unfiled, untagged and without
 * values, where three lines saying "none" would be noise above the text someone came
 * to read; and nothing for a version from before these were kept, which Changes
 * explains where the question of what Restore does is being asked.
 */
function VersionProps({ props }: { props: NoteRevisionProps }) {
  if (props.notebook === null && props.tags.length === 0 && props.fields.length === 0) return null;
  return (
    <dl className="history-props">
      {/* No notebook is "Inbox" everywhere a person reads it; see `FilingRows`. */}
      <PropLine label="Notebook">{props.notebook?.name ?? 'Inbox'}</PropLine>
      {props.tags.length > 0 && <PropLine label="Tags">{props.tags.map((t) => t.name).join(', ')}</PropLine>}
      {props.fields.map((value) => (
        <PropLine key={value.fieldId} label={value.name}>
          {shown(value)}
        </PropLine>
      ))}
    </dl>
  );
}

/**
 * A note's history: the copies kept of what a write replaced, and a way to put one back
 * (MAK-119).
 *
 * A sheet, from the note's ⋯ menu. It is about the whole note rather than a place in it,
 * it holds a list that can run to fifty rows and then a page of text, and it is looked
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
 * Clear history is the other half of keeping what a write replaced: what was removed
 * from a note on purpose is kept too, and someone who pasted a password in and took it
 * out again needs it gone from here as well. It is the one thing in this sheet that
 * cannot be taken back, so it goes through `Confirm`, in place of the button that
 * asked, naming how many versions go and that the note does not. Quiet and at the foot
 * of the list: it is not what the sheet is for, and it must not be what a hurried tap
 * on a version lands on.
 *
 * The copy is drawn by `Preview`, as the note itself would read, rather than as its
 * Markdown source: the question on this page is "is this the version I want", and that
 * is recognised by reading it. Its notebook, tags and field values are listed above the
 * text, as the note's head has them (MAK-170). Its files resolve against the note as it
 * is now, since history keeps text and fields and not files; one deleted since draws as
 * a missing file would.
 *
 * Changes, beside Preview, is the next question — what will Restore do to my note — and
 * is drawn by `HistoryChanges` against `current`, the note on screen (MAK-167). Restore
 * is the same button under either.
 */
export function HistorySheet({ open, onClose, noteId, anchor, saved, onRestore, current }: HistorySheetProps) {
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
  const [clearing, setClearing] = useState<'asking' | 'busy' | null>(null);
  /*
     Preview or Changes, remembered as the note's own view is (`noteView` in the
     workspace): someone who compares versions compares every time. Preview by default,
     because the first question on this page is still "is this the version I want", and
     that is answered by reading it.
  */
  const [view, setView] = usePersistentState<HistoryView>('historyView', 'preview', (raw) =>
    raw === 'preview' || raw === 'changes' ? raw : undefined,
  );
  const viewButtons = useRef(new Map<HistoryView, HTMLButtonElement>());

  /*
     The list is asked for only once this note's own writes have reached the server.

     The sheet is opened most urgently straight after the mistake: paste over a note,
     see it, open History. The save carrying that paste is the write that makes the
     server keep the text from before it, and it is still in the autosave's delay or the
     outbox when the sheet opens. Asked at once, the server answered without it, and the
     sheet said "No earlier versions yet" about a note whose earlier version arrived a
     moment later. A queue that will not drain is not waited out for ever (`synced`
     gives up); the list is then whatever the server has.

     Once per opening, not once per ask. The query is retried on a failure, and every
     retry waiting out a stuck queue again kept the sheet on "Loading…" for the better
     part of half a minute before it said anything had gone wrong.
  */
  const waited = useRef<Promise<unknown> | null>(null);
  const list = useQuery({
    ...revisionsQuery(noteId),
    queryFn: async () => {
      waited.current ??= (async () => {
        await saved?.();
        await actions.synced(noteId);
      })();
      await waited.current;
      return api.listRevisions(noteId);
    },
    enabled: open,
  });
  const copy = useQuery({ ...revisionQuery(noteId, picked?.id ?? 0), enabled: open && picked !== null });

  // Opens on the list each time, and never on a copy of the note that was open before.
  useEffect(() => {
    if (open) return;
    waited.current = null;
    setPicked(null);
    setFailure(null);
    setRestoring(false);
    setClearing(null);
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
      setFailure(api.errorText(err));
    } finally {
      setRestoring(false);
    }
  };

  const clear = async () => {
    setClearing('busy');
    setFailure(null);
    try {
      await actions.clearHistory(noteId);
      // The list, and every version read from it: none of them exist any more.
      queryClient.removeQueries({ queryKey: keys.revisions(noteId) });
      setClearing(null);
    } catch (err) {
      setFailure(api.errorText(err));
      setClearing('asking');
    }
  };

  const back = () => {
    setPicked(null);
    setFailure(null);
  };

  /*
     A radio group moves its choice with the arrow keys, and is one stop for Tab: the
     chosen segment is the only one in the tab order. The editor's switch has neither,
     because its buttons act on mouse-down to keep the editor's focus; nothing here has a
     focus to keep, so these are ordinary clicks and the keyboard gets the full pattern.
  */
  const onViewKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const at = VIEWS.findIndex((v) => v.value === view);
    const next = VIEWS[(at + step + VIEWS.length) % VIEWS.length]!.value;
    setView(next);
    viewButtons.current.get(next)?.focus();
  };

  /*
     Focus follows the page. Back removes the page it was on, so focus fell to the dialog
     and a keyboard or a screen reader was left nowhere, on a list it had not been told
     was back. Out of a version, focus goes to the row that was opened, so the list is
     where it was left. Into one, `Sheet` moves it to Back, as it does for every paged
     sheet; only this knows which row to come back to.
  */
  const rows = useRef(new Map<number, HTMLButtonElement>());
  const cameFrom = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    if (picked) {
      cameFrom.current = picked.id;
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
        <div className="history-page">
          <div className="history-head">
            <p className="history-what muted small">{describeRevision(picked)}</p>
            {/* The editor's view switch, in look and in role; see `onViewKey`. Faded until
                there is a version to look at, not left out, so the box under it does not
                move when the version lands. */}
            <div className="tb-segmented" role="radiogroup" aria-label="Show" onKeyDown={onViewKey}>
              {VIEWS.map(({ value, label, title }) => (
                <button
                  key={value}
                  type="button"
                  className="tb-seg"
                  role="radio"
                  aria-checked={view === value}
                  tabIndex={view === value ? 0 : -1}
                  title={title}
                  disabled={!copy.isSuccess}
                  ref={(el) => {
                    if (el) viewButtons.current.set(value, el);
                    else viewButtons.current.delete(value);
                  }}
                  onClick={() => setView(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {/* Keyed by the view, so switching starts the other at its top rather than at
              however far down the first had been scrolled, which is a different place in
              a differently laid-out text. */}
          <div className="history-copy" key={view}>
            {copy.isPending ? (
              <p className="muted small">Loading…</p>
            ) : copy.isError ? (
              <p className="bad small" role="alert">
                This version could not be loaded.
              </p>
            ) : view === 'changes' ? (
              <HistoryChanges current={current} version={copy.data} />
            ) : (
              <>
                <h3 className="history-copy-title">{copy.data.title || 'Untitled'}</h3>
                {copy.data.props && <VersionProps props={copy.data.props} />}
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
          {list.isSuccess && <p className="history-about muted small">{retentionSentence()}</p>}
          {failure && (
            <p className="bad small" role="alert">
              {failure}
            </p>
          )}
          {list.isSuccess &&
            list.data.length > 0 &&
            (clearing === null ? (
              <div className="history-clear">
                <Button
                  variant="quiet"
                  tone="danger"
                  size="small"
                  disabled={offline}
                  title={offlineTitle}
                  onClick={() => {
                    setFailure(null);
                    setClearing('asking');
                  }}
                >
                  Clear history
                </Button>
              </div>
            ) : (
              <Confirm
                label="Confirm clear history"
                question="Clear this note’s history?"
                detail={
                  list.data.length === 1
                    ? 'Its 1 earlier version is deleted for good, along with any text it holds that is no longer in the note. The note itself is not changed.'
                    : `All ${list.data.length} earlier versions are deleted for good, along with any text they hold that is no longer in the note. The note itself is not changed.`
                }
                actions={[{ label: 'Clear history', busyLabel: 'Clearing…', tone: 'danger', onConfirm: clear }]}
                busy={clearing === 'busy'}
                onCancel={() => setClearing(null)}
                // The button that asked is gone, and focus with it. The question takes
                // it, on the choice that destroys nothing.
                focusCancel
              />
            ))}
        </div>
      )}
    </Sheet>
  );
}
