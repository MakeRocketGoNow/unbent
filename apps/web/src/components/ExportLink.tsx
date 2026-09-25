import type { NoteSort } from '@unbent/shared';
import { startExport, useExporting } from '../export-archive.js';
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
 * A button, since it starts work in this tab: the archive is built here from pages of
 * notes (see `export-archive.ts`), and a browser that can asks where to save it first.
 * One export runs at a time, so while one does the label reports it instead.
 */
export function ExportLink({ filter, sort, total }: ExportLinkProps) {
  const exporting = useExporting();
  const running = exporting.status === 'running';
  return (
    <button
      type="button"
      className="export-filtered small"
      disabled={running}
      onClick={() =>
        startExport({
          tags: filter.tag,
          notebook: filter.notebook,
          fields: filter.field,
          from: filter.from,
          to: filter.to,
          sort: sort ?? 'updated',
        })
      }
    >
      {running
        ? exporting.total === null
          ? 'Exporting…'
          : `Exporting ${exporting.done} of ${exporting.total}…`
        : total !== null
          ? `Export these ${total} notes`
          : 'Export these notes'}
    </button>
  );
}
