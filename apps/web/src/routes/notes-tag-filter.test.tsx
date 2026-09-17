import { describe, expect, it } from 'vitest';
import { filters, writeTagFilter } from './notes.js';
import { exportUrl } from '../notes-api.js';

/**
 * The tag filter reads one tag or several, and writes whichever makes the better link.
 *
 * Worth pinning at this level because the filter lives in the URL: a link someone
 * bookmarked or pasted into a chat carries `?tag=x`, and widening the schema to an array
 * must not turn those into dropped filters. `catch(undefined)` means a schema that no
 * longer matches fails silently rather than loudly — the bad filter is simply gone — so a
 * regression here would look like "the link stopped working" with nothing to debug.
 *
 * Two serializations are in play and they are deliberately different, which is worth
 * knowing before reading the cases below. The *browser* URL is the router's, and it
 * JSON-encodes the array: `?tag=["a","b"]`. The *API* query is `notes-api.ts`'s and repeats
 * the parameter, `?tag=a&tag=b`, because that is what the Worker reads. The `exportUrl`
 * cases here are about that second wire.
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

  it('writes the selection as a list', () => {
    expect(writeTagFilter(['Receipt'])).toEqual(['Receipt']);
    expect(writeTagFilter(['Receipt', 'Medical'])).toEqual(['Receipt', 'Medical']);
  });

  /* The whole job of the writer: no dead `?tag=` left on the link once the last tag goes. */
  it('writes nothing at all when the selection is empty', () => {
    expect(writeTagFilter([])).toBeUndefined();
  });

  it('round-trips what it writes', () => {
    for (const tags of [['Receipt'], ['Receipt', 'Medical'], ['Dentist Visit']]) {
      expect(parse({ tag: writeTagFilter(tags) }).tag).toEqual(tags);
    }
    expect(parse({ tag: writeTagFilter([]) }).tag).toBeUndefined();
  });

  /*
   * Why a bare `?tag=Receipt` cannot be what we write, however much nicer it is to paste.
   *
   * The schema reads it — that is the case above — so writing one looks like a free win.
   * But `validateSearch` runs on every navigation and this transform coerces the string to
   * a one-element array, and the router serializes *that* into the URL. The bare form is
   * normalized away before it is ever written.
   *
   * This test is the evidence for the note on `tagFilter`, so that the next person to find
   * `?tag=%5B%22Receipt%22%5D` ugly does not spend the afternoon rediscovering it.
   */
  it('normalizes a bare tag into a list, which is why the URL cannot stay bare', () => {
    expect(parse({ tag: 'Receipt' }).tag).toEqual(['Receipt']);
  });

  /** A hand-edited or stale link should open the app with the bad filter dropped. */
  it('drops a filter it cannot read rather than failing', () => {
    expect(parse({ tag: '' }).tag).toBeUndefined();
  });

  it('reads a field sort by id and drops one that is not an id', () => {
    const id = '0f0f0ae3-5038-432b-aafd-bb4043f5743b';
    expect(parse({ sortField: id }).sortField).toBe(id);
    expect(parse({ sortField: 'amount' }).sortField).toBeUndefined();
    expect(parse({}).sortField).toBeUndefined();
  });

  /**
   * The API query, which is a different wire from the browser URL above.
   *
   * Repeated params, not a delimited value: tag names in this archive contain spaces and
   * dots, and any delimiter would need escaping on both sides.
   */
  it('writes every tag as its own parameter in the API query', () => {
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
