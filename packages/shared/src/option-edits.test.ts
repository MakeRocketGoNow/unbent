import { describe, expect, it } from 'vitest';
import { applyOptionEdit, isEmptyOptionEdit, optionEditSchema } from './option-edits.js';
import { MAX_SELECT_OPTIONS } from './fields.js';

const options = (result: ReturnType<typeof applyOptionEdit>) => {
  if ('error' in result) throw new Error(result.error);
  return result.options;
};

describe('applyOptionEdit', () => {
  const list = ['Travel', 'other', 'Dining', 'Item 10', 'Item 2', 'éclair'];

  it('sorts without case or accents mattering, numbers by value', () => {
    expect(options(applyOptionEdit(list, { sort: 'alpha' }))).toEqual([
      'Dining',
      'éclair',
      'Item 2',
      'Item 10',
      'other',
      'Travel',
    ]);
  });

  it('sorts with a pin last and a pin first, in one edit', () => {
    expect(options(applyOptionEdit(list, { sort: 'alpha', pinLast: ['other'], pinFirst: ['Travel'] }))).toEqual([
      'Travel',
      'Dining',
      'éclair',
      'Item 2',
      'Item 10',
      'other',
    ]);
  });

  it('pins without sorting, keeping the rest in their order', () => {
    expect(options(applyOptionEdit(['A', 'B', 'C'], { pinLast: ['A'] }))).toEqual(['B', 'C', 'A']);
  });

  it('adds at the end by default, and skips one already there', () => {
    const result = applyOptionEdit(['A', 'B'], { add: ['C', 'A'] });
    expect(result).toMatchObject({ options: ['A', 'B', 'C'], added: ['C'] });
  });

  it('adds at the start, after a named option, or in alphabetical place', () => {
    expect(options(applyOptionEdit(['B', 'D'], { add: ['A'], position: 'start' }))).toEqual(['A', 'B', 'D']);
    expect(options(applyOptionEdit(['B', 'D'], { add: ['X', 'Y'], position: { after: 'B' } }))).toEqual([
      'B',
      'X',
      'Y',
      'D',
    ]);
    expect(options(applyOptionEdit(['Bank', 'Fuel', 'Other'], { add: ['car', 'Zoo'], position: 'alpha' }))).toEqual([
      'Bank',
      'car',
      'Fuel',
      'Other',
      'Zoo',
    ]);
  });

  it('renames in place, and merges onto an option that already stands only when asked', () => {
    expect(applyOptionEdit(['A', 'B', 'C'], { rename: [{ from: 'B', to: 'Bee' }] })).toMatchObject({
      options: ['A', 'Bee', 'C'],
      renamed: [{ from: 'B', to: 'Bee' }],
    });
    expect(applyOptionEdit(['Grocery', 'Groceries'], { rename: [{ from: 'Grocery', to: 'Groceries' }] })).toMatchObject({
      error: expect.stringContaining('merge'),
      merge: true,
    });
    expect(applyOptionEdit(['A', 'B'], { rename: [{ from: 'A', to: 'Z' }, { from: 'B', to: 'Z' }] })).toMatchObject({
      error: expect.stringContaining('more than one rename'),
    });
    expect(applyOptionEdit(['Grocery', 'Fuel', 'Groceries'], { rename: [{ from: 'Grocery', to: 'Groceries' }], merge: true })).toMatchObject({
      options: ['Fuel', 'Groceries'],
      renamed: [{ from: 'Grocery', to: 'Groceries' }],
    });
  });

  it('treats a rename to the same name as nothing', () => {
    expect(applyOptionEdit(['A'], { rename: [{ from: 'A', to: 'A' }] })).toMatchObject({ options: ['A'], renamed: [] });
  });

  it('applies renames, then removals, then additions, then order', () => {
    const result = applyOptionEdit(['Misc', 'B', 'A', 'Old'], {
      rename: [{ from: 'Misc', to: 'Other' }],
      remove: ['Old'],
      add: ['C'],
      sort: 'alpha',
      pinLast: ['Other'],
    });
    expect(result).toEqual({
      options: ['A', 'B', 'C', 'Other'],
      renamed: [{ from: 'Misc', to: 'Other' }],
      removed: ['Old'],
      added: ['C'],
    });
  });

  it('refuses a name the list does not have, wherever it is named', () => {
    for (const edit of [
      { rename: [{ from: 'Nope', to: 'X' }] },
      { remove: ['Nope'] },
      { add: ['X'], position: { after: 'Nope' } },
      { pinLast: ['Nope'] },
      // Case matters, as it does for a value.
      { remove: ['a'] },
    ]) {
      expect(applyOptionEdit(['A'], edit)).toMatchObject({ error: expect.stringContaining('not one of') });
    }
  });

  it('refuses chains, swaps, and an option both renamed and removed either way round', () => {
    expect(applyOptionEdit(['A', 'B'], { rename: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }], merge: true })).toHaveProperty('error');
    expect(applyOptionEdit(['A', 'B'], { rename: [{ from: 'A', to: 'X' }, { from: 'X', to: 'Y' }] })).toHaveProperty('error');
    expect(applyOptionEdit(['A', 'B'], { rename: [{ from: 'A', to: 'X' }], remove: ['A'] })).toHaveProperty('error');
    expect(applyOptionEdit(['A', 'B'], { rename: [{ from: 'A', to: 'X' }], remove: ['X'] })).toHaveProperty('error');
    expect(applyOptionEdit(['A', 'B'], { rename: [{ from: 'A', to: 'B' }], merge: true, remove: ['B'] })).toHaveProperty('error');
    expect(applyOptionEdit(['A', 'B'], { pinFirst: ['A'], pinLast: ['A'] })).toHaveProperty('error');
  });

  it('refuses a position with nothing to add, or after an option the list lacks', () => {
    expect(applyOptionEdit(['A'], { position: 'alpha' })).toMatchObject({ error: expect.stringContaining('needs options') });
    // Every option already there, so nothing is added; the misspelt anchor is still refused.
    expect(applyOptionEdit(['A'], { add: ['A'], position: { after: 'Nope' } })).toMatchObject({ error: expect.stringContaining('"Nope"') });
  });

  it('refuses growing past the limit', () => {
    const full = Array.from({ length: MAX_SELECT_OPTIONS }, (_, i) => `O${i}`);
    expect(applyOptionEdit(full, { add: ['One more'] })).toMatchObject({ error: expect.stringContaining('at most') });
  });

  it('leaves the list it was given alone', () => {
    const before = ['B', 'A'];
    applyOptionEdit(before, { sort: 'alpha', add: ['C'] });
    expect(before).toEqual(['B', 'A']);
  });
});

describe('optionEditSchema', () => {
  it('trims names, and an empty edit says so', () => {
    const edit = optionEditSchema.parse({ add: ['  Fuel '] });
    expect(edit.add).toEqual(['Fuel']);
    expect(isEmptyOptionEdit(edit)).toBe(false);
    expect(isEmptyOptionEdit(optionEditSchema.parse({ add: [] }))).toBe(true);
    expect(isEmptyOptionEdit(optionEditSchema.parse({ position: 'alpha' }))).toBe(false);
  });
});
