import { describe, expect, it } from 'vitest';
import type { NoteSummary } from '@unbent/shared';
import { tableTotalsFor } from './table-totals.js';

/** Which rows the table's footer sums, and what it calls them. */
const row = (id: string, cost: number): NoteSummary => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  tags: [],
  notebook: 'Travel',
  notebookId: 'nb',
  fields: [{ fieldId: 'cost', name: 'Cost', type: 'number', value: cost, notebookId: 'nb', notebook: 'Travel' }],
});

const base = {
  ids: new Set(['cost']),
  searchRows: null,
  whole: undefined,
  libraryWhole: true,
  loaded: [row('a', 1), row('b', 2)],
  hasNextPage: false,
};

describe('tableTotalsFor', () => {
  it('totals the library\'s sums over the whole list, not the loaded rows', () => {
    const t = tableTotalsFor({ ...base, whole: { cost: 900 }, hasNextPage: true });
    expect(t).toEqual({ label: 'Total', sums: new Map([['cost', 900]]) });
  });

  it('draws nothing while the library\'s copy is still arriving, or its sums are loading', () => {
    expect(tableTotalsFor({ ...base, whole: { cost: 900 }, libraryWhole: false })).toBeUndefined();
    expect(tableTotalsFor({ ...base, whole: undefined })).toBeUndefined();
  });

  it('with no library, totals the loaded rows only once they are all of them', () => {
    expect(tableTotalsFor({ ...base, whole: null, hasNextPage: true })).toBeUndefined();
    expect(tableTotalsFor({ ...base, whole: null })).toEqual({ label: 'Total', sums: new Map([['cost', 3]]) });
  });

  it('totals a search\'s matches, and says so when the search hit its cap', () => {
    const few = tableTotalsFor({ ...base, searchRows: [row('a', 5)], whole: { cost: 900 } });
    expect(few).toEqual({ label: 'Total', sums: new Map([['cost', 5]]) });
    const capped = Array.from({ length: 50 }, (_, i) => row(`n${i}`, 1));
    expect(tableTotalsFor({ ...base, searchRows: capped })).toEqual({ label: 'Total of top 50', sums: new Map([['cost', 50]]) });
  });

  it('draws nothing with no column to total', () => {
    expect(tableTotalsFor({ ...base, ids: new Set(), whole: { cost: 900 } })).toBeUndefined();
  });
});
