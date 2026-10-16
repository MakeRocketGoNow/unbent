import type { ReactNode } from 'react';
import { Button } from './Button';
import { CancelIcon } from './icons.js';

interface SelectionBarProps {
  /** How many rows are selected. The bar is only drawn while this is at least one. */
  count: number;
  /** How many rows the list has loaded, which is what Select all can reach. */
  total: number;
  onClear: () => void;
  onSelectAll: () => void;
  /** The actions, as icon buttons; each caller knows what its list can do. */
  children: ReactNode;
}

/**
 * What is selected, and what can be done to it, floating over the foot of the screen.
 *
 * Evernote's shape, which is where the people using this arrive from: select with the
 * modifier keys, and a bar rises from the bottom saying "3 notes selected" with the
 * actions beside it. Floating rather than in the list's head, because the head is about
 * where you are and this is about what you have picked; and floating rather than docked,
 * so the list under it does not move when a selection begins or ends, motion nobody
 * asked for, on a gesture as small as a Cmd-click. It covers the last row or two, which
 * scrolling gets back; a docked bar would cost that height for as long as it stayed.
 *
 * One bar for every width. On a phone it sits where the New button was (that button
 * hides while anything is selected, since making a note is not something you do to a
 * selection) and the ✕ is the way out there, where a plain tap toggles rows rather than
 * opening them. On a desktop, opening a note also drops the selection, as it does in
 * Finder.
 *
 * Select all reaches the rows that are loaded, not the notebook: what has not been loaded
 * is not on screen, and a bulk action on notes you cannot see is the thing this whole
 * surface must never do. The count is live for a screen reader, since the row's own
 * checkbox says "checked" and nothing else would say how many.
 */
export function SelectionBar({ count, total, onClear, onSelectAll, children }: SelectionBarProps) {
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected notes">
      <button type="button" className="icon-btn" aria-label="Clear selection" data-tip="Clear selection" onClick={onClear}>
        <CancelIcon />
      </button>
      {/* The word is dropped from sight on a narrow phone, where the bar's five 44px
          actions leave no room for it (see `.selection-count-word`). */}
      <span className="selection-count" aria-live="polite">
        {count}
        <span className="selection-count-word"> selected</span>
      </span>
      {/* Offered only while it would do something; once every row is picked it goes. */}
      {count < total && (
        <Button variant="quiet" size="small" onClick={onSelectAll}>
          Select all
        </Button>
      )}
      <span className="selection-actions">{children}</span>
    </div>
  );
}
