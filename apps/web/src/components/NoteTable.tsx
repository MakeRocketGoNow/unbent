import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { Link } from '@tanstack/react-router';
import type { FieldDef, FieldValue, NoteSummary } from '@unbent/shared';
import { FieldCellInput } from './FieldCellInput.js';
import type { NoteColumn } from './note-columns.js';
import { columnSortState, type SortSearch, type SortTarget } from './sort-options.js';
import { formatFieldValue } from './format-field.js';
import { formatWhen } from './format-when.js';
import { SortDirectionIcon } from './icons.js';
import { loadMoreLabel } from './load-more.js';

interface NoteTableProps {
  notes: NoteSummary[];
  columns: NoteColumn[];
  /** The URL's ordering, which is what the headers show and what a click changes. */
  search: SortSearch;
  /** The notebook the rows belong to, which names the table. */
  notebook: string;
  /** Live notes in the notebook, for the table's row count; null until known. */
  total: number | null;
  /** The rows on screen are the previous scope's; see `stale` in `NotesLayout`. */
  busy: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onSort: (target: SortTarget) => void;
  /** The arrow keys, shared with the list; see `useListKeys`. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  tableRef: RefObject<HTMLDivElement | null>;
  /** What to say when there are no rows, or nothing while the first page loads. */
  empty: ReactNode;
  /**
   * A cell was edited. Only the single-choice types edit in place — a checkbox, a select;
   * the rest open the note. Absent, every cell is read-only.
   */
  onEdit?: ((noteId: string, def: FieldDef, value: FieldValue | null) => void) | undefined;
}

/**
 * The note list drawn as a table: one row per note, one column per field.
 *
 * The same rows, filters, sort and pages as the sidebar's list, drawn so that a field can
 * be read down a column rather than one note at a time — which is the whole point of a
 * notebook having fields. The headers sort; the URL is the sort state, so a header only
 * reports what it reads there and asks the caller to write the next one.
 *
 * The name is a real link, the way a sidebar entry is, so middle-click and copy-link
 * work; the rest of the row opens the note too, by pressing that link, because a row
 * whose only live pixels were its first word would feel broken. Cells the row's link would
 * swallow — a control, another link — are left to themselves.
 *
 * A hand-written `<table>` rather than a table library, for now. Everything a library
 * would own here is small: the sort is URL state fed to the server, the pages come from
 * the query, the pinned column is one CSS rule. `note-columns.ts` is the seam if that
 * changes.
 */
export function NoteTable({
  notes,
  columns,
  search,
  notebook,
  total,
  busy,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onSort,
  onKeyDown,
  tableRef,
  empty,
  onEdit,
}: NoteTableProps) {
  return (
    <div
      className="note-table-wrap"
      ref={tableRef}
      aria-busy={busy || undefined}
      onKeyDown={onKeyDown}
    >
      <table
        className="note-table"
        aria-label={`Notes in ${notebook}`}
        aria-rowcount={total ?? undefined}
      >
        <thead>
          <tr>
            {columns.map((col) => {
              const state = col.sortTarget ? columnSortState(col.sortTarget, search) : null;
              const target = col.sortTarget;
              return (
                <th
                  key={col.id}
                  scope="col"
                  data-align={col.align}
                  aria-sort={state === 'asc' ? 'ascending' : state === 'desc' ? 'descending' : undefined}
                >
                  {target ? (
                    <button
                      type="button"
                      className="note-th-sort"
                      // The direction is in the name, since the arrow is the only other
                      // place it shows and an arrow is not read aloud.
                      aria-label={`Sort by ${col.label}${state ? `, ${state === 'asc' ? 'ascending' : 'descending'}` : ''}`}
                      onClick={() => onSort(target)}
                    >
                      {col.label}
                      {state && <SortDirectionIcon direction={state} />}
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {notes.map((note) => (
            <tr
              key={note.id}
              className="note-row"
              // Like a sidebar entry: a click here is browsing, and the editor stands
              // down so the arrows keep working. Read by `useListKeys`' pointerdown.
              data-keep-focus=""
              onClick={(e) => {
                if (!(e.target instanceof Element)) return;
                // A control in a cell, or the name link itself, handles its own click.
                if (e.target.closest('a, button, input, select, label')) return;
                const link = e.currentTarget.querySelector<HTMLAnchorElement>('.note-row-link');
                link?.focus();
                link?.click();
              }}
            >
              {columns.map((col) => (
                <td key={col.id} data-align={col.align}>
                  {cell(col, note, onEdit)}
                </td>
              ))}
            </tr>
          ))}

          {hasNextPage && (
            <tr>
              <td colSpan={columns.length}>
                <button
                  type="button"
                  className="load-more"
                  disabled={isFetchingNextPage}
                  onClick={onLoadMore}
                >
                  {loadMoreLabel(notes.length, total, isFetchingNextPage)}
                </button>
              </td>
            </tr>
          )}

          {notes.length === 0 && empty && (
            <tr>
              <td colSpan={columns.length} className="muted small empty">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function cell(
  col: NoteColumn,
  note: NoteSummary,
  onEdit: NoteTableProps['onEdit'],
): ReactNode {
  switch (col.kind) {
    case 'name':
      return (
        <Link
          to="/notes/$noteId"
          params={{ noteId: note.id }}
          // The filters ride along, as they do from a sidebar entry.
          search={(prev) => prev}
          className="note-row-link"
          activeProps={{ className: 'note-row-link active' }}
        >
          {note.title || 'Untitled'}
        </Link>
      );
    case 'field': {
      const def = col.def!;
      const held = note.fields?.find((f) => f.fieldId === def.id);
      if (onEdit && (def.type === 'checkbox' || def.type === 'select')) {
        return (
          <FieldCellInput
            def={def}
            value={held?.value ?? null}
            label={`${def.name} for ${note.title || 'Untitled'}`}
            onChange={(value) => onEdit(note.id, def, value)}
          />
        );
      }
      // Blank, not "Empty": a table cell with nothing in it is legible on its own, and the
      // word is the property list's for a control that would otherwise draw nothing.
      return held ? formatFieldValue(def.type, held.value, def.scale, def.currency) : '';
    }
    case 'tags':
      return note.tags.map((t) => `#${t}`).join(' ');
    case 'updated':
      return formatWhen(note.updatedAt);
    case 'created':
      return formatWhen(note.createdAt);
  }
}
