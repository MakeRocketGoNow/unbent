import type { NoteSort } from '@unbent/shared';
import * as api from '../notes-api.js';
import type { NoteFilter } from '../queries.js';

interface ExportLinkProps {
  /** The active filter, built by the caller — the same object it queries with. */
  filter: NoteFilter;
  sort: NoteSort | undefined;
  /** Total matching notes, for the label. Null while it is still unknown. */
  total: number | null;
}

/**
 * Export the current filter.
 *
 * Here rather than only in Settings because this is where the scope was chosen: having
 * filtered to a tag and a year, being sent to another page to describe the same slice again
 * is the failure mode. Callers show it only when a filter is active — with none, this is the
 * whole-library export, which has its own page and a warning about size that belongs with it.
 *
 * An anchor, like the export page's: the archive is generated as it downloads, so letting
 * the browser consume the response is what keeps a corpus larger than the Worker's memory
 * from ever landing in a JS buffer. `Button` deliberately does not render anchors, which is
 * why this keeps its own class rather than wearing button shape.
 */
export function ExportLink({ filter, sort, total }: ExportLinkProps) {
  return (
    <a
      className="export-filtered small"
      href={api.exportUrl({ ...filter, sort: sort ?? 'updated' })}
      download
    >
      {total !== null ? `Export these ${total} notes` : 'Export these notes'}
    </a>
  );
}
