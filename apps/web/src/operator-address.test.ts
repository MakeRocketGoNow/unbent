import { describe, expect, it } from 'vitest';
import { withDismissedShown, withOrder } from './operator-address.js';

describe('the operator page address', () => {
  it('keeps Show dismissed and the search through a sort, and clears an order the new one leaves out', () => {
    const prev = { q: 'acme', feedback: 'all' as const, sort: 'notes' as const, dir: 'asc' as const };
    expect(withOrder(prev, { sort: 'size' })).toEqual({ q: 'acme', feedback: 'all', sort: 'size', dir: undefined });
    expect(withOrder(prev, {})).toEqual({ q: 'acme', feedback: 'all', sort: undefined, dir: undefined });
  });

  it('turns Show dismissed on and off and keeps everything else', () => {
    const prev = { q: 'acme', sort: 'size' as const };
    expect(withDismissedShown(prev, true)).toEqual({ q: 'acme', sort: 'size', feedback: 'all' });
    expect(withDismissedShown({ ...prev, feedback: 'all' as const }, false)).toEqual({ q: 'acme', sort: 'size', feedback: undefined });
  });
});
