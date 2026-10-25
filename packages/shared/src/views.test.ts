import { describe, expect, it } from 'vitest';
import {
  addressOfView,
  createViewSchema,
  dropFieldFromQuery,
  narrowsList,
  renameTagInQuery,
  sameViewQuery,
  updateViewSchema,
  viewQueryOf,
  viewQuerySchema,
} from './views.js';

const FIELD = '6b9a2d1e-4c3f-4a7b-9e1d-2f3a4b5c6d7e';
const OTHER = '0f1e2d3c-4b5a-4968-8776-655443322110';

describe('viewQueryOf', () => {
  it('spells the address one way: sets sorted, defaults left out, the layout renamed', () => {
    expect(
      viewQueryOf({
        tag: ['Work', 'alpha', 'Work'],
        field: [`${OTHER}:set`, `${FIELD}:eq:Business`],
        sort: 'created',
        order: 'desc',
        from: '2026-01-01',
        view: 'table',
      }),
    ).toEqual({
      tag: ['alpha', 'Work'],
      field: [`${OTHER}:set`, `${FIELD}:eq:Business`],
      from: '2026-01-01',
      layout: 'table',
    });
  });

  it('keeps a sort that is not the default, and lets a field sort win over it', () => {
    expect(viewQueryOf({ sort: 'title', order: 'asc' })).toEqual({ sort: 'title', order: 'asc' });
    expect(viewQueryOf({ sort: 'title', sortField: FIELD })).toEqual({ sortField: FIELD });
  });

  it('drops a field filter it cannot read rather than carrying it', () => {
    expect(viewQueryOf({ field: ['nonsense'] })).toEqual({});
  });
});

describe('addressOfView', () => {
  it('is the inverse of viewQueryOf, under the address’s own names', () => {
    const query = viewQueryOf({ tag: ['b', 'a'], sortField: FIELD, order: 'asc', to: '2026-12-31', view: 'cards' });
    expect(addressOfView(query)).toEqual({
      tag: ['a', 'b'],
      sortField: FIELD,
      order: 'asc',
      to: '2026-12-31',
      view: 'cards',
    });
    expect(viewQueryOf(addressOfView(query))).toEqual(query);
  });
});

describe('sameViewQuery', () => {
  it('reads an explicit default and a different tag order as the same list', () => {
    expect(sameViewQuery({ tag: ['b', 'a'], sort: 'created' }, { tag: ['a', 'b'], order: 'desc' })).toBe(true);
  });

  it('sees a changed filter', () => {
    expect(sameViewQuery({ tag: ['a'] }, { tag: ['a', 'b'] })).toBe(false);
    expect(sameViewQuery({ from: '2026-01-01' }, {})).toBe(false);
  });

  it('compares the layout only when both sides name one', () => {
    expect(sameViewQuery({ tag: ['a'], layout: 'table' }, { tag: ['a'] })).toBe(true);
    expect(sameViewQuery({ tag: ['a'], layout: 'table' }, { tag: ['a'], layout: 'list' })).toBe(false);
  });
});

describe('narrowsList', () => {
  it('is false for a plain notebook, whatever its layout, and true for any filter or sort', () => {
    expect(narrowsList({})).toBe(false);
    expect(narrowsList({ view: 'table', sort: 'created', order: 'desc' })).toBe(false);
    expect(narrowsList({ sort: 'title' })).toBe(true);
    expect(narrowsList({ tag: ['a'] })).toBe(true);
    expect(narrowsList({ to: '2026-12-31' })).toBe(true);
  });
});

describe('renameTagInQuery', () => {
  it('renames without regard to case, keeps the set sorted, and merges a duplicate', () => {
    expect(renameTagInQuery({ tag: ['alpha', 'work'] }, 'Work', 'Zed')).toEqual({ tag: ['alpha', 'Zed'] });
    expect(renameTagInQuery({ tag: ['alpha', 'work'] }, 'work', 'Alpha')).toEqual({ tag: ['alpha'] });
  });

  it('drops a deleted tag, and the key with it when it was the last', () => {
    expect(renameTagInQuery({ tag: ['alpha'], sort: 'title' }, 'alpha', null)).toEqual({ sort: 'title' });
  });

  it('answers null for a view that does not name the tag', () => {
    expect(renameTagInQuery({ tag: ['alpha'] }, 'beta', 'gamma')).toBeNull();
    expect(renameTagInQuery({}, 'beta', 'gamma')).toBeNull();
  });
});

describe('dropFieldFromQuery', () => {
  it('takes out the filters on the field and a sort by it, and nothing else', () => {
    expect(
      dropFieldFromQuery({ field: [`${FIELD}:set`, `${OTHER}:empty`], sortField: FIELD, layout: 'table' }, FIELD),
    ).toEqual({ field: [`${OTHER}:empty`], layout: 'table' });
    expect(dropFieldFromQuery({ field: [`${FIELD}:set`] }, FIELD)).toEqual({});
  });

  it('answers null when the view does not use the field', () => {
    expect(dropFieldFromQuery({ field: [`${OTHER}:set`] }, FIELD)).toBeNull();
  });
});

describe('the request schemas', () => {
  it('refuse a query key this build does not know, so an old page cannot be handed one', () => {
    expect(viewQuerySchema.safeParse({ tag: ['a'], columns: ['x'] }).success).toBe(false);
    expect(viewQuerySchema.safeParse({ tag: ['a'], layout: 'table' }).success).toBe(true);
  });

  it('refuse an unreadable field filter and a blank name', () => {
    expect(viewQuerySchema.safeParse({ field: ['nonsense'] }).success).toBe(false);
    expect(createViewSchema.safeParse({ notebookId: FIELD, name: '  ', query: {} }).success).toBe(false);
    expect(createViewSchema.safeParse({ notebookId: FIELD, name: ' Business ', query: {} }).data?.name).toBe(
      'Business',
    );
  });

  it('refuse an edit that changes nothing', () => {
    expect(updateViewSchema.safeParse({}).success).toBe(false);
    expect(updateViewSchema.safeParse({ position: 0 }).success).toBe(true);
  });
});
