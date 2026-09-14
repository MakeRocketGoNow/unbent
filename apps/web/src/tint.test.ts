import { describe, it, expect } from 'vitest';
import { tintIndex, TINT_COUNT } from './tint.js';

describe('tintIndex', () => {
  it('is stable, in range, and blind to case and edge spaces', () => {
    for (const name of ['Spicy', 'mtb', 'packing', 'Red', '']) {
      const t = tintIndex(name);
      expect(t).toBe(tintIndex(name));
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(TINT_COUNT);
    }
    expect(tintIndex('MTB')).toBe(tintIndex(' mtb '));
  });

  it('spreads a handful of names over more than one tint', () => {
    const seen = new Set(['Mexican', 'Spicy', 'Quick', 'Red', 'Yellow', 'Blue', 'travel', 'packing'].map(tintIndex));
    expect(seen.size).toBeGreaterThan(2);
  });
});
