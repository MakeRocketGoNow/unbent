import { describe, it, expect, beforeEach } from 'vitest';
import {
  forgetSortField,
  hasRememberedSort,
  rememberSort,
  rememberedSort,
} from './notebook-sort.js';

const FIELD = '6f1c2b8e-4a7d-4c3e-9b1a-2d5e8f0a1b2c';
const DEFAULTS = { sort: undefined, order: undefined, sortField: undefined };

describe('notebook sort memory', () => {
  beforeEach(() => localStorage.clear());

  it('opens a place nothing was chosen for in the default order', () => {
    expect(rememberedSort('Recipes')).toEqual(DEFAULTS);
    expect(hasRememberedSort('Recipes')).toBe(false);
  });

  it('keeps each notebook to its own order', () => {
    rememberSort('Recipes', { sort: 'title', order: 'asc' });
    rememberSort('Coupons', { sort: 'created' });
    expect(rememberedSort('Recipes')).toEqual({ ...DEFAULTS, sort: 'title', order: 'asc' });
    expect(rememberedSort('Coupons')).toEqual({ ...DEFAULTS, sort: 'created' });
    expect(rememberedSort(undefined)).toEqual(DEFAULTS);
  });

  it('forgets a place when the default is chosen', () => {
    rememberSort('Recipes', { sort: 'title', order: 'asc' });
    rememberSort('Recipes', { sort: undefined, order: undefined, sortField: undefined });
    expect(hasRememberedSort('Recipes')).toBe(false);
    expect(localStorage.getItem('unbent.notebookSorts')).toBe('{}');
  });

  it('remembers a field sort inside a notebook but never offers one outside', () => {
    rememberSort('Coupons', { sortField: FIELD, order: 'asc' });
    expect(rememberedSort('Coupons')).toEqual({ ...DEFAULTS, sortField: FIELD, order: 'asc' });
    rememberSort(undefined, { sortField: FIELD });
    expect(rememberedSort(undefined)).toEqual(DEFAULTS);
  });

  it('drops the whole entry when its field goes, direction included', () => {
    rememberSort('Coupons', { sortField: FIELD, order: 'asc' });
    rememberSort('Recipes', { sort: 'title', order: 'asc' });
    forgetSortField('Coupons');
    forgetSortField('Recipes');
    expect(hasRememberedSort('Coupons')).toBe(false);
    expect(rememberedSort('Recipes').sort).toBe('title');
  });

  it('ignores what it could not have written', () => {
    localStorage.setItem(
      'unbent.notebookSorts',
      JSON.stringify({ Recipes: { sort: 'rank', order: 'sideways' }, Coupons: 'title' }),
    );
    expect(rememberedSort('Recipes')).toEqual(DEFAULTS);
    expect(rememberedSort('Coupons')).toEqual(DEFAULTS);
    localStorage.setItem('unbent.notebookSorts', '{not json');
    expect(rememberedSort('Recipes')).toEqual(DEFAULTS);
  });
});
