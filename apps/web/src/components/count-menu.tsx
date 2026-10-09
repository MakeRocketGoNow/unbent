import type { OverflowItem } from './OverflowMenu.js';

interface CountMenuOptions {
  /** Every note the filter matches, which is what an export takes. */
  total: number;
  /** The rows drawn so far, which is all a selection can name. */
  shown: number;
  /** Whether a later page is still to come, so `shown` is short of `total`. */
  more: boolean;
  /** An export is already running; see `useExportRunning`. */
  exportRunning: boolean;
  onExport: () => void;
  onSelectAll: () => void;
}

/**
 * What the list's count offers when it is a menu — see `NoteListHead`'s `countMenu`.
 *
 * **Export**, because the count is where the slice of the archive on screen is named. It
 * was the last row of the filter sheet, which is only on screen while the sheet is open:
 * close it and a filtered list had no visible way out, and a notebook or a lone tag — the
 * views with no chips — never opened the sheet to begin with.
 *
 * **Select all**, because the count is also the number a selection would be of. It names
 * what it will do: a selection holds the rows that are drawn, and while a later page has
 * not loaded those are fewer than the count beside it. "Select all" under "Export these
 * 340 notes" would read as all 340 and pick 50, so until the list is whole it says how
 * many it takes.
 *
 * One export runs at a time. While one does, Export stays where it is, faded, and says why
 * in the item itself rather than in a tooltip, which a phone never shows. How the running
 * export is going is `ExportSnackbar`'s to say, app-wide.
 */
export function countMenuItems({
  total,
  shown,
  more,
  exportRunning,
  onExport,
  onSelectAll,
}: CountMenuOptions): OverflowItem[] {
  const exportLabel = total === 1 ? 'Export this note' : `Export these ${total.toLocaleString()} notes`;
  const waiting = 'After the current export finishes';
  return [
    {
      label: exportRunning ? (
        <>
          {exportLabel}
          <span className="overflow-item-note">{waiting}</span>
        </>
      ) : (
        exportLabel
      ),
      onSelect: onExport,
      disabled: exportRunning,
      title: exportRunning ? waiting : undefined,
    },
    {
      label: more ? `Select the ${shown.toLocaleString()} shown` : 'Select all',
      onSelect: onSelectAll,
    },
  ];
}
