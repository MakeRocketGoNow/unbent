import { describe, expect, it } from 'vitest';
import type { FeedAttachment, FeedNote, FeedNotebook, FeedTag } from '@unbent/shared';
import { count, list, lookups, notebookFields, notebookList, tagSummaries, toNote, type Snapshot } from './derive.js';

const nb = (id: string, name: string, fieldDefs: FeedNotebook['fieldDefs'] = []): FeedNotebook => ({ id, name, purpose: null, emoji: null, fieldDefs });
const tag = (id: string, name: string): FeedTag => ({ id, name });
const note = (id: string, over: Partial<FeedNote> = {}): FeedNote => ({ id, title: id, body: '', createdAt: 1, updatedAt: 1, tagIds: [], notebookId: null, files: [], ...over });
const file = (id: string, noteId: string, createdAt = 1): FeedAttachment => ({ id, noteId, filename: `${id}.pdf`, contentType: 'application/pdf', size: 1, hasText: false, createdAt });

const amount = { id: 'amount', notebookId: 'nb1', name: 'Amount', type: 'number' as const, options: [], scale: null, currency: null, position: 0 };
const kind = { id: 'kind', notebookId: 'nb1', name: 'Kind', type: 'multiselect' as const, options: ['a', 'b'], scale: null, currency: null, position: 1 };

const s: Snapshot = {
  notebooks: [nb('nb1', 'receipts', [amount, kind]), nb('nb2', 'Taxes')],
  tags: [tag('t1', 'home'), tag('t2', 'acme'), tag('t3', 'unused')],
  attachments: [file('f2', 'a', 2), file('f1', 'a', 1), file('f3', 'c')],
  notes: [
    note('a', { title: 'beta', body: 'Hello **world**', createdAt: 10, updatedAt: 50, tagIds: ['t1', 't2'], notebookId: 'nb1', fields: [{ fieldId: 'amount', name: 'Old name', type: 'number', value: 12, notebookId: 'nb1', notebook: 'old' }] }),
    note('b', { title: 'Alpha', createdAt: 20, updatedAt: 40, tagIds: ['t1'], notebookId: 'nb1', fields: [{ fieldId: 'amount', name: 'Amount', type: 'number', value: 3, notebookId: 'nb1', notebook: 'receipts' }, { fieldId: 'kind', name: 'Kind', type: 'multiselect', value: ['a'], notebookId: 'nb1', notebook: 'receipts' }] }),
    note('c', { title: 'gamma', createdAt: 30, updatedAt: 30, notebookId: 'nb2' }),
    note('d', { title: 'delta', createdAt: 5, updatedAt: 60, tagIds: ['t1'], deletedAt: 100 }),
    note('e', { title: 'epsilon', createdAt: 40, updatedAt: 45 }),
  ],
};

describe('derive', () => {
  it('builds the whole note as GET /notes/:id would, naming tags, notebook and fields from what it holds', () => {
    const n = toNote([...s.notes][0]!, lookups(s));
    expect(n).toMatchObject({ id: 'a', tags: ['acme', 'home'], notebook: 'receipts', notebookId: 'nb1', body: 'Hello **world**' });
    expect(n.fields).toEqual([expect.objectContaining({ fieldId: 'amount', name: 'Amount', value: 12, notebook: 'receipts' })]);
    expect(n).not.toHaveProperty('tagIds');
    expect(n).not.toHaveProperty('files');
  });

  it('lists live notes by created desc by default, with excerpt, names and files', () => {
    const rows = list(s, {}, {});
    expect(rows.map((r) => r.id)).toEqual(['e', 'c', 'b', 'a']);
    expect(rows[3]).toMatchObject({ excerpt: 'Hello world', tags: ['acme', 'home'], notebook: 'receipts', attachments: [{ filename: 'f1.pdf', contentType: 'application/pdf' }, { filename: 'f2.pdf', contentType: 'application/pdf' }] });
    expect(rows[3]).not.toHaveProperty('body');
    expect(rows[0]).not.toHaveProperty('attachments');
  });

  it('sorts by title case-insensitively, by updated, and ascending when asked', () => {
    expect(list(s, {}, { sort: 'title', order: 'asc' }).map((r) => r.id)).toEqual(['b', 'a', 'e', 'c']);
    expect(list(s, {}, { sort: 'updated' }).map((r) => r.id)).toEqual(['a', 'e', 'b', 'c']);
    expect(list(s, {}, { order: 'asc' }).map((r) => r.id)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('sorts by a field with the valueless last whichever way', () => {
    expect(list(s, {}, { sortField: 'amount', order: 'asc' }).map((r) => r.id)).toEqual(['b', 'a', 'c', 'e']);
    expect(list(s, {}, { sortField: 'amount', order: 'desc' }).map((r) => r.id)).toEqual(['a', 'b', 'e', 'c']);
  });

  it('filters by notebook (case-insensitively, and unfiled), by tags ANDed, by field, and by date on the sort\'s date', () => {
    expect(list(s, { notebook: 'RECEIPTS' }, {}).map((r) => r.id)).toEqual(['b', 'a']);
    expect(list(s, { notebook: '[unfiled]' }, {}).map((r) => r.id)).toEqual(['e']);
    expect(list(s, { tag: ['home', 'acme'] }, {}).map((r) => r.id)).toEqual(['a']);
    expect(list(s, { tag: ['home'] }, {}).map((r) => r.id)).toEqual(['b', 'a']);
    expect(list(s, { field: ['amount:gte:10'] }, {}).map((r) => r.id)).toEqual(['a']);
    expect(list(s, { field: ['amount:lte:10'] }, {}).map((r) => r.id)).toEqual(['b']);
    expect(list(s, { field: ['kind:eq:a'] }, {}).map((r) => r.id)).toEqual(['b']);
    expect(list(s, { field: ['amount:set'] }, {}).map((r) => r.id)).toEqual(['b', 'a']);
    expect(list(s, { field: ['amount:empty'] }, {}).map((r) => r.id)).toEqual(['e', 'c']);
    // created is the default sort's date; under the title sort the range reads updated.
    expect(list(s, { from: '1970-01-01', to: '1970-01-01' }, {}).map((r) => r.id)).toEqual(['e', 'c', 'b', 'a']);
    expect(list(s, { to: '1969-12-31' }, {}).map((r) => r.id)).toEqual([]);
  });

  it('lists the trash by deletion, newest first, and counts exactly', () => {
    expect(list(s, { trashed: true }, {}).map((r) => r.id)).toEqual(['d']);
    expect(list(s, { trashed: true }, {})[0]).toMatchObject({ deletedAt: 100 });
    expect(count(s, {})).toBe(4);
    expect(count(s, { trashed: true })).toBe(1);
    expect(count(s, { notebook: 'receipts' })).toBe(2);
  });

  it('derives tag and notebook counts from live notes, in the server\'s orders', () => {
    expect(tagSummaries(s)).toEqual([
      { id: 't1', name: 'home', count: 2 },
      { id: 't2', name: 'acme', count: 1 },
    ]);
    expect(notebookList(s)).toEqual({
      notebooks: [
        { id: 'nb1', name: 'receipts', purpose: null, emoji: null, count: 2, fields: 2 },
        { id: 'nb2', name: 'Taxes', purpose: null, emoji: null, count: 1, fields: 0 },
      ],
      unfiled: 1,
    });
    expect(notebookFields(s, 'nb1', false)).toEqual([amount, kind]);
    expect(notebookFields(s, 'nb1', true)).toEqual([{ ...amount, valueCount: 2 }, { ...kind, valueCount: 1 }]);
    expect(notebookFields(s, 'nope', false)).toBeNull();
  });
});
