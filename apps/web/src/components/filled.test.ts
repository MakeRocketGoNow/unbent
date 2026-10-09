import { describe, expect, it } from 'vitest';
import type { FieldDef } from '@unbent/shared';
import { filledMarks, filledStyle } from './filled.js';

const def = (id: string) => ({ id }) as FieldDef;

describe('filledMarks', () => {
  it('runs the title, the notebook, each tag added, then the fields, as one sequence', () => {
    const marks = filledMarks({
      title: 'Acme',
      notebook: 'Receipts',
      tags: ['home', 'tools'],
      fields: [
        { def: def('f1'), value: 1 },
        { def: def('f2'), value: 'x' },
      ],
    });
    expect(marks.title).toBe(0);
    expect(marks.notebook).toBe(1);
    expect(marks.tags).toEqual({ at: 2, names: ['home', 'tools'] });
    expect(marks.fieldsAt).toBe(4);
    expect([...marks.fields]).toEqual(['f1', 'f2']);
    expect(marks.count).toBe(6);
  });

  it('starts at whatever the press wrote first', () => {
    const marks = filledMarks({ tags: [], fields: [{ def: def('f1'), value: 1 }] });
    expect(marks.title).toBeUndefined();
    expect(marks.notebook).toBeUndefined();
    expect(marks.tags).toBeUndefined();
    expect(marks.fieldsAt).toBe(0);
    expect(marks.count).toBe(1);
  });
});

describe('filledStyle', () => {
  it('sets the place for the stylesheet, and nothing for what the press did not write', () => {
    expect(filledStyle(3)).toEqual({ '--filled-i': 3 });
    expect(filledStyle(undefined)).toBeUndefined();
  });
});
