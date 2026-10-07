import { DUMP_LINES } from '../store/load.js';
import type { DumpSlice, UserStore } from '../store/user-store.js';

/**
 * One account's store as SQL text: `sqlite3 account.db < dump.sql` rebuilds it, with
 * nothing from this repository needed. Written by two callers, which is why it lives
 * here: the operator's `GET /api/admin/store/dump`, and the daily backup into the
 * backups bucket (`lib/backups.ts`, MAK-171). Both write the same file, byte for byte
 * but the date in its first line, so a dump from either loads the same way.
 *
 * The order is what makes the file loadable rather than merely complete. Tables and
 * indexes come first, then every row, then the triggers and the FTS tables, then a
 * rebuild of each FTS index from the rows. Rows before triggers, because the count
 * triggers would otherwise add every note a second time to counts the notebook and tag
 * rows already carry, and the FTS insert triggers would index each row on the way in
 * only to have `rebuild` do it again. `_migrations` and `_meta` travel too, so the copy
 * says which schema files it is at and whose it was.
 *
 * The rows come out of the object a slice at a time, eight megabytes of SQL each and
 * across tables (`dumpSlice`), formatted and encoded inside the object where the CPU
 * budget is, so the Worker touches none of their content. A small account is one store
 * call, `dumpBegin`, which carries the schema and the first slice; an archive of 13k
 * notes and 31 MB of SQL is about five.
 */
export interface Dump {
  /** The feed's mark when the dump began; see `UserStore.dumpBegin`. */
  mark: string;
  /**
   * The mark as the last slice was read, once `chunks` has been read to its end; null
   * before. Different from `mark` when a write landed while the dump was being read, and
   * the file's rows may then be from either side of it (`UserStore.dumpSlice`).
   */
  endMark: string | null;
  /** The file, a chunk per pull: the head and first slice, each later slice, the tail. Null when the store's mark was the one the caller already had. */
  chunks: AsyncGenerator<Uint8Array> | null;
}

type DumpStub = Pick<DurableObjectStub<UserStore>, 'dumpBegin' | 'dumpSlice'>;

/**
 * Begins a dump of `userId`'s store. `unless` is the mark of a dump the caller already
 * holds; a store still at it answers `chunks: null` and is read no further. `beforeSlice`
 * runs before each store call after the first, so a caller on a budget of subrequests
 * can count them, and stop the dump by throwing.
 */
export async function beginDump(store: DumpStub, userId: string, opts: { unless?: string | null; beforeSlice?: () => void } = {}): Promise<Dump> {
  const start = await store.dumpBegin(opts.unless ?? null);
  const dump: Dump = { mark: start.mark, endMark: null, chunks: null };
  if (!start.unchanged) dump.chunks = chunks(store, userId, dump, start.schema, start, opts.beforeSlice);
  return dump;
}

async function* chunks(store: DumpStub, userId: string, dump: Dump, schema: string[], first: DumpSlice, beforeSlice?: () => void): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const later = (s: string) => /^CREATE (VIRTUAL TABLE|TRIGGER)\b/i.test(s);
  const head = [
    `${DUMP_LINES.owner}${userId}, dumped ${new Date().toISOString()}`,
    `-- Rebuild with: sqlite3 account.db < this-file.sql`,
    'PRAGMA foreign_keys = OFF;',
    'BEGIN;',
    ...schema.filter((s) => !later(s)).map((s) => `${s};`),
  ];
  yield encoder.encode(`${head.join('\n')}\n`);
  if (first.rows > 0) yield first.bytes;
  let last = first;
  while (last.next) {
    beforeSlice?.();
    last = await store.dumpSlice(last.next);
    if (last.rows > 0) yield last.bytes;
  }
  dump.endMark = last.endMark ?? null;
  const tail = schema.filter(later).map((s) => `${s};`);
  for (const fts of schema.filter((s) => /^CREATE VIRTUAL TABLE/i.test(s))) {
    const name = /^CREATE VIRTUAL TABLE\s+(\S+)/i.exec(fts)![1];
    tail.push(`INSERT INTO ${name}(${name}) VALUES ('rebuild');`);
  }
  tail.push('COMMIT;', 'PRAGMA foreign_keys = ON;');
  // Comments, so the file loads as it always has, and whoever restores from it can tell
  // whether its rows are one moment of the store.
  tail.push(
    `-- Change feed at the start of the dump: ${dump.mark}; at the end: ${dump.endMark ?? 'unknown'}.`,
    dump.endMark === dump.mark ? DUMP_LINES.oneMoment : DUMP_LINES.written,
  );
  yield encoder.encode(`${tail.join('\n')}\n`);
}
