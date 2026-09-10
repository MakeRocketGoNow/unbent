import { Link } from '@tanstack/react-router';
import type { NoteSort, NoteSummary } from '@unbent/shared';
import { formatWhen } from './format-when.js';
import { formatFieldValue } from './format-field.js';

interface NoteListItemProps {
  note: NoteSummary;
  /** Where clicking this entry goes. */
  to: '/notes/$noteId' | '/trash/$noteId';
  /** Rendered under the entry; the trash view puts Restore and Delete forever here. */
  actions?: React.ReactNode;
  /** The sort the list is using, so the entry shows the date that ordering is based on. */
  sort?: NoteSort;
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
export function NoteListItem({ note, to, actions, sort }: NoteListItemProps) {
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
      >
        <span className="note-title">{note.title || 'Untitled'}</span>
        <span className="note-meta">
          {note.deletedAt ? `Deleted ${formatWhen(note.deletedAt)}` : formatWhen(when)}
        </span>
        {note.excerpt && <span className="note-excerpt">{note.excerpt}</span>}
        {/* The values, named, on one line like the tags under them: what the note *is*
            when its notebook is a collection of records rather than of prose. */}
        {note.fields && note.fields.length > 0 && (
          <span className="note-fields-line">
            {note.fields.map((f) => `${f.name}: ${formatFieldValue(f.type, f.value)}`).join(' · ')}
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
