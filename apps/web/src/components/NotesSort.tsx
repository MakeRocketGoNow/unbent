import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Sheet } from './Sheet.js';
import { Button } from './Button';
import { FieldTypeIcon, SortIcon } from './icons.js';
import { isCurrencyField, isRatingField, isYearField, type FieldDef, type NoteSort } from '@unbent/shared';
import {
  SORT_OPTIONS,
  sortKey,
  parseSortKey,
  sortLabel,
  fieldSortDirections,
  DEFAULT_ORDER,
} from './sort-options.js';
import { rememberSort } from '../notebook-sort.js';

interface NotesSortProps {
  /** Where the list is, so the choice is remembered for this place; see `rememberSort`. */
  notebook?: string | undefined;
  /**
   * Whether a choice is remembered for the place at all. False inside a saved view, whose
   * order is its own; see `remembersSort` in `NotesLayout`. Defaults to true.
   */
  remember?: boolean;
  sort: NoteSort | undefined;
  order: 'asc' | 'desc' | undefined;
  /** The custom field the list is sorted by instead, if any; see `sortLabel`. */
  sortField?: string | undefined;
  /**
   * The selected notebook's fields, in display order, each offered as a sort. Empty
   * outside a notebook: a field belongs to one, and "All notes" has no fields to order by.
   */
  fields?: FieldDef[] | undefined;
  /**
   * Why there is no order to choose, when there is not: a search drawn as a table or as
   * cards, whose matches are ranked. The icon fades and stays where it was rather than
   * leaving the row, which would slide the search field along it under the typing (the
   * view menu's table fades with its reason the same way, `NotesViewMenu`).
   */
  disabledReason?: string | undefined;
}

/**
 * The note list's sort control: one icon, and the sheet of orders behind it.
 *
 * This was a ⋯ menu holding "Sort: …" and Settings. Settings was here only because the
 * phone hid the topbar over the list and the avatar menu that carried it went with it:
 * a view with no route to Settings was the bigger problem, so sort paid for it with an
 * extra tap. The drawer's floor carries Settings now, as a row beside Trash, which is
 * where Keep puts it and where a thumb that opened the ☰ already is. That frees this
 * corner for the control people actually reach for several times a day, drawn as itself.
 *
 * Sort stays out of the filter sheet for the reason it always did: every filter changes
 * which notes are on screen and this only changes their order, so among the filters
 * "Title A–Z" invites being read as something that narrows.
 *
 * The current order is named in the icon's accessible name rather than beside it: the
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
 * Above the breakpoint the sheet is drawn as a panel beside the list (see `Sheet`).
 */
export function NotesSort({ notebook, remember = true, sort, order, sortField, fields = [], disabledReason }: NotesSortProps) {
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  /*
   * A field sort is none of the named orders, so none of them is marked while it holds;
   * its own row below is. Picking a named order is how it is left again.
   */
  const current = sortField ? null : sortKey(sort, order);
  const sortDef = sortField ? fields.find((d) => d.id === sortField) : undefined;
  // Named once the definition has loaded; until then, honestly, as a field.
  const label = sortField
    ? sortDef
      ? sortLabel(sort, order, sortDef)
      : 'a custom field'
    : sortLabel(sort, order);
  const fieldOrder = order ?? DEFAULT_ORDER;

  const choose = (next: {
    sort: NoteSort | undefined;
    order: 'asc' | 'desc' | undefined;
    sortField: string | undefined;
  }) => {
    if (remember) rememberSort(notebook, next);
    void navigate({ to: '/notes', search: (prev) => ({ ...prev, ...next }) });
    setPicking(false);
  };

  return (
    <>
      <button
        ref={toggle}
        type="button"
        className="icon-btn sort-toggle"
        aria-label={disabledReason ? `Sort notes, ${disabledReason}` : `Sort notes, currently ${label}`}
        data-tip={disabledReason ? `Sort notes, ${disabledReason}` : 'Sort notes'}
        disabled={disabledReason !== undefined}
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
      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        title="Sort notes"
        anchor={toggle}
        className={fields.length > 0 ? 'sort-sheet-fields' : undefined}
      >
        <div className="sort-options">
          {SORT_OPTIONS.map((o) => {
            const on = o.key === current;
            return (
              <button
                key={o.key}
                type="button"
                className={on ? 'sort-option current' : 'sort-option'}
                aria-pressed={on}
                onClick={() => choose({ ...parseSortKey(o.key), sortField: undefined })}
              >
                {o.label}
              </button>
            );
          })}
        </div>

        {/*
            The notebook's fields, one row each: the name, then its two directions.

            One row per field rather than two per field in the list above, which is the
            shape this would otherwise take: a notebook with nine fields would put eighteen rows under five, and the orders
            most people want would scroll away beneath the ones most people do not. The
            name is said once and the choice is only which way, the same thing the
            table's header does with a click, made visible here as two buttons, because
            clicking the same row again to flip it is a gesture nobody would guess.

            The directions are worded for the type ("Newest", "Low–high") and not
            "ascending", for the reason `fieldSortDirections` gives. The phrase in each
            button's accessible name carries the field's name too, since a screen reader
            meeting "Newest" on its own would not know newest what.
        */}
        {fields.length > 0 && (
          <section className="sort-fields" aria-labelledby="sort-fields-head">
            <h3 id="sort-fields-head" className="sort-fields-head">
              By field
            </h3>
            {fields.map((def) => (
              <div key={def.id} className="sort-field" role="group" aria-label={def.name}>
                <span className="sort-field-name">
                  <FieldTypeIcon
                    type={def.type}
                    rating={isRatingField(def)}
                    currency={isCurrencyField(def)}
                    year={isYearField(def)}
                  />
                  <span className="sort-field-label" title={def.name}>
                    {def.name}
                  </span>
                </span>
                <span className="sort-field-directions">
                  {fieldSortDirections(def.type).map((d) => {
                    const on = sortField === def.id && fieldOrder === d.order;
                    return (
                      <button
                        key={d.order}
                        type="button"
                        className={on ? 'sort-direction current' : 'sort-direction'}
                        aria-pressed={on}
                        aria-label={`${def.name}, ${d.phrase}`}
                        onClick={() =>
                          choose({
                            sort: undefined,
                            order: d.order === DEFAULT_ORDER ? undefined : d.order,
                            sortField: def.id,
                          })
                        }
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </span>
              </div>
            ))}
          </section>
        )}
        <div className="sheet-foot">
          <Button variant="quiet" onClick={() => setPicking(false)}>
            Done
          </Button>
        </div>
      </Sheet>
    </>
  );
}
