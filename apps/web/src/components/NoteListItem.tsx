import { Link } from '@tanstack/react-router';
import type { NoteSort, NoteSummary } from '@unbent/shared';
import { formatWhen } from './format-when.js';
import { formatFieldValue } from './format-field.js';
import { AttachmentKindIcon } from './icons.js';

interface NoteListItemProps {
  note: NoteSummary;
  /** Where clicking this entry goes. */
  to: '/notes/$noteId' | '/trash/$noteId';
  /** Rendered under the entry; the trash view puts Restore and Delete forever here. */
  actions?: React.ReactNode;
  /** The sort the list is using, so the entry shows the date that ordering is based on. */
  sort?: NoteSort;
  /**
   * Opens the note through a view transition that grows this entry into the note.
   *
   * Set on a phone only. There the list is replaced by the note, so the tapped entry
   * has somewhere to go; on a desktop the two sit side by side and a transition would
   * animate a change nobody can see.
   */
  transition?: boolean;
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
 * order as wrong, and for an imported archive the two are often years apart — an Evernote
 * export carries a real `created` from the day a document was filed and an `updated` from
 * whenever it was last touched.
 *
 * Trashed notes show when they were deleted rather than either — in the bin, "how long
 * until this is really gone" is the useful fact.
 */
export function NoteListItem({ note, to, actions, sort, transition = false }: NoteListItemProps) {
  const when = sort === 'created' ? note.createdAt : note.updatedAt;
  return (
    <li>
      <Link
        to={to}
        params={{ noteId: note.id }}
        // Filters are carried across selection so opening a note does not silently
        // drop the notebook or tag the list was scoped to.
        search={(prev) => prev}
        className="note-item"
        activeProps={{ className: 'note-item active' }}
        // On a side-by-side list a click is browsing, not editing: the row keeps focus and
        // the editor stands down so the arrow keys keep working, the same as arrowing to it.
        // Marked only where the list survives the open — a phone replaces it with the note,
        // so there focus has nowhere to stay and the note opens ready to write in. Read by
        // the pointerdown handler in `useListKeys`.
        {...(transition ? {} : { 'data-keep-focus': '' })}
        viewTransition={transition ? { types: ['note-open'] } : undefined}
        /*
         * Which entry is opening, for the transition to grow from.
         *
         * The browser snapshots the page before the navigation, and at that moment
         * nothing in the route says which entry was tapped — the id only reaches the URL
         * afterwards. So the entry marks itself here, synchronously in the click, and
         * the stylesheet gives the marked entry the note's `view-transition-name`. The
         * mark stays while the note is open, which is what lets Back run the same
         * transition in reverse, shrinking the note into the row it came from; any
         * sibling still carrying it from an earlier open is cleared first, because two
         * elements with one name make the browser skip the transition altogether.
         */
        onClick={
          transition
            ? (e) => {
                const el = e.currentTarget;
                el.closest('.note-list')
                  ?.querySelectorAll('[data-opening]')
                  .forEach((n) => n.removeAttribute('data-opening'));
                el.setAttribute('data-opening', '');
              }
            : undefined
        }
      >
        <span className="note-title">{note.title || 'Untitled'}</span>
        <span className="note-meta">
          {note.deletedAt ? `Deleted ${formatWhen(note.deletedAt)}` : formatWhen(when)}
        </span>
        {note.excerpt && <span className="note-excerpt">{note.excerpt}</span>}
        {/*
          The files the note holds: a glyph for the kind, the first one's name, and how
          many more there are.

          Under the excerpt rather than folded into it, because the two answer different
          questions — what the note says, and what it carries — and for most of an imported
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
        {note.tags.length > 0 && (
          <span className="note-tags">{note.tags.map((t) => `#${t}`).join(' ')}</span>
        )}
      </Link>
      {actions}
    </li>
  );
}
