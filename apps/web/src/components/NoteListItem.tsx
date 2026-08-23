import { Link } from '@tanstack/react-router';
import type { NoteSummary } from '@unbent/shared';
import { formatWhen } from './format-when.js';

interface NoteListItemProps {
  note: NoteSummary;
  /** Where clicking this entry goes. */
  to: '/notes/$noteId' | '/trash/$noteId';
  /** Rendered under the entry; the trash view puts Restore and Delete forever here. */
  actions?: React.ReactNode;
}

/**
 * One note in the sidebar.
 *
 * A `Link`, not a button with an onClick: middle-click and copy-link-address now do what
 * they look like they should, which is the point of having real routes at all. Selection
 * styling comes from `activeProps` rather than comparing ids by hand.
 *
 * Trashed notes show when they were deleted rather than when they were last edited —
 * in the bin, "how long until this is really gone" is the useful fact.
 */
export function NoteListItem({ note, to, actions }: NoteListItemProps) {
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
          {note.deletedAt ? `Deleted ${formatWhen(note.deletedAt)}` : formatWhen(note.updatedAt)}
        </span>
        {note.excerpt && <span className="note-excerpt">{note.excerpt}</span>}
        {note.tags.length > 0 && (
          <span className="note-tags">{note.tags.map((t) => `#${t}`).join(' ')}</span>
        )}
      </Link>
      {actions}
    </li>
  );
}
