import { ListViewIcon, TableViewIcon } from './icons.js';
import type { NotesViewMode } from '../useNotesLayout.js';

interface NotesViewToggleProps {
  /** The view in effect — not necessarily the stored choice; see `tableDisabledReason`. */
  value: NotesViewMode;
  onChange: (next: NotesViewMode) => void;
  /**
   * Why the table cannot be chosen here, when it cannot: outside a single notebook there
   * are no fields to make columns of. Disabled rather than hidden, because a control that
   * only appears inside a notebook cannot be found from the place most people start.
   */
  tableDisabledReason?: string | undefined;
}

/**
 * List or table: how the notes under the header are drawn.
 *
 * Two pressed-state buttons rather than one that flips, so the current view is readable
 * without knowing what the other icon would have meant. It sits with the filter and sort
 * icons because it is, like them, about what is on screen rather than about adding to it.
 * The caller decides whether it renders at all: a phone never draws the table, and a
 * search result is ranked rather than columned.
 */
export function NotesViewToggle({ value, onChange, tableDisabledReason }: NotesViewToggleProps) {
  return (
    <div className="view-toggle" role="group" aria-label="View">
      <button
        type="button"
        className="icon-btn"
        aria-pressed={value === 'list'}
        aria-label="List view"
        onClick={() => onChange('list')}
      >
        <ListViewIcon />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-pressed={value === 'table'}
        // The reason goes in the name, not only in the tooltip: a disabled button with no
        // explanation reads as broken, and the tooltip is invisible to a screen reader.
        aria-label={tableDisabledReason ? `Table view, ${tableDisabledReason}` : 'Table view'}
        title={tableDisabledReason}
        disabled={tableDisabledReason !== undefined}
        onClick={() => onChange('table')}
      >
        <TableViewIcon />
      </button>
    </div>
  );
}
