import { describe, it, expect } from 'vitest';
import { SORT_OPTIONS, sortKey, parseSortKey, sortLabel } from './sort-options.js';

/**
 * The sort key round trip.
 *
 * Two controls read this list now — the desktop `<select>`, whose value *is* the key, and
 * the phone's sort menu, which compares against it to mark the active option. What the
 * tests pin is the asymmetry between them: `sortKey` fills the default *in* so a control
 * always has a value to show, and `parseSortKey` takes it back *out* so the default never
 * reaches the URL. Getting either direction wrong is invisible until a link is shared.
 */
describe('sort options', () => {
  it('names every option distinctly, keyed by its own field and direction', () => {
    const keys = SORT_OPTIONS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(SORT_OPTIONS.map((o) => o.label)).size).toBe(SORT_OPTIONS.length);
    for (const o of SORT_OPTIONS) expect(o.key).toBe(`${o.sort}:${o.order}`);
  });

  it('fills in the default for a URL that omits it', () => {
    expect(sortKey(undefined, undefined)).toBe('updated:desc');
    expect(sortLabel(undefined, undefined)).toBe('Recently updated');
  });

  it('reads a key the select or menu produced', () => {
    expect(parseSortKey('created:asc')).toEqual({ sort: 'created', order: 'asc' });
    expect(sortLabel('created', 'asc')).toBe('Oldest first');
  });

  /*
   * The point of the whole module: picking the default removes the parameters rather than
   * spelling out what absence already means, so `/notes` stays the clean link.
   */
  it('drops each half of the default rather than writing it to the URL', () => {
    expect(parseSortKey('updated:desc')).toEqual({ sort: undefined, order: undefined });
    // Half a default is still dropped by half: the field is the default, the direction is not.
    expect(parseSortKey('updated:asc')).toEqual({ sort: undefined, order: 'asc' });
    expect(parseSortKey('title:desc')).toEqual({ sort: 'title', order: undefined });
  });

  it('round-trips every option the UI offers', () => {
    for (const o of SORT_OPTIONS) {
      const { sort, order } = parseSortKey(o.key);
      expect(sortKey(sort, order)).toBe(o.key);
    }
  });
});
