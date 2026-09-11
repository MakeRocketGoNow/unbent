import { useNavigate } from '@tanstack/react-router';
import type { NoteSort } from '@unbent/shared';
import { SORT_OPTIONS, sortKey, parseSortKey } from './sort-options.js';

interface SortSelectProps {
  sort: NoteSort | undefined;
  order: 'asc' | 'desc' | undefined;
}

/**
 * How the list is ordered, as one control.
 *
 * One control rather than a field plus a direction, because the useful combinations are few
 * and naming them ("Oldest first") is plainer than asking someone to assemble "created" and
 * "ascending" themselves.
 *
 * The desktop spelling of the phone's sort sheet, which hangs off `NotesSort`. Both
 * read `SORT_OPTIONS`, so the two cannot come to offer different orders.
 *
 * Callers hide this while searching: results come back ranked by relevance, and reordering
 * them by date would throw away the ranking that makes them worth showing.
 */
export function SortSelect({ sort, order }: SortSelectProps) {
  const navigate = useNavigate();
  return (
    <div className="notebook-scope-wrap">
      <select
        className="notebook-scope"
        value={sortKey(sort, order)}
        onChange={(e) =>
          void navigate({
            to: '/notes',
            // The default stays out of the URL so a plain /notes link is clean.
            search: (prev) => ({ ...prev, ...parseSortKey(e.target.value) }),
          })
        }
        aria-label="Sort notes"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
