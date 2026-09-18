import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Sheet } from './Sheet.js';
import { Button } from './Button';
import { SortIcon } from './icons.js';
import type { NoteSort } from '@unbent/shared';
import { SORT_OPTIONS, sortKey, parseSortKey, sortLabel } from './sort-options.js';

interface NotesSortProps {
  sort: NoteSort | undefined;
  order: 'asc' | 'desc' | undefined;
  /** The custom field the list is sorted by instead, if any; see `sortLabel`. */
  sortField?: string | undefined;
  /** That field's name, once its definition has loaded. */
  fieldName?: string | undefined;
}

/**
 * The note list's sort control: one icon, and the sheet of orders behind it.
 *
 * This was a ⋯ menu holding "Sort: …" and Settings. Settings was here only because the
 * phone hid the topbar over the list and the avatar menu that carried it went with it —
 * a view with no route to Settings was the bigger problem, so sort paid for it with an
 * extra tap. The drawer's floor carries Settings now, as a row beside Trash, which is
 * where Keep puts it and where a thumb that opened the ☰ already is. That frees this
 * corner for the control people actually reach for several times a day, drawn as itself.
 *
 * Sort stays out of the filter sheet for the reason it always did: every filter changes
 * which notes are on screen and this only changes their order, so among the filters
 * "Title A–Z" invites being read as something that narrows.
 *
 * The current order is named in the icon's accessible name rather than beside it — the
 * row has no room for a caption, and the sheet marks the current choice the moment it
 * opens, so nothing is hidden that a second tap would have revealed.
 *
 * The caller decides whether this renders at all: while searching, results come back ranked
 * by relevance and reordering them would throw that ranking away, so the icon goes.
 *
 * At every width, since the desktop sidebar took the phone's header. The desktop had a
 * `<select>` in its column for this, which showed the current order without a tap and
 * was the better control for a mouse; it went with the rest of that column, because the
 * column's whole problem was rows of controls above a list with no room left for notes.
 * Above the breakpoint the sheet is drawn as a panel beside the list — see `Sheet`.
 */
export function NotesSort({ sort, order, sortField, fieldName }: NotesSortProps) {
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  /*
   * A field sort is none of the named orders, so none is marked: the table's column
   * header is where it shows. Picking a named order here is how it is left again.
   */
  const current = sortField ? null : sortKey(sort, order);
  const label = sortField ? sortLabel(sort, order, fieldName ?? 'a field') : sortLabel(sort, order);

  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Sort notes, currently ${label}`}
        onClick={() => setPicking(true)}
      >
        <SortIcon />
      </button>

      {/*
          The orders themselves, as a sheet rather than a menu.

          A menu shows the current choice only after a second tap, and these labels are
          longer than a menu row wants to be. Android reaches for a dialog here for the same
          reasons; this app's equivalent surface is the sheet it already has.
      */}
      <Sheet open={picking} onClose={() => setPicking(false)} title="Sort notes">
        <div className="sort-options">
          {SORT_OPTIONS.map((o) => {
            const on = o.key === current;
            return (
              <button
                key={o.key}
                type="button"
                className={on ? 'sort-option current' : 'sort-option'}
                aria-pressed={on}
                onClick={() => {
                  void navigate({
                    to: '/notes',
                    search: (prev) => ({ ...prev, ...parseSortKey(o.key), sortField: undefined }),
                  });
                  setPicking(false);
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <div className="sheet-foot">
          <Button variant="quiet" onClick={() => setPicking(false)}>
            Done
          </Button>
        </div>
      </Sheet>
    </>
  );
}
