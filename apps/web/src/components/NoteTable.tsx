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
import { useAutoLoad } from './useAutoLoad.js';

interface NoteTableProps {
  notes: NoteSummary[];
  columns: NoteColumn[];
  /** The URL's ordering, which is what the headers show and what a click changes. */
  search: SortSearch;
  /**
   * The rows are a search's matches, in order of relevance: the headers show no order and
   * take no clicks, since a column order over the best fifty matches could leave out the
   * very rows it promises first. The table's own order is back when the search ends.
   */
  ranked?: boolean;
  /**
   * Why a row matched, beside its name, when nothing else on the row says: a search
   * that found the word in one of the note's files. Keyed by note id.
   */
  hints?: ReadonlyMap<string, string> | undefined;
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
   * A cell was edited. Only the single-choice types edit in place: a checkbox, a select;
   * the rest open the note. Absent, every cell is read-only.
   */
  onEdit?: ((noteId: string, def: FieldDef, value: FieldValue | null) => void) | undefined;
  /**
   * The list's selection, drawn as a first column of checkboxes with a select-all in the
   * header. Absent, the table has no such column.
   */
  selection?: TableSelection | undefined;
}

export interface TableSelection {
  has: (id: string) => boolean;
  /** Whether any row is selected. */
  active: boolean;
  /** Every loaded row is selected, which is when the header's box is checked. */
  all: boolean;
  onPick: (id: string, opts: { range: boolean }) => void;
  onSelectAll: () => void;
  onClear: () => void;
}

/**
 * The note list drawn as a table: one row per note, one column per field.
 *
 * The same rows, filters, sort and pages as the sidebar's list, drawn so that a field can
 * be read down a column rather than one note at a time, which is the whole point of a
 * notebook having fields. The headers sort; the URL is the sort state, so a header only
 * reports what it reads there and asks the caller to write the next one.
 *
 * The name is a real link, the way a sidebar entry is, so middle-click and copy-link
 * work; the rest of the row opens the note too, by pressing that link, because a row
 * whose only live pixels were its first word would feel broken. Cells the row's link would
 * swallow (a control, another link) are left to themselves.
 *
 * A hand-written `<table>` rather than a table library, for now. Everything a library
 * would own here is small: the sort is URL state fed to the server, the pages come from
 * the query, the pinned column is one CSS rule. `note-columns.ts` is the seam if that
 * changes.
 *
 * Selecting several is the table's own shape rather than the sidebar's: a column of
 * checkboxes, always there, with the header's box selecting or clearing every loaded row:
 * Gmail's table, and every spreadsheet's. A table is wide enough to spend a column on
 * it, where the sidebar's rows were not. The modifier clicks still work on a row, for
 * the hand that has learnt them in the list, and a checkbox takes Shift for a range.
 */
export function NoteTable({
  notes,
  columns,
  search,
  ranked = false,
  hints,
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
  selection,
}: NoteTableProps) {
  const span = columns.length + (selection ? 1 : 0);
  const autoLoad = useAutoLoad({
    enabled: hasNextPage && !isFetchingNextPage,
    loaded: notes.length,
    onLoad: onLoadMore,
  });
  return (
    <div
      className="note-table-wrap"
      ref={tableRef}
      aria-busy={busy || undefined}
      onKeyDown={onKeyDown}
    >
      <table
        className={selection ? 'note-table selectable' : 'note-table'}
        aria-label={ranked ? `Matches in ${notebook}` : `Notes in ${notebook}`}
        aria-rowcount={total ?? undefined}
        aria-multiselectable={selection ? true : undefined}
      >
        <thead>
          <tr>
            {selection && (
              <th scope="col" className="note-table-check">
                <input
                  type="checkbox"
                  aria-label={selection.all ? 'Clear selection' : 'Select all loaded notes'}
                  checked={selection.all && notes.length > 0}
                  disabled={notes.length === 0}
                  ref={(el) => {
                    // Some but not all: the header shows the half state a spreadsheet does.
                    if (el) el.indeterminate = selection.active && !selection.all;
                  }}
                  onChange={() => (selection.all ? selection.onClear() : selection.onSelectAll())}
                />
              </th>
            )}
            {columns.map((col) => {
              const state = col.sortTarget && !ranked ? columnSortState(col.sortTarget, search) : null;
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
                      // Disabled rather than withdrawn, so the header row keeps its shape
                      // as a search starts and ends (see `ranked`).
                      disabled={ranked}
                      data-tip={ranked ? 'Matches are in order of relevance' : undefined}
                      aria-description={ranked ? 'Matches are in order of relevance' : undefined}
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
              className={selection?.has(note.id) ? 'note-row selected' : 'note-row'}
              aria-selected={selection ? selection.has(note.id) : undefined}
              // Like a sidebar entry: a click here is browsing, and the editor stands
              // down so the arrows keep working. Read by `useListKeys`' pointerdown.
              data-keep-focus=""
              onClick={(e) => {
                if (!(e.target instanceof Element)) return;
                // A control in a cell, or the name link itself, handles its own click.
                if (e.target.closest('a, button, input, select, label')) return;
                // The list's keys, on the row's whole width.
                if (selection && (e.metaKey || e.ctrlKey || e.shiftKey)) {
                  e.preventDefault();
                  selection.onPick(note.id, { range: e.shiftKey });
                  return;
                }
                const link = e.currentTarget.querySelector<HTMLAnchorElement>('.note-row-link');
                link?.focus();
                link?.click();
              }}
            >
              {selection && (
                <td className="note-table-check">
                  <input
                    type="checkbox"
                    checked={selection.has(note.id)}
                    aria-label={`Select ${note.title || 'Untitled'}`}
                    onChange={() => undefined}
                    onClick={(e) => selection.onPick(note.id, { range: e.shiftKey })}
                  />
                </td>
              )}
              {columns.map((col) => (
                <td key={col.id} data-align={col.align}>
                  {cell(col, note, onEdit, selection, hints?.get(note.id))}
                </td>
              ))}
            </tr>
          ))}

          {hasNextPage && (
            <tr>
              <td colSpan={span} className="note-table-more">
                <button
                  ref={autoLoad}
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
              <td colSpan={span} className="muted small empty">
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
  selection: TableSelection | undefined,
  hint: string | undefined,
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
          // The modifier clicks pick, as they do on a sidebar entry (see `NoteListItem`
          // for why they are taken from the link). Space picks too.
          onClick={(e) => {
            if (selection && (e.metaKey || e.ctrlKey || e.shiftKey)) {
              e.preventDefault();
              selection.onPick(note.id, { range: e.shiftKey });
            }
          }}
          onKeyDown={(e) => {
            if (selection && e.key === ' ') {
              e.preventDefault();
              selection.onPick(note.id, { range: e.shiftKey });
            }
          }}
        >
          {hint ? (
            <>
              <span className="note-row-title">{note.title || 'Untitled'}</span>
              <span className="note-row-match">{hint}</span>
            </>
          ) : (
            note.title || 'Untitled'
          )}
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
