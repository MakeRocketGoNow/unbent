import { describe, expect, it } from 'vitest';
import { filters } from './notes.js';

/**
 * The view in the URL. Each history entry names the view it showed, so a link or a Back
 * press to `?view=cards` must come back as the cards; and a value the schema does not
 * know is dropped rather than failing the route (`catch(undefined)`), so the list is
 * drawn and the remembered view stands in, which is also how an older build reads a
 * `cards` link.
 */
describe('the notes route view', () => {
  const parse = (search: Record<string, unknown>) => filters.parse(search).view;

  it('reads each of the three views', () => {
    expect(parse({ view: 'list' })).toBe('list');
    expect(parse({ view: 'cards' })).toBe('cards');
    expect(parse({ view: 'table' })).toBe('table');
  });

  it('drops a view it does not know, and an absent one stays absent', () => {
    expect(parse({ view: 'gallery' })).toBeUndefined();
    expect(parse({})).toBeUndefined();
  });
});
