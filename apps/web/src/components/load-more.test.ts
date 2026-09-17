import { describe, it, expect } from 'vitest';
import { loadMoreLabel } from './load-more.js';

describe('loadMoreLabel', () => {
  it('says how much of the list is loaded, where the loading happens', () => {
    expect(loadMoreLabel(50, 900, false)).toBe('Load more · 50 of 900');
  });

  it('stands alone without a total worth stating', () => {
    expect(loadMoreLabel(50, null, false)).toBe('Load more');
    expect(loadMoreLabel(50, 50, false)).toBe('Load more');
  });

  it('says it is loading while the next page is on its way', () => {
    expect(loadMoreLabel(50, 900, true)).toBe('Loading…');
  });
});
