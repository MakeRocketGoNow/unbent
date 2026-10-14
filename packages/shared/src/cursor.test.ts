import { describe, expect, it } from 'vitest';
import { cursorSchema, decodeCursor, encodeCursor } from './cursor.js';

const ID = '90570763-77a9-47ea-81bd-b66f6f3120df';

describe('cursors', () => {
  it('go out as printable text and come back as the key and id', () => {
    const cursor = encodeCursor(1790651018892, ID);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ key: '1790651018892', id: ID });
  });

  it('round-trip a title in any script, and one holding the separator itself', () => {
    for (const key of ['Receipt', 'Café — été', '領収書', 'a\u001Fb', '']) {
      expect(decodeCursor(encodeCursor(key, ID))).toEqual({ key, id: ID });
    }
  });

  it('still read the old form, for a client that held one across the deploy', () => {
    expect(decodeCursor(`1790651018892\u001F${ID}`)).toEqual({ key: '1790651018892', id: ID });
  });

  /**
   * The case that MAK-217 was: the separator written back as six characters. It used to
   * decode as nothing and page from the top, which read as a successful next page.
   */
  it('refuse a cursor that does not decode, rather than starting over', () => {
    const mangled = `1790651018892\\u001f${ID}`;
    expect(decodeCursor(mangled)).toBeNull();
    expect(cursorSchema.safeParse(mangled).success).toBe(false);
    expect(decodeCursor('abc')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(cursorSchema.safeParse(encodeCursor('k', ID)).success).toBe(true);
  });
});
