import { dropBytes, takeBytes, upload, Budget } from './backups.js';
import { beginDump } from './dump.js';
import { SUBREQUEST_BUDGET } from './sweep.js';
import { dumpOwner } from '../store/load.js';
import type { LoadResult, UserStore } from '../store/user-store.js';

/**
 * The Worker's side of loading a dump into a store (MAK-171, part 4): where a dump is
 * found in the backups bucket, the dump of the store as it stands that is written before
 * it is replaced, and the stream of the file into the object a page at a time. The
 * object's side is `UserStore.loadBegin`, `loadPage` and `loadFinish`; the route is
 * `POST /api/admin/store/load` in routes/admin.ts.
 *
 * Bytes, not statements, cross to the object: the file is read from R2 as it comes and
 * cut into pages of `LOAD_PAGE_BYTES` wherever that falls, and the object finds the
 * statements (`store/load.ts` says why it is the object's job). A 31 MB archive is four
 * page calls, and with the dump written first — about five store calls and the upload's
 * seven — the whole route is some twenty-five subrequests for the biggest account, inside
 * even the Free plan's fifty; the only thing that would not fit there is the CPU, which
 * the README's note on dumps already says.
 */

/** Bytes per page sent to the object: the dump's own slice size, well under the 32 MiB an RPC argument may be. */
export const LOAD_PAGE_BYTES = 8 * 1024 * 1024;

/** The prefix under which every dump of `userId` lives, in the daily run's layout (`dumpKey`). */
export function dumpPrefix(userId: string): string {
  return `stores/${userId}/`;
}

/**
 * The key a request's `dump` names, or null when it names nothing this route will load.
 * A date is the daily dump of that day; anything else must be a key under the account's
 * own prefix — the dump written before an earlier load, or one copied back by hand from
 * the mirror — so a dump can only ever be loaded into the account it was taken from. A
 * key with a `..` or an empty segment in it is refused for the same reason: the prefix
 * check is the whole rule, and a path that could be read as leaving it must not pass it.
 */
export function resolveDumpKey(userId: string, dump: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dump)) return `${dumpPrefix(userId)}${dump}.sql`;
  const prefix = dumpPrefix(userId);
  if (!dump.startsWith(prefix) || !dump.endsWith('.sql')) return null;
  const rest = dump.slice(prefix.length);
  if (rest === '.sql' || rest.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  return dump;
}

/**
 * Where the dump of the store as it stood goes, beside the daily ones, so the nightly
 * mirror copies it off-account and the account's `stores/` listing shows it with the
 * rest. The daily run keys on the date alone and never writes a day's key twice, so this
 * carries the time and a suffix, and cannot collide with it.
 */
export function beforeLoadKey(userId: string, now: number): string {
  return `${dumpPrefix(userId)}${new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}-before-load.sql`;
}

/** What the dry run says about a dump, read from its head and tail without fetching the rest. */
export interface DumpDescription {
  key: string;
  size: number;
  uploadedAt: string;
  /** The account the file's first line names, or null when the line is not a dump's. */
  owner: string | null;
  /** The first line of the file, which says when it was taken. */
  header: string;
  /**
   * Whether the file's rows are one moment of the store: false when the last lines say
   * the store was written to while it was read (`dumpSlice`), null when the file has no
   * such lines, which a file cut short would not.
   */
  oneMoment: boolean | null;
}

/**
 * Describes `key`: its size and age from a `head`, and its first and last few hundred
 * bytes from two ranged reads, which is enough for the header line and the two comment
 * lines the dump ends with. Null when there is no such object.
 */
export async function describeDump(bucket: R2Bucket, key: string): Promise<DumpDescription | null> {
  const head = await bucket.head(key);
  if (!head) return null;
  const first = await bucket.get(key, { range: { offset: 0, length: Math.min(head.size, 256) } });
  const last = head.size > 256 ? await bucket.get(key, { range: { suffix: Math.min(head.size, 512) } }) : first;
  const headText = first ? await first.text() : '';
  const tailText = last ? await last.text() : '';
  const header = headText.split('\n')[0] ?? '';
  const oneMoment = /^-- Nothing was written while the store was read/m.test(tailText)
    ? true
    : /^-- The store was written to while it was read/m.test(tailText)
      ? false
      : null;
  return { key, size: head.size, uploadedAt: head.uploaded.toISOString(), owner: dumpOwner(header), header, oneMoment };
}

/**
 * Dumps `userId`'s store as it stands to `key`, the file the daily run writes, and
 * returns the bytes written. Budgeted as the daily run is, so an archive's upload is
 * counted and stopped rather than run past the invocation's subrequests.
 */
export async function dumpBeforeLoad(store: DurableObjectStub<UserStore>, bucket: R2Bucket, userId: string, key: string): Promise<number> {
  const budget = new Budget(SUBREQUEST_BUDGET);
  const dump = await beginDump(store, userId, { beforeSlice: () => budget.take() });
  return upload(bucket, key, dump.chunks!, budget, LOAD_PAGE_BYTES);
}

/**
 * Streams the object at `key` into the store a page at a time and finishes the load.
 * `loadBegin` has been called by the time this runs, so a failure here — a refused
 * statement, a dump of the wrong account, a lost connection — leaves the store loading
 * and refusing, which the route says so about; nothing here tries to put it back.
 */
export async function streamDump(store: DurableObjectStub<UserStore>, body: ReadableStream<Uint8Array>, loadId: string): Promise<LoadResult> {
  const reader = body.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.byteLength;
      while (pendingBytes >= LOAD_PAGE_BYTES) {
        await store.loadPage(loadId, takeBytes(pending, LOAD_PAGE_BYTES));
        pending = dropBytes(pending, LOAD_PAGE_BYTES);
        pendingBytes -= LOAD_PAGE_BYTES;
      }
    }
    if (pendingBytes > 0) await store.loadPage(loadId, takeBytes(pending, pendingBytes));
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
  return store.loadFinish(loadId);
}
