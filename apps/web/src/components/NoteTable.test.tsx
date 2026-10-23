import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { FieldDef, NoteSummary } from '@unbent/shared';
import { NoteTable } from './NoteTable.js';
import { noteColumns } from './note-columns.js';

/**
 * The list as a table.
 *
 * What is worth pinning is the part the URL and the API cannot check for themselves: that
 * a header says which column is in charge and asks for the next order rather than
 * deciding it, that the name is a real link, and that a row with nothing in a field shows
 * nothing rather than a word.
 */
const cost: FieldDef = { id: 'f-cost', notebookId: 'nb', name: 'Cost', type: 'number', options: [], scale: null, currency: null, position: 0 };
const packed: FieldDef = { id: 'f-packed', notebookId: 'nb', name: 'Packed', type: 'checkbox', options: [], scale: null, currency: null, position: 1 };
const fare: FieldDef = { id: 'f-fare', notebookId: 'nb', name: 'Fare', type: 'number', options: [], scale: null, currency: 'USD', position: 3 };
const stars: FieldDef = { id: 'f-stars', notebookId: 'nb', name: 'Stars', type: 'number', options: [], scale: { max: 5, step: 1 }, currency: null, position: 4 };
const status: FieldDef = { id: 'f-status', notebookId: 'nb', name: 'Status', type: 'select', options: ['Booked', 'Done'], scale: null, currency: null, position: 2 };

const note = (id: string, title: string, fields: NoteSummary['fields']): NoteSummary => ({
  id,
  title,
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: Date.UTC(2026, 0, 2),
  tags: ['travel'],
  notebook: 'Travel',
  notebookId: 'nb',
  ...(fields ? { fields } : {}),
});

function harness(props: Partial<Parameters<typeof NoteTable>[0]> = {}) {
  const full: Parameters<typeof NoteTable>[0] = {
    notes: [
      note('n1', 'Ski trip', [
        { fieldId: 'f-cost', name: 'Cost', type: 'number', value: 2100, notebookId: 'nb', notebook: 'Travel' },
        { fieldId: 'f-packed', name: 'Packed', type: 'checkbox', value: false, notebookId: 'nb', notebook: 'Travel' },
      ]),
      note('n2', '', undefined),
    ],
    columns: noteColumns([cost, packed]),
    search: {},
    notebook: 'Travel',
    total: 2,
    busy: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    onLoadMore: () => {},
    onSort: () => {},
    onKeyDown: () => {},
    tableRef: { current: null },
    empty: 'No notes in Travel.',
    ...props,
  };
  const rootRoute = createRootRoute({ component: () => <NoteTable {...full} /> });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...render(<RouterProvider router={router as any} />), history };
}

describe('NoteTable', () => {
  afterEach(cleanup);

  it('draws a column per field with the value formatted, blank when unset', async () => {
    const { findByRole, getAllByRole } = harness();
    const table = await findByRole('table', { name: 'Notes in Travel' });
    expect(table.getAttribute('aria-rowcount')).toBe('2');
    const headers = getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Name', 'Cost', 'Packed', 'Tags', 'Updated', 'Created']);
    const rows = getAllByRole('row').slice(1);
    const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map((c) => c.textContent);
    expect(cells(rows[0]!).slice(0, 4)).toEqual(['Ski trip', '2,100', 'No', '#travel']);
    expect(cells(rows[1]!).slice(0, 3)).toEqual(['Untitled', '', '']);
  });

  it('links the name to the note', async () => {
    const { findByRole } = harness();
    const link = await findByRole('link', { name: 'Ski trip' });
    expect(link.getAttribute('href')).toBe('/notes/n1');
  });

  it('marks the sorted column from the URL and asks for the next order on click', async () => {
    const onSort = vi.fn();
    const { findByRole, getByRole } = harness({
      search: { sortField: 'f-cost', order: 'asc' },
      onSort,
    });
    await findByRole('table');
    expect(getByRole('columnheader', { name: 'Cost' }).getAttribute('aria-sort')).toBe('ascending');
    expect(getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Sort by Cost, ascending' }));
    expect(onSort).toHaveBeenCalledWith({ kind: 'field', fieldId: 'f-cost' });
    fireEvent.click(getByRole('button', { name: 'Sort by Name' }));
    expect(onSort).toHaveBeenCalledWith({ kind: 'note', sort: 'title' });
  });

  it('shows no order over a search, whose matches are ranked, and takes no header clicks', async () => {
    const onSort = vi.fn();
    const { findByRole, getByRole, queryAllByRole } = harness({
      search: { sortField: 'f-cost', order: 'asc' },
      ranked: true,
      onSort,
    });
    await findByRole('table', { name: 'Matches in Travel' });
    expect(queryAllByRole('columnheader').filter((h) => h.hasAttribute('aria-sort'))).toEqual([]);
    const header = getByRole('button', { name: 'Sort by Cost' });
    expect((header as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(header);
    expect(onSort).not.toHaveBeenCalled();
  });

  it("names the file a search matched in beside the row's name", async () => {
    const { findByRole } = harness({ ranked: true, hints: new Map([['n1', 'in Report (final) v2.pdf']]) });
    const link = await findByRole('link', { name: /Ski trip/ });
    expect(link.textContent).toBe('Ski tripin Report (final) v2.pdf');
    expect(link.querySelector('.note-row-match')?.textContent).toBe('in Report (final) v2.pdf');
  });

  it('marks the default sort when the URL carries none', async () => {
    const { findByRole, getByRole } = harness();
    await findByRole('table');
    expect(getByRole('columnheader', { name: 'Created' }).getAttribute('aria-sort')).toBe('descending');
  });

  it('offers the next page the way the list does', async () => {
    const onLoadMore = vi.fn();
    const { findByRole } = harness({ hasNextPage: true, total: 40, onLoadMore });
    // The button says how much is loaded; the header above the table states the total.
    fireEvent.click(await findByRole('button', { name: 'Load more · 2 of 40' }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  /* The single-choice types edit in place; the row's own click must not swallow them. */
  it('edits a checkbox and a select in the cell, and clears a select back to nothing', async () => {
    const onEdit = vi.fn();
    const { findByRole, getByRole } = harness({
      columns: noteColumns([cost, packed, status]),
      onEdit,
    });
    await findByRole('table');
    fireEvent.click(getByRole('checkbox', { name: 'Packed for Ski trip' }));
    expect(onEdit).toHaveBeenCalledWith('n1', packed, true);
    const select = getByRole('combobox', { name: 'Status for Ski trip' });
    fireEvent.change(select, { target: { value: 'Booked' } });
    expect(onEdit).toHaveBeenCalledWith('n1', status, 'Booked');
    fireEvent.change(select, { target: { value: '' } });
    expect(onEdit).toHaveBeenCalledWith('n1', status, null);
  });

  it('keeps a number cell as text, even when editing is on', async () => {
    const { findByRole, getAllByRole } = harness({ onEdit: () => {} });
    await findByRole('table');
    const first = getAllByRole('row')[1]!;
    expect(first.querySelectorAll('td')[1]?.textContent).toBe('2,100');
    expect(first.querySelectorAll('input, select')).toHaveLength(1);
  });

  it('says so when there is nothing to show', async () => {
    const { findByText } = harness({ notes: [], total: 0 });
    expect(await findByText('No notes in Travel.')).toBeTruthy();
  });
});

/*
 * The selection column: a checkbox per row, a select-all in the header that becomes a
 * clear once every row is picked, and the list's modifier clicks on the row's whole width.
 */
describe('the selection column', () => {
  afterEach(cleanup);

  const selection = (over: Partial<NonNullable<Parameters<typeof NoteTable>[0]['selection']>> = {}) => ({
    has: () => false,
    active: false,
    all: false,
    onPick: vi.fn(),
    onSelectAll: vi.fn(),
    onClear: vi.fn(),
    ...over,
  });

  it('is absent without a selection', async () => {
    const { findByRole, queryAllByRole } = harness();
    await findByRole('table');
    expect(queryAllByRole('checkbox')).toEqual([]);
  });

  it('adds a checkbox per row and a select-all in the header', async () => {
    const sel = selection();
    const { findByRole, getByRole } = harness({ selection: sel });
    await findByRole('table');
    fireEvent.click(getByRole('checkbox', { name: 'Select all loaded notes' }));
    expect(sel.onSelectAll).toHaveBeenCalled();
    fireEvent.click(getByRole('checkbox', { name: 'Select Ski trip' }), { shiftKey: true });
    expect(sel.onPick).toHaveBeenCalledWith('n1', { range: true });
  });

  it('clears from the header once every row is selected', async () => {
    const sel = selection({ has: () => true, active: true, all: true });
    const { findByRole } = harness({ selection: sel });
    const head = (await findByRole('checkbox', { name: 'Clear selection' })) as HTMLInputElement;
    expect(head.checked).toBe(true);
    fireEvent.click(head);
    expect(sel.onClear).toHaveBeenCalled();
  });

  it('picks on a modifier click anywhere on the row, without opening the note', async () => {
    const sel = selection();
    const { findByText, getAllByRole, history } = harness({ selection: sel });
    fireEvent.click(await findByText('Ski trip'), { metaKey: true });
    expect(sel.onPick).toHaveBeenCalledWith('n1', { range: false });
    const cells = getAllByRole('row')[1]!.querySelectorAll('td');
    fireEvent.click(cells[2]!, { shiftKey: true });
    expect(sel.onPick).toHaveBeenLastCalledWith('n1', { range: true });
    expect(history.location.pathname).toBe('/notes');
  });

  describe('totals', () => {
    const footer = (container: HTMLElement) =>
      [...container.querySelectorAll('tfoot td')].map((c) => c.textContent);

    it('draws a footer under the number columns, formatted as their cells are, and nothing under a rating', async () => {
      const { findByRole, container } = harness({
        columns: noteColumns([cost, fare, stars]),
        totals: { label: 'Total', sums: new Map([['f-cost', 2400.5], ['f-fare', 2110.58], ['f-stars', 9]]) },
      });
      await findByRole('table');
      // Name, Cost, Fare, Stars, Tags, Updated, Created.
      expect(footer(container)).toEqual(['Total', '2,400.5', '$2,110.58', '', '', '', '']);
    });

    it('says what the rows are when they are not the whole list', async () => {
      const { findByRole, container } = harness({
        ranked: true,
        totals: { label: 'Total of top 50', sums: new Map([['f-cost', 1]]) },
      });
      await findByRole('table');
      expect(footer(container)[0]).toBe('Total of top 50');
    });

    it('keeps the selection column empty, so the label stays under the names', async () => {
      const { findByRole, container } = harness({
        totals: { label: 'Total', sums: new Map([['f-cost', 1]]) },
        selection: { has: () => false, active: false, all: false, onPick: () => {}, onSelectAll: () => {}, onClear: () => {} },
      });
      await findByRole('table');
      expect(footer(container).slice(0, 3)).toEqual(['', 'Total', '1']);
    });

    it('draws no footer with nothing to total or no rows', async () => {
      const blank = harness({ totals: { label: 'Total', sums: new Map() } });
      await blank.findByRole('table');
      expect(blank.container.querySelector('tfoot')).toBeNull();
      cleanup();
      const empty = harness({ notes: [], totals: { label: 'Total', sums: new Map([['f-cost', 1]]) } });
      await empty.findByRole('table');
      expect(empty.container.querySelector('tfoot')).toBeNull();
    });
  });
});
