import { describe, expect, it } from 'vitest';
import { LIBRARY_ROOTS, rootsOfNoteChanges } from './library-roots.js';

/**
 * Which queries a change to the notes collection reaches. A save that changed only the
 * text re-runs the list and the note; anything that moves a note between lists or counts
 * (filing, tagging, trashing, a field, a row arriving or going) re-runs everything.
 */
const row = { id: 'n1', title: 'a', body: 'b', updatedAt: 1, deletedAt: undefined, notebookId: 'nb', tagIds: ['t1', 't2'], fields: [{ fieldId: 'f', value: 1 }] };

describe('rootsOfNoteChanges', () => {
  it('reaches only the list and the note for a change of text', () => {
    const roots = rootsOfNoteChanges([{ type: 'update', previousValue: row, value: { ...row, title: 'b', body: 'c', updatedAt: 2 } }]);
    expect([...roots].sort()).toEqual(['note', 'notes']);
  });

  it('reaches the trash too when the note is in it', () => {
    const trashed = { ...row, deletedAt: 5 };
    const roots = rootsOfNoteChanges([{ type: 'update', previousValue: trashed, value: { ...trashed, title: 'b' } }]);
    expect([...roots].sort()).toEqual(['note', 'notes', 'trash']);
  });

  it.each([
    ['filing', { notebookId: 'other' }],
    ['a notebook named by a write made here', { notebookName: 'New' }],
    ['tagging', { tagIds: ['t1'] }],
    ['tags named by a write made here', { tagNames: ['x'] }],
    ['trashing', { deletedAt: 9 }],
    ['a field', { fields: [{ fieldId: 'f', value: 2 }] }],
  ])('reaches everything for %s', (_what, change) => {
    expect(rootsOfNoteChanges([{ type: 'update', previousValue: row, value: { ...row, ...change } }])).toBe(LIBRARY_ROOTS);
  });

  it('reaches everything for a row arriving or going, or a change it cannot read', () => {
    expect(rootsOfNoteChanges([{ type: 'insert', value: row }])).toBe(LIBRARY_ROOTS);
    expect(rootsOfNoteChanges([{ type: 'delete' }])).toBe(LIBRARY_ROOTS);
    expect(rootsOfNoteChanges([{ type: 'update', value: row }])).toBe(LIBRARY_ROOTS);
  });

  it('is the union over a batch', () => {
    const roots = rootsOfNoteChanges([
      { type: 'update', previousValue: row, value: { ...row, title: 'x' } },
      { type: 'update', previousValue: row, value: { ...row, tagIds: [] } },
    ]);
    expect(roots).toBe(LIBRARY_ROOTS);
  });
});
