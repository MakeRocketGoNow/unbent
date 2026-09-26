import { describe, it, expect } from 'vitest';
import { FIELD_TYPES } from '@unbent/shared';
import {
  SORT_OPTIONS,
  fieldSortDirections,
  sortKey,
  parseSortKey,
  sortLabel,
  columnSortState,
  nextColumnSort,
} from './sort-options.js';

/**
 * The sort key round trip.
 *
 * Two controls read this list now — the desktop `<select>`, whose value *is* the key, and
 * the phone's sort menu, which compares against it to mark the active option. What the
 * tests pin is the asymmetry between them: `sortKey` fills the default *in* so a control
 * always has a value to show, and `parseSortKey` takes it back *out* so the default never
 * reaches the URL. Getting either direction wrong is invisible until a link is shared.
 */
describe('sort options', () => {
  it('names every option distinctly, keyed by its own field and direction', () => {
    const keys = SORT_OPTIONS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(SORT_OPTIONS.map((o) => o.label)).size).toBe(SORT_OPTIONS.length);
    for (const o of SORT_OPTIONS) expect(o.key).toBe(`${o.sort}:${o.order}`);
  });

  it('fills in the default for a URL that omits it', () => {
    expect(sortKey(undefined, undefined)).toBe('updated:desc');
    expect(sortLabel(undefined, undefined)).toBe('Recently updated');
  });

  it('reads a key the select or menu produced', () => {
    expect(parseSortKey('created:asc')).toEqual({ sort: 'created', order: 'asc' });
    expect(sortLabel('created', 'asc')).toBe('Oldest first');
  });

  /*
   * The point of the whole module: picking the default removes the parameters rather than
   * spelling out what absence already means, so `/notes` stays the clean link.
   */
  it('drops each half of the default rather than writing it to the URL', () => {
    expect(parseSortKey('updated:desc')).toEqual({ sort: undefined, order: undefined });
    // Half a default is still dropped by half: the field is the default, the direction is not.
    expect(parseSortKey('updated:asc')).toEqual({ sort: undefined, order: 'asc' });
    expect(parseSortKey('title:desc')).toEqual({ sort: 'title', order: undefined });
  });

  it('round-trips every option the UI offers', () => {
    for (const o of SORT_OPTIONS) {
      const { sort, order } = parseSortKey(o.key);
      expect(sortKey(sort, order)).toBe(o.key);
    }
  });
});

/**
 * Sorting from a table column header.
 *
 * The header is the only control that can choose a sort by a custom field, and the two
 * kinds of sort share one URL: what the cases pin is that choosing either kind removes the
 * other, that a first click lands on the order that column is wanted in, and that the
 * defaults still stay out of the URL.
 */
describe('column sorting', () => {
  const name = { kind: 'note', sort: 'title' } as const;
  const updated = { kind: 'note', sort: 'updated' } as const;
  const amount = { kind: 'field', fieldId: 'f-amount' } as const;

  it('reports which column the URL is sorted by, filling in the default', () => {
    expect(columnSortState(updated, {})).toBe('desc');
    expect(columnSortState(name, {})).toBeNull();
    expect(columnSortState(name, { sort: 'title', order: 'asc' })).toBe('asc');
    expect(columnSortState(amount, { sortField: 'f-amount', order: 'asc' })).toBe('asc');
    expect(columnSortState(amount, { sortField: 'f-amount' })).toBe('desc');
    // A field sort outranks the named one, so the default column is not marked either.
    expect(columnSortState(updated, { sortField: 'f-amount' })).toBeNull();
  });

  it('starts names and fields ascending, dates newest first', () => {
    expect(nextColumnSort(name, {})).toEqual({ sort: 'title', order: 'asc', sortField: undefined });
    expect(nextColumnSort(amount, {})).toEqual({ sort: undefined, order: 'asc', sortField: 'f-amount' });
    expect(nextColumnSort({ kind: 'note', sort: 'created' }, {})).toEqual({
      sort: 'created',
      order: undefined,
      sortField: undefined,
    });
  });

  it('flips the column already in charge, and never cycles to no order', () => {
    // Descending is the wire's default, so Z–A is `sort=title` alone.
    expect(nextColumnSort(name, { sort: 'title', order: 'asc' })).toEqual({
      sort: 'title',
      order: undefined,
      sortField: undefined,
    });
    expect(nextColumnSort(name, { sort: 'title' })).toEqual({
      sort: 'title',
      order: 'asc',
      sortField: undefined,
    });
    expect(nextColumnSort(amount, { sortField: 'f-amount', order: 'asc' })).toEqual({
      sort: undefined,
      order: undefined,
      sortField: 'f-amount',
    });
    expect(nextColumnSort(amount, { sortField: 'f-amount' })).toEqual({
      sort: undefined,
      order: 'asc',
      sortField: 'f-amount',
    });
  });

  it('writes the default named sort as absence, from a field sort too', () => {
    expect(nextColumnSort(updated, { sortField: 'f-amount', order: 'asc' })).toEqual({
      sort: undefined,
      order: undefined,
      sortField: undefined,
    });
  });

  it("names a field sort from the field and its direction, in the field's own words", () => {
    const amount = { name: 'Amount', type: 'number' as const };
    expect(sortLabel(undefined, 'asc', amount)).toBe('Amount, lowest first');
    expect(sortLabel(undefined, undefined, amount)).toBe('Amount, highest first');
    expect(sortLabel(undefined, 'asc', { name: 'Due', type: 'date' })).toBe('Due, oldest first');
    expect(sortLabel(undefined, 'desc', { name: 'Store', type: 'select' })).toBe('Store, Z–A');
  });

  /* Each type offers both ends, once each, whatever order it puts them in. */
  it('offers both directions for every field type', () => {
    for (const type of FIELD_TYPES) {
      const orders = fieldSortDirections(type).map((d) => d.order).sort();
      expect(orders).toEqual(['asc', 'desc']);
    }
  });

  it('leads with the end people reach for', () => {
    expect(fieldSortDirections('date')[0]).toMatchObject({ order: 'desc', label: 'Newest' });
    expect(fieldSortDirections('checkbox')[0]).toMatchObject({ order: 'desc', label: 'Checked' });
    expect(fieldSortDirections('number')[0]).toMatchObject({ order: 'asc', label: 'Low–high' });
    expect(fieldSortDirections('text')[0]).toMatchObject({ order: 'asc', label: 'A–Z' });
  });
});
