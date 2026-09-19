import { describe, it, expect } from 'vitest';
import type { FieldDef, NoteSummary } from '@unbent/shared';
import { patchNoteFields, patchNotePages } from './note-table-edit.js';

const cost: FieldDef = { id: 'f-cost', notebookId: 'nb', name: 'Cost', type: 'number', options: [], scale: null, currency: null, position: 0 };
const packed: FieldDef = { id: 'f-packed', notebookId: 'nb', name: 'Packed', type: 'checkbox', options: [], scale: null, currency: null, position: 1 };

const base: NoteSummary = {
  id: 'n1',
  title: 'Ski trip',
  createdAt: 1,
  updatedAt: 2,
  tags: [],
  notebook: 'Travel',
  notebookId: 'nb',
  fields: [
    { fieldId: 'f-cost', name: 'Cost', type: 'number', value: 2100, notebookId: 'nb', notebook: 'Travel' },
    { fieldId: 'other', name: 'Old', type: 'text', value: 'x', notebookId: 'nb2', notebook: 'Gone' },
  ],
};

describe('patchNoteFields', () => {
  it('replaces a held value in place', () => {
    const next = patchNoteFields(base, cost, 'Travel', 900);
    expect(next.fields?.map((f) => [f.fieldId, f.value])).toEqual([['f-cost', 900], ['other', 'x']]);
  });

  it('adds a value the note did not hold, shaped like a listed one', () => {
    const next = patchNoteFields(base, packed, 'Travel', true);
    expect(next.fields?.at(-1)).toEqual({
      fieldId: 'f-packed',
      name: 'Packed',
      type: 'checkbox',
      value: true,
      notebookId: 'nb',
      notebook: 'Travel',
    });
  });

  it('clears a value, leaving the others — foreign ones included — alone', () => {
    const next = patchNoteFields(base, cost, 'Travel', null);
    expect(next.fields?.map((f) => f.fieldId)).toEqual(['other']);
  });

  it('drops the key when the last value goes, as the API omits it', () => {
    const only: NoteSummary = { ...base, fields: [base.fields![0]!] };
    expect('fields' in patchNoteFields(only, cost, 'Travel', null)).toBe(false);
  });
});

describe('patchNotePages', () => {
  it('touches only the named note, on whichever page it is', () => {
    const data = {
      pageParams: ['', 'c1'],
      pages: [
        { items: [{ ...base, id: 'a' }], cursor: 'c1', total: 2 },
        { items: [{ ...base, id: 'b' }], cursor: null, total: null },
      ],
    };
    const next = patchNotePages(data, 'b', (n) => ({ ...n, title: 'edited' }));
    expect(next?.pages[0]?.items[0]?.title).toBe('Ski trip');
    expect(next?.pages[1]?.items[0]?.title).toBe('edited');
    expect(patchNotePages(undefined, 'b', (n) => n)).toBeUndefined();
  });
});
