import { describe, expect, it } from 'vitest';
import { isOutbox, isStoreFile, outboxName, storeFileName } from './names.js';

describe('local store names', () => {
  it('carry the account and nothing a file system refuses', () => {
    expect(storeFileName('Ab12xy')).toBe('unbent-Ab12xy.sqlite');
    expect(storeFileName('a/b:c')).toBe('unbent-a_b_c.sqlite');
    expect(outboxName('Ab12xy')).toBe('unbent-outbox-Ab12xy');
  });

  it('recognise the database, its journal and WAL, and the outbox, and nothing else', () => {
    for (const name of ['unbent-Ab12xy.sqlite', 'unbent-Ab12xy.sqlite-wal', 'unbent-Ab12xy.sqlite-journal']) {
      expect(isStoreFile(name), name).toBe(true);
    }
    expect(isStoreFile('.ahp-5pw7srovrac')).toBe(false);
    expect(isStoreFile('unbent-something-else')).toBe(false);
    expect(isOutbox('unbent-outbox-Ab12xy')).toBe(true);
    expect(isOutbox('offline-transactions')).toBe(false);
  });
});
