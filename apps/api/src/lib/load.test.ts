import { describe, expect, it } from 'vitest';
import { beforeLoadKey, describeDump, LOAD_PAGE_BYTES, loadReserve, resolveDumpDownload, resolveDumpKey } from './load.js';
import { dumpKey } from './backups.js';
import { DUMP_LINES } from '../store/load.js';

/**
 * The Worker's side of a load, the parts that are pure or need only a bucket: which keys
 * a request may name, where the pre-load dump goes, what the dry run reads off a dump's
 * head and tail, and the subrequests kept back from the pre-load dump. The stream into
 * the object is the store suite's, against the real thing.
 */
describe('resolveDumpDownload', () => {
  const user = 'u1';

  it('names a file under the account and a header-safe filename', () => {
    expect(resolveDumpDownload(user, '2026-10-06.sql')).toEqual({ key: 'stores/u1/2026-10-06.sql', filename: 'unbent-store-u1-2026-10-06.sql' });
    expect(resolveDumpDownload(user, '2026-10-06T12-00-00Z-before-load.sql')?.key).toBe('stores/u1/2026-10-06T12-00-00Z-before-load.sql');
  });

  it('refuses a name that would leave the account, and anything but a dump', () => {
    expect(resolveDumpDownload(user, '../u2/2026-10-06.sql')).toBeNull();
    expect(resolveDumpDownload(user, 'u2/2026-10-06.sql')).toBeNull();
    expect(resolveDumpDownload(user, '..')).toBeNull();
    expect(resolveDumpDownload(user, '2026-10-06.txt')).toBeNull();
    expect(resolveDumpDownload(user, '.sql')).toBeNull();
  });

  it('keeps a quote or a control character in a key out of the header', () => {
    // R2 allows both in a key; either would end `Content-Disposition` early or make the response unbuildable.
    expect(resolveDumpDownload(user, 'a"b\r\n.sql')?.filename).toBe('unbent-store-u1-a_b__.sql');
  });
});

describe('resolveDumpKey', () => {
  it("names a day's daily dump, or a key under the account's own prefix, and nothing else", () => {
    expect(resolveDumpKey('u1', '2026-10-06')).toBe('stores/u1/2026-10-06.sql');
    expect(resolveDumpKey('u1', '2026-10-06')).toBe(dumpKey('u1', Date.UTC(2026, 9, 6, 12)));
    expect(resolveDumpKey('u1', 'stores/u1/2026-10-06T01-02-03Z-before-load.sql')).toBe('stores/u1/2026-10-06T01-02-03Z-before-load.sql');
    expect(resolveDumpKey('u1', 'stores/u1/copied-back/2026-09-01.sql')).toBe('stores/u1/copied-back/2026-09-01.sql');
    // Another account's prefix, however it is reached.
    expect(resolveDumpKey('u1', 'stores/u2/2026-10-06.sql')).toBeNull();
    expect(resolveDumpKey('u1', 'stores/u1/../u2/2026-10-06.sql')).toBeNull();
    expect(resolveDumpKey('u1', 'stores/u1/./2026-10-06.sql')).toBeNull();
    expect(resolveDumpKey('u1', 'stores/u1//2026-10-06.sql')).toBeNull();
    expect(resolveDumpKey('u1', 'stores/u10/2026-10-06.sql')).toBeNull();
    // Not a dump's name.
    expect(resolveDumpKey('u1', 'stores/u1/.sql')).toBeNull();
    expect(resolveDumpKey('u1', 'stores/u1/x.txt')).toBeNull();
    expect(resolveDumpKey('u1', 'status/dumps.json')).toBeNull();
    expect(resolveDumpKey('u1', '2026-10-6')).toBeNull();
    expect(resolveDumpKey('u1', '')).toBeNull();
  });
});

describe('beforeLoadKey', () => {
  it("is under the account's prefix, loadable by the route, and never a daily dump's key", () => {
    const key = beforeLoadKey('u1', Date.UTC(2026, 9, 6, 1, 2, 3, 456));
    expect(key).toBe('stores/u1/2026-10-06T01-02-03Z-before-load.sql');
    expect(resolveDumpKey('u1', key)).toBe(key);
    expect(key).not.toMatch(/\/\d{4}-\d{2}-\d{2}\.sql$/);
  });
});

describe('loadReserve', () => {
  it("counts a page per eight megabytes beside the route's fixed calls", () => {
    expect(loadReserve(1)).toBe(11);
    expect(loadReserve(LOAD_PAGE_BYTES)).toBe(11);
    expect(loadReserve(LOAD_PAGE_BYTES + 1)).toBe(12);
    expect(loadReserve(31 * 1024 * 1024)).toBe(14);
  });
});

/** Enough of an R2 bucket for `describeDump`: `head`, and `get` with a range. */
function bucketWith(objects: Record<string, string>): R2Bucket {
  const bytes = (key: string) => new TextEncoder().encode(objects[key]!);
  return {
    head: async (key: string) => (key in objects ? { size: bytes(key).byteLength, uploaded: new Date('2026-10-06T00:47:00Z') } : null),
    get: async (key: string, opts?: { range?: { offset?: number; length?: number; suffix?: number } }) => {
      if (!(key in objects)) return null;
      const all = bytes(key);
      const range = opts?.range ?? {};
      const slice =
        'suffix' in range && range.suffix !== undefined
          ? all.subarray(Math.max(0, all.byteLength - range.suffix))
          : all.subarray(range.offset ?? 0, (range.offset ?? 0) + (range.length ?? all.byteLength));
      return { text: async () => new TextDecoder().decode(slice) };
    },
  } as unknown as R2Bucket;
}

describe('describeDump', () => {
  const head = (owner: string) => `${DUMP_LINES.owner}${owner}, dumped 2026-10-06T00:47:00.000Z`;
  const body = `-- Rebuild with: sqlite3 account.db < this-file.sql\nPRAGMA foreign_keys = OFF;\nBEGIN;\n${'INSERT INTO notes (id) VALUES (\'n\');\n'.repeat(40)}COMMIT;\nPRAGMA foreign_keys = ON;\n-- Change feed at the start of the dump: e:1; at the end: e:1.\n`;

  it('reads whose the dump is, its size, and whether its rows are one moment, from the head and the tail', async () => {
    const bucket = bucketWith({
      'stores/u1/a.sql': `${head('u1')}\n${body}${DUMP_LINES.oneMoment}\n`,
      'stores/u1/b.sql': `${head('u1')}\n${body}${DUMP_LINES.written}\n`,
      'stores/u1/cut.sql': `${head('u1')}\n${body.slice(0, 400)}`,
      'stores/u1/tiny.sql': `${head('u1')}\n${DUMP_LINES.oneMoment}\n`,
      'stores/u1/other.sql': `${head('u2')}\n${body}${DUMP_LINES.oneMoment}\n`,
      'stores/u1/not.sql': `CREATE TABLE user (id TEXT);\n`,
    });
    expect(await describeDump(bucket, 'stores/u1/a.sql')).toMatchObject({ owner: 'u1', oneMoment: true, uploadedAt: '2026-10-06T00:47:00.000Z', header: head('u1') });
    expect((await describeDump(bucket, 'stores/u1/a.sql'))!.size).toBeGreaterThan(1000);
    expect(await describeDump(bucket, 'stores/u1/b.sql')).toMatchObject({ owner: 'u1', oneMoment: false });
    expect(await describeDump(bucket, 'stores/u1/cut.sql')).toMatchObject({ owner: 'u1', oneMoment: null });
    // A file shorter than the head read is read once and read whole.
    expect(await describeDump(bucket, 'stores/u1/tiny.sql')).toMatchObject({ owner: 'u1', oneMoment: true });
    expect(await describeDump(bucket, 'stores/u1/other.sql')).toMatchObject({ owner: 'u2' });
    expect(await describeDump(bucket, 'stores/u1/not.sql')).toMatchObject({ owner: null, oneMoment: null });
    expect(await describeDump(bucket, 'stores/u1/missing.sql')).toBeNull();
  });
});
