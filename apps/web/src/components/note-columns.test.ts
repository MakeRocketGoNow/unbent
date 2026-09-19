import { describe, it, expect } from 'vitest';
import type { FieldDef } from '@unbent/shared';
import { noteColumns } from './note-columns.js';

const def = (id: string, name: string, type: FieldDef['type'], position: number): FieldDef => ({
  id,
  notebookId: 'nb',
  name,
  type,
  options: [],
  scale: null,
  currency: null,
  position,
});

describe('noteColumns', () => {
  it('puts the name first, the fields in notebook order, then tags and the dates', () => {
    const cols = noteColumns([def('b', 'Status', 'select', 1), def('a', 'Cost', 'number', 0)]);
    expect(cols.map((c) => c.label)).toEqual(['Name', 'Cost', 'Status', 'Tags', 'Updated', 'Created']);
    expect(cols[1]?.def?.id).toBe('a');
  });

  it('sorts by the field for a field column, and by the named sort otherwise', () => {
    const cols = noteColumns([def('a', 'Cost', 'number', 0)]);
    expect(cols[0]?.sortTarget).toEqual({ kind: 'note', sort: 'title' });
    expect(cols[1]?.sortTarget).toEqual({ kind: 'field', fieldId: 'a' });
    expect(cols.find((c) => c.kind === 'tags')?.sortTarget).toBeUndefined();
  });

  it('aligns numbers to the end and checkboxes to the centre', () => {
    const cols = noteColumns([
      def('n', 'Cost', 'number', 0),
      def('c', 'Packed', 'checkbox', 1),
      def('t', 'Where', 'text', 2),
    ]);
    expect(cols.slice(1, 4).map((c) => c.align)).toEqual(['end', 'center', 'start']);
  });
});
