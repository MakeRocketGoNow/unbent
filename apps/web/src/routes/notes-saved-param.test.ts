import { describe, expect, it } from 'vitest';
import { filters } from './notes.js';

/**
 * The open saved view in the URL, `?saved=<id>`. A view's id is a UUID, so anything else
 * is a hand-edited or mangled link: dropped rather than failing the route
 * (`catch(undefined)`), and the list opens as the plain notebook it names.
 */
describe('the notes route saved view', () => {
  const parse = (search: Record<string, unknown>) => filters.parse(search).saved;
  const id = '0b6f5f2e-6a3c-4d7e-9c41-2f1a8e5b7d90';

  it('reads a view id', () => {
    expect(parse({ saved: id })).toBe(id);
  });

  it('drops anything that is not an id, and an absent one stays absent', () => {
    expect(parse({ saved: 'Business 2026' })).toBeUndefined();
    expect(parse({ saved: 42 })).toBeUndefined();
    expect(parse({})).toBeUndefined();
  });

  it('leaves the filters beside it alone', () => {
    const parsed = filters.parse({ notebook: 'Receipts', tag: 'Acme', saved: id });
    expect(parsed).toMatchObject({ notebook: 'Receipts', tag: ['Acme'], saved: id });
  });
});
