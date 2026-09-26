import { DEFAULT_NOTE_SORT, type NoteSort } from '@unbent/shared';
import { isExportOf, startExport, useExporting } from '../export-archive.js';
import { Button } from './Button.js';
import { DownloadRowIcon } from './icons.js';
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
 * A `Button`, since it starts work in this tab: the archive is built here from pages of
 * notes (see `export-archive.ts`), and a browser that can asks where to save it first. It
 * was a `<button>` drawn as the quiet grey line the old download link had been, which
 * left it no hit area beyond its text and an underline promising a navigation. Quiet and
 * small, since it sits under the filters it serves rather than competing with them.
 *
 * One export runs at a time, so while one does this waits. Its label counts the export
 * only when the export is of this filter: another's count here read as this list's. How
 * the export ends, and a way to stop it, are the app-wide `ExportSnackbar`'s to say.
 */
export function ExportLink({ filter, sort, total }: ExportLinkProps) {
  const exporting = useExporting();
  const running = exporting.status === 'running';
  const scope = {
    tags: filter.tag,
    notebook: filter.notebook,
    fields: filter.field,
    from: filter.from,
    to: filter.to,
    sort: sort ?? DEFAULT_NOTE_SORT,
  };
  const mine = running && isExportOf(exporting, scope);
  return (
    <Button
      variant="quiet"
      size="small"
      className="export-filtered"
      disabled={running}
      onClick={() => startExport(scope)}
    >
      <DownloadRowIcon />
      {mine
        ? exporting.total === null
          ? 'Exporting…'
          : `Exporting ${exporting.done.toLocaleString()} of ${exporting.total.toLocaleString()}…`
        : running
          ? 'Another export is running'
          : total === 1
            ? 'Export this note'
            : total !== null
              ? `Export these ${total.toLocaleString()} notes`
              : 'Export these notes'}
    </Button>
  );
}
