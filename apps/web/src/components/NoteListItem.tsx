import { useRef } from 'react';
import { Link } from '@tanstack/react-router';
import type { NoteSort, NoteSummary } from '@unbent/shared';
import { formatWhen } from './format-when.js';
import { formatFieldValue } from './format-field.js';
import { AttachmentKindIcon } from './icons.js';
import type { TagColorOf } from './use-tag-colors.js';

/**
 * How long a finger rests on a row before it selects rather than opens.
 *
 * Android's own long-press timeout, and about what iOS uses: a touch that has lasted
 * this long is not a tap that is running late, it is the other gesture.
 */
const LONG_PRESS_MS = 500;

/** How far a resting finger may drift before it is a scroll and not a press. */
const PRESS_SLOP_PX = 10;

/**
 * How a row takes part in the list's selection. Absent where a row is only a way in:
 * search results, and any list that offers no bulk actions.
 */
export interface RowSelection {
  selected: boolean;
  /** Whether any row is selected: the list is in its selection mode. */
  active: boolean;
  /** Picks this row; `range` selects from the anchor to it instead of toggling it alone. */
  onPick: (opts: { range: boolean }) => void;
}

interface NoteListItemProps {
  note: NoteSummary;
  /** Where clicking this entry goes. */
  to: '/notes/$noteId' | '/trash/$noteId';
  /** Rendered under the entry; the trash view puts Restore and Delete forever here. */
  actions?: React.ReactNode;
  /** The sort the list is using, so the entry shows the date that ordering is based on. */
  sort?: NoteSort;
  /**
   * The note replaces the list when it opens, as it does on a phone; on a desktop the two
   * sit side by side. Decides where focus goes on a click (see `data-keep-focus` below).
   */
  replacedByNote?: boolean;
  selection?: RowSelection | undefined;
  /** Each tag's colour, so the row's tags agree with the chips in the note's head. */
  tagColor?: TagColorOf | undefined;
}

/**
 * One note in the sidebar.
 *
 * A `Link`, not a button with an onClick: middle-click and copy-link-address now do what
 * they look like they should, which is the point of having real routes at all. Selection
 * styling comes from `activeProps` rather than comparing ids by hand.
 *
 * The date follows the list's order: sorted by creation, the entry shows when the note was
 * created. Showing "last edited" under a list ordered by creation date invites reading the
 * order as wrong, and for an imported archive the two are often years apart: an Evernote
 * export carries a real `created` from the day a document was filed and an `updated` from
 * whenever it was last touched.
 *
 * Trashed notes show when they were deleted rather than either: in the bin, "how long
 * until this is really gone" is the useful fact.
 *
 * **Selecting several.** Cmd- or Ctrl-click toggles a row into the selection and
 * Shift-click selects a run of them: Finder's keys, and Evernote's, which is where the
 * people using this arrive from. On a touch screen, where there are no modifiers, a
 * finger resting on a row for half a second selects it, and while anything is selected a
 * plain tap toggles a row rather than opening it; a pointer's plain click still opens,
 * as it does on a desktop everywhere else. Space on a focused row toggles it, so the
 * keyboard has a way in too. While the list is in its selection mode every row shows a
 * checkbox, which is the state and, for a pointer, a way to add rows without a modifier.
 *
 * The modifier clicks are taken from the link on purpose: Cmd-click on a link opens it in
 * a new tab, and that is lost here. Middle-click still does, and copy-link-address still
 * works; a list of notes is selected with those keys in every app this one is compared to,
 * and a new tab per Cmd-click is not what anyone pressing it in a note list means.
 *
 * The checkbox is outside the link rather than in it (a control inside an anchor is
 * invalid and every click on it would also follow the link) and drawn over the row's
 * corner, where the title has been asked to leave it room (see `.note-list.selecting`).
 */
export function NoteListItem({
  note,
  to,
  actions,
  sort,
  replacedByNote = false,
  selection,
  tagColor,
}: NoteListItemProps) {
  const when = sort === 'created' ? note.createdAt : note.updatedAt;
  const title = note.title || 'Untitled';

  /*
     The long press. A timer started on touch-down and cancelled by anything that makes
     the touch something else: lifting, drifting more than the slop, the browser taking
     the pointer for a scroll. When it fires, the row is picked and the click that follows
     the finger lifting is swallowed, since it would open the note that was just selected.
     The context menu a browser offers for a held link is swallowed for the same press:
     the press has already meant something.
  */
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const pointerType = useRef('mouse');
  const cancelPress = () => {
    if (!press.current) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  };

  return (
    <li
      // What the list's motion follows a row by (`list-motion.ts`).
      data-note-id={note.id}
      className={['note-entry', selection?.selected && 'selected', actions && 'with-actions']
        .filter(Boolean)
        .join(' ')}
    >
      <Link
        to={to}
        params={{ noteId: note.id }}
        // Filters are carried across selection so opening a note does not silently
        // drop the notebook or tag the list was scoped to.
        search={(prev) => prev}
        className={selection?.selected ? 'note-item selected' : 'note-item'}
        activeProps={{ className: selection?.selected ? 'note-item selected active' : 'note-item active' }}
        aria-selected={selection ? selection.selected : undefined}
        // On a side-by-side list a click is browsing, not editing: the row keeps focus and
        // the editor stands down so the arrow keys keep working, the same as arrowing to it.
        // Marked only where the list survives the open: a phone replaces it with the note,
        // so there focus has nowhere to stay and the note opens ready to write in. Read by
        // the pointerdown handler in `useListKeys`.
        {...(replacedByNote ? {} : { 'data-keep-focus': '' })}
        onPointerDown={(e) => {
          pointerType.current = e.pointerType;
          swallowClick.current = false;
          if (!selection || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return;
          cancelPress();
          const timer = window.setTimeout(() => {
            press.current = null;
            swallowClick.current = true;
            // A nudge, where the platform has one, so the finger knows the press landed.
            navigator.vibrate?.(15);
            selection.onPick({ range: false });
          }, LONG_PRESS_MS);
          press.current = { timer, x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP_PX) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
        onContextMenu={(e) => {
          if (selection && (press.current || swallowClick.current)) e.preventDefault();
        }}
        onKeyDown={(e) => {
          // Space on a link scrolls the page, which nobody focused a note row to do.
          if (selection && e.key === ' ') {
            e.preventDefault();
            selection.onPick({ range: e.shiftKey });
          }
        }}
        onClick={(e) => {
          if (selection) {
            if (swallowClick.current) {
              swallowClick.current = false;
              e.preventDefault();
              return;
            }
            const touch = pointerType.current === 'touch' || pointerType.current === 'pen';
            if (e.metaKey || e.ctrlKey || e.shiftKey || (touch && selection.active)) {
              e.preventDefault();
              selection.onPick({ range: e.shiftKey });
              return;
            }
          }
        }}
      >
        <span className="note-title">{title}</span>
        <span className="note-meta">
          {note.deletedAt ? `Deleted ${formatWhen(note.deletedAt)}` : formatWhen(when)}
        </span>
        {note.excerpt && <span className="note-excerpt">{note.excerpt}</span>}
        {/*
          The files the note holds: a glyph for the kind, the first one's name, and how
          many more there are.

          Under the excerpt rather than folded into it, because the two answer different
          questions (what the note says, and what it carries) and for most of an imported
          archive only one of them has an answer: a scanned document has files and no
          prose, a journal entry the reverse. Each row then shows the line it has, and a
          note with both shows both.

          One name and a count, not every name. The sidebar is narrow, a filename is
          unbounded, and the first file is the one the note was made for; the rest are
          listed in the title for a hover on a desktop, and in the note itself.
        */}
        {note.attachments && note.attachments.length > 0 && (
          <span className="note-files" title={note.attachments.map((a) => a.filename).join('\n')}>
            <AttachmentKindIcon contentType={note.attachments[0]!.contentType} />
            <span className="note-files-name">{note.attachments[0]!.filename}</span>
            {note.attachments.length > 1 && (
              <span className="note-files-more">+{note.attachments.length - 1}</span>
            )}
          </span>
        )}
        {/* The values, named, on one line like the tags under them: what the note *is*
            when its notebook is a collection of records rather than of prose. */}
        {note.fields && note.fields.length > 0 && (
          <span className="note-fields-line">
            {note.fields.map((f) => `${f.name}: ${formatFieldValue(f.type, f.value, f.scale, f.currency)}`).join(' · ')}
          </span>
        )}
        {/* As text with the hash, which is how a tag reads in a line of them, each in
            its own stored colour so the row agrees with the chips in the note's head. */}
        {note.tags.length > 0 && (
          <span className="note-tags">
            {note.tags.map((t) => (
              <span key={t} className="note-tag" data-color={tagColor?.(t) ?? undefined}>
                #{t}
              </span>
            ))}
          </span>
        )}
      </Link>
      {selection?.active && (
        <input
          type="checkbox"
          className="note-check"
          checked={selection.selected}
          aria-label={`Select ${title}`}
          // The pick is made on the click, which is what carries Shift; the change handler
          // is here because a controlled checkbox without one is a React warning.
          onChange={() => undefined}
          onClick={(e) => selection.onPick({ range: e.shiftKey })}
        />
      )}
      {actions}
    </li>
  );
}
