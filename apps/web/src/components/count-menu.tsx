import type { OverflowItem } from './OverflowMenu.js';

interface CountMenuOptions {
  /** Every note the filter matches, which is what an export takes. */
  total: number;
  /** Nothing narrows the list, so an export of it would be the whole library. */
  everything: boolean;
  /** The rows drawn so far, which is all a selection can name. */
  shown: number;
  /** Whether a later page is still to come, so `shown` is short of `total`. */
  more: boolean;
  /** An export is already running; see `useExportRunning`. */
  exportRunning: boolean;
  /** No connection; see `useOffline`. An export reads every page from the server. */
  offline: boolean;
  onExport: () => void;
  onSelectAll: () => void;
}

/**
 * Whether the count is a menu at all: whenever it is a number of notes something could be
 * done to. Not over a search, whose query an export does not carry; not while the list is
 * loading, when the count reads "Loading…"; not for a notebook that is not there; and not
 * for an empty list. Filtered or not, what that changes is the export, not the menu.
 */
export function offersCountMenu(o: {
  searching: boolean;
  notebookMissing: boolean;
  loading: boolean;
  total: number;
}): boolean {
  return !o.searching && !o.notebookMissing && !o.loading && o.total > 0;
}

/**
 * What the list's count offers when it is a menu (see `NoteListHead`'s `countMenu`).
 *
 * **Export**, because the count is where the slice of the archive on screen is named. It
 * was the last row of the filter sheet, which is only on screen while the sheet is open:
 * close it and a filtered list had no visible way out, and a notebook or a lone tag (the
 * views with no chips) never opened the sheet to begin with.
 *
 * **Select all**, because the count is also the number a selection would be of. It names
 * what it will do: a selection holds the rows that are drawn, and while a later page has
 * not loaded those are fewer than the count beside it. "Select all" under "Export these
 * 340 notes" would read as all 340 and pick 50, so until the list is whole it says how
 * many it takes.
 *
 * **Unfiltered, Export is the way to Settings → Export** rather than the export itself.
 * There it would be the whole library (an archive of gigabytes) and that page says what
 * it leaves out and how big it gets, which a menu item has no room for. The count is still
 * a menu, though: a count that opened a menu only while something was filtered would
 * hide that it ever does, and Select all is as useful on All notes as anywhere. The "…"
 * says the item leads somewhere before anything happens; it is a real link (`to`), so it
 * fades for nothing: the page says for itself what it can do offline.
 *
 * Export needs the server, page by page, and one export runs at a time. Offline, or while
 * another runs, it stays where it is, faded, and says why in the item itself rather than in
 * a tooltip, which a phone never shows. Faded rather than dropped, so the menu keeps its
 * shape: the rule for every control that needs the server (see `OverflowItem.disabled`).
 * Select all does not fade: a selection is made of the rows on screen. How a running export
 * is going is `ExportSnackbar`'s to say, app-wide.
 */
export function countMenuItems({
  total,
  everything,
  shown,
  more,
  exportRunning,
  offline,
  onExport,
  onSelectAll,
}: CountMenuOptions): OverflowItem[] {
  const exportLabel = total === 1 ? 'Export this note' : `Export these ${total.toLocaleString()} notes`;
  // Offline first: it is the one the person can do something about, and a running export
  // with no connection is not going to finish until there is one.
  const unavailable = offline
    ? 'Exporting needs a connection'
    : exportRunning
      ? 'After the current export finishes'
      : undefined;
  const exportItem: OverflowItem = everything
    ? { label: 'Export everything…', to: '/settings/export' }
    : {
        label: unavailable ? (
          <>
            {exportLabel}
            <span className="overflow-item-note">{unavailable}</span>
          </>
        ) : (
          exportLabel
        ),
        onSelect: onExport,
        disabled: unavailable !== undefined,
        title: unavailable,
      };
  return [
    exportItem,
    {
      label: more ? `Select the ${shown.toLocaleString()} shown` : 'Select all',
      onSelect: onSelectAll,
    },
  ];
}
