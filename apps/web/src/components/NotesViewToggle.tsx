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
 * One button that flips between the two. It was a pair of pressed-state buttons, which
 * read well but spent two slots of a 19rem sidebar's header on one bit of state — and
 * outside a notebook one of the two was a disabled icon offering nothing. Evernote and
 * Apple Notes both make this a single control, and the row it sits in needs the slot.
 *
 * The icon is the view on screen, the way a sort icon shows the current order rather than
 * the next one; what a press will do is in the name, which is also why there is no
 * `aria-pressed` — a name that changes and a pressed state that changes are two answers
 * to one question. It sits with the filter and sort icons because it is, like them, about
 * what is on screen rather than about adding to it. The caller decides whether it renders
 * at all: a phone never draws the table.
 */
export function NotesViewToggle({ value, onChange, tableDisabledReason }: NotesViewToggleProps) {
  const next: NotesViewMode = value === 'table' ? 'list' : 'table';
  const label =
    tableDisabledReason !== undefined
      ? // The reason goes in the name, not only in the tooltip: a disabled button with no
        // explanation reads as broken, and the tooltip is invisible to a screen reader.
        `Table view, ${tableDisabledReason}`
      : value === 'table'
        ? 'Showing as a table, switch to list'
        : 'Showing as a list, switch to table';
  return (
    <button
      type="button"
      className="icon-btn view-toggle"
      aria-label={label}
      // The reason reads as the end of a sentence, so the tip keeps the name in front of it.
      data-tip={tableDisabledReason !== undefined ? label : next === 'table' ? 'Table view' : 'List view'}
      disabled={tableDisabledReason !== undefined}
      onClick={() => onChange(next)}
    >
      {value === 'table' ? <TableViewIcon /> : <ListViewIcon />}
    </button>
  );
}
