import { describe, expect, it } from 'vitest';
import { filters } from './notes.js';
import { exportUrl } from '../notes-api.js';

/**
 * The tag filter reads one tag or several, and writes them as repeated params.
 *
 * Worth pinning at this level because the filter lives in the URL: a link someone
 * bookmarked or pasted into a chat carries `?tag=x`, and widening the schema to an array
 * must not turn those into dropped filters. `catch(undefined)` means a schema that no
 * longer matches fails silently rather than loudly — the bad filter is simply gone — so a
 * regression here would look like "the link stopped working" with nothing to debug.
 */
describe('the notes route tag filter', () => {
  const parse = (search: Record<string, unknown>) => filters.parse(search);

  it('reads a single tag as a one-element list, so old links keep working', () => {
    expect(parse({ tag: 'Receipt' }).tag).toEqual(['Receipt']);
  });

  it('reads repeated tags as a list', () => {
    expect(parse({ tag: ['Receipt', 'Medical'] }).tag).toEqual(['Receipt', 'Medical']);
  });

  it('leaves the filter off when no tag is given', () => {
    expect(parse({}).tag).toBeUndefined();
  });

  /** A hand-edited or stale link should open the app with the bad filter dropped. */
  it('drops a filter it cannot read rather than failing', () => {
    expect(parse({ tag: '' }).tag).toBeUndefined();
  });

  /**
   * Repeated params, not a delimited value: tag names in this archive contain spaces and
   * dots, and any delimiter would need escaping on both sides of the wire.
   */
  it('writes every tag as its own parameter', () => {
    const url = new URL(exportUrl({ tag: ['Receipt', 'Medical'] }), 'http://x');
    expect(url.searchParams.getAll('tag')).toEqual(['Receipt', 'Medical']);
  });

  it('writes no tag parameter when none are selected', () => {
    const url = new URL(exportUrl({ tag: [] }), 'http://x');
    expect(url.searchParams.has('tag')).toBe(false);
  });

  /** A name carrying the character a delimiter would have used survives the round trip. */
  it('round-trips a tag name containing a comma', () => {
    const url = new URL(exportUrl({ tag: ['Smith, John'] }), 'http://x');
    expect(url.searchParams.getAll('tag')).toEqual(['Smith, John']);
  });
});
