import { describe, it, expect, vi } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { UNFILED, type Note, type NoteSummary } from '@unbent/shared';
import type { NotePage } from './notes-api.js';
import { applySaveToLists, listAfterSave } from './list-cache.js';

const row = (id: string, updatedAt: number, extra: Partial<NoteSummary> = {}): NoteSummary => ({
  id,
  title: `Note ${id}`,
  createdAt: 1,
  updatedAt,
  tags: [],
  notebook: 'Travel',
  notebookId: 'nb',
  excerpt: '',
  ...extra,
});

const pages = (...lists: Array<{ items: NoteSummary[]; cursor: string | null }>): InfiniteData<NotePage> => ({
  pages: lists.map((l, i) => ({ ...l, total: i === 0 ? 99 : null })),
  pageParams: lists.map((_, i) => (i === 0 ? '' : `c${i}`)),
});

const saved = (id: string, updatedAt: number, extra: Partial<Note> = {}): Note => ({
  id,
  title: `Note ${id}`,
  body: 'Hello **there**',
  createdAt: 1,
  updatedAt,
  tags: [],
  notebook: 'Travel',
  notebookId: 'nb',
  ...extra,
});

const ids = (d: InfiniteData<NotePage> | 'refetch') =>
  d === 'refetch' ? d : d.pages.map((p) => p.items.map((n) => n.id));

describe('listAfterSave', () => {
  const data = pages(
    { items: [row('a', 30), row('b', 20)], cursor: 'c1' },
    { items: [row('c', 10, { attachments: [{ filename: 'x.pdf', contentType: 'application/pdf' }] })], cursor: 'c2' },
  );

  it('moves a body save to the top of a newest-first list, rebuilding the row', () => {
    const next = listAfterSave(data, {}, { sort: 'updated' }, saved('c', 40), {});
    expect(ids(next)).toEqual([['c', 'a', 'b'], []]);
    const top = (next as InfiniteData<NotePage>).pages[0]!.items[0]!;
    expect(top.updatedAt).toBe(40);
    expect(top.excerpt).toBe('Hello there');
    // A save cannot change the files, and the PATCH does not return them.
    expect(top.attachments).toEqual([{ filename: 'x.pdf', contentType: 'application/pdf' }]);
  });

  it('leaves a saved row where it was under the default creation order', () => {
    expect(ids(listAfterSave(data, {}, {}, saved('b', 40), {}))).toEqual([['a', 'b'], ['c']]);
  });

  it('keeps the count and cursors it was given', () => {
    const next = listAfterSave(data, {}, { sort: 'updated' }, saved('c', 40), {}) as InfiniteData<NotePage>;
    expect(next.pages.map((p) => p.cursor)).toEqual(['c1', 'c2']);
    expect(next.pages[0]!.total).toBe(99);
  });

  it('drops a row whose save sends it past the pages an oldest-first list has loaded', () => {
    expect(ids(listAfterSave(data, {}, { sort: 'updated', order: 'asc' }, saved('a', 40), {}))).toEqual([['b'], ['c']]);
  });

  it('appends it once the oldest-first list has reached its end', () => {
    const done = pages({ items: [row('a', 10), row('b', 20)], cursor: null });
    expect(ids(listAfterSave(done, {}, { sort: 'updated', order: 'asc' }, saved('a', 40), {}))).toEqual([['b', 'a']]);
  });

  it('patches in place where the sort does not read the updated date', () => {
    const next = listAfterSave(data, {}, { sort: 'created' }, saved('b', 40, { title: 'Renamed' }), { title: true });
    expect(ids(next)).toEqual([['a', 'b'], ['c']]);
    expect((next as InfiniteData<NotePage>).pages[0]!.items[1]!.title).toBe('Renamed');
  });

  it('drops fields the save cleared rather than keeping the listed ones', () => {
    const withField = pages({
      items: [row('a', 30, { fields: [{ fieldId: 'f', name: 'F', type: 'text', value: 'v', notebookId: 'nb', notebook: 'Travel' }] })],
      cursor: null,
    });
    const next = listAfterSave(withField, {}, { sort: 'created' }, saved('a', 31), { fields: true });
    expect((next as InfiniteData<NotePage>).pages[0]!.items[0]!.fields).toBeUndefined();
  });

  it('brings a note it had not loaded to the top when it belongs to the list', () => {
    expect(ids(listAfterSave(data, { notebook: 'travel' }, { sort: 'updated' }, saved('z', 50), {}))).toEqual([['z', 'a', 'b'], ['c']]);
  });

  it('leaves a list alone for a note that does not belong to it', () => {
    expect(listAfterSave(data, { notebook: 'Recipes' }, { sort: 'updated' }, saved('z', 50), {})).toBe(data);
    expect(listAfterSave(data, { notebook: UNFILED }, { sort: 'updated' }, saved('z', 50), {})).toBe(data);
    expect(listAfterSave(data, { tag: ['ski'] }, { sort: 'updated' }, saved('z', 50, { tags: ['beach'] }), {})).toBe(data);
  });

  it('refetches when the save changed what the list filters on', () => {
    expect(listAfterSave(data, { notebook: 'Travel' }, { sort: 'updated' }, saved('a', 40), { notebook: true })).toBe('refetch');
    expect(listAfterSave(data, { tag: ['ski'] }, { sort: 'updated' }, saved('a', 40), { tags: true })).toBe('refetch');
    expect(listAfterSave(data, { field: ['f:set'] }, { sort: 'updated' }, saved('a', 40), { fields: true })).toBe('refetch');
    expect(listAfterSave(data, { from: '2020-01-01' }, { sort: 'updated' }, saved('a', 40), {})).toBe('refetch');
  });

  it('refetches when the save changed what the list sorts by', () => {
    expect(listAfterSave(data, {}, { sort: 'title' }, saved('a', 40), { title: true })).toBe('refetch');
    expect(listAfterSave(data, {}, { sortField: 'f' }, saved('a', 40), { fields: true })).toBe('refetch');
  });

  it('does not refetch an unfiltered list for a change of filing', () => {
    expect(ids(listAfterSave(data, {}, { sort: 'updated' }, saved('b', 40), { notebook: true, tags: true }))).toEqual([['b', 'a'], ['c']]);
  });

  it('refetches a field-filtered list for a note it has not loaded, since it cannot tell', () => {
    expect(listAfterSave(data, { field: ['f:set'] }, { sort: 'updated' }, saved('z', 50), {})).toBe('refetch');
  });
});

describe('applySaveToLists', () => {
  it('patches each cached list, refetches only the ones it must, and leaves counts alone for a body save', () => {
    const qc = new QueryClient();
    const all = pages({ items: [row('a', 30), row('b', 20)], cursor: null });
    qc.setQueryData(['notes', {}, { sort: 'updated' }], all);
    qc.setQueryData(['notes', {}, { sort: 'title' }], all);
    qc.setQueryData(['notes', 'exact-count', {}], 12);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');

    applySaveToLists(qc, saved('b', 40, { title: 'Zed' }), { title: true });

    expect(ids(qc.getQueryData<InfiniteData<NotePage>>(['notes', {}, { sort: 'updated' }])!)).toEqual([['b', 'a']]);
    expect(invalidate.mock.calls.map((c) => c[0]?.queryKey)).toEqual([['notes', {}, { sort: 'title' }]]);
  });

  it('invalidates the exact counts when the filing changed', () => {
    const qc = new QueryClient();
    qc.setQueryData(['notes', 'exact-count', { notebook: 'Travel' }], 12);
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    applySaveToLists(qc, saved('b', 40), { notebook: true });
    expect(invalidate.mock.calls.map((c) => c[0]?.queryKey)).toEqual([['notes', 'exact-count', { notebook: 'Travel' }]]);
  });
});
