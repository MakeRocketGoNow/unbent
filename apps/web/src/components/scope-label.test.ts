import { describe, it, expect } from 'vitest';
import { UNFILED } from '@unbent/shared';
import { scopeLabel, tagPlace } from './scope-label.js';

/**
 * The heading and the navigation must name the same place. What these pin is the one
 * case that is easy to get wrong: a single tag with no notebook is a place, and it is the
 * heading; a notebook outranks it, and two tags are not a place at all.
 */
describe('scopeLabel', () => {
  it('names the notebook, the inbox, or all notes', () => {
    expect(scopeLabel('Coupons', [])).toBe('Coupons');
    expect(scopeLabel(UNFILED, [])).toBe('Inbox');
    expect(scopeLabel(undefined, [])).toBe('All notes');
  });

  it('names a lone tag with no notebook, and nothing else about tags', () => {
    expect(scopeLabel(undefined, ['Receipt'])).toBe('Receipt');
    expect(scopeLabel('Coupons', ['Receipt'])).toBe('Coupons');
    expect(scopeLabel(undefined, ['Receipt', 'Travel'])).toBe('All notes');
  });

  it('says which tag is the place, or that none is', () => {
    expect(tagPlace(undefined, ['Receipt'])).toBe('Receipt');
    expect(tagPlace('Coupons', ['Receipt'])).toBeUndefined();
    expect(tagPlace(undefined, [])).toBeUndefined();
    expect(tagPlace(undefined, ['a', 'b'])).toBeUndefined();
  });
});
