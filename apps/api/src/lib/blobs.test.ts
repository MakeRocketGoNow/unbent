import { describe, expect, it } from 'vitest';
import { deleteKeys, deleteUserBlobs, deleteUserBlobsPage } from './blobs.js';

/**
 * The sweep that empties an account's storage, tested here rather than against a live
 * Worker because nothing over HTTP can observe it. `gc-blobs` only ever sees the caller's
 * own prefix, so once the account is deleted there is no request anyone can make that
 * distinguishes a swept prefix from a stranded one, which is how the first version of
 * this shipped with two tests that passed either way.
 *
 * A fake bucket also buys the case R2 will not reproduce on demand: an account larger
 * than one `list()` page, which is where pagination and per-page deletion actually have
 * to work.
 */

interface Call {
  op: 'list' | 'delete';
  prefix?: string;
  keys: string[];
}

/**
 * Enough of R2 to sweep against.
 *
 * The cursor is modelled the way R2's is: a position in key order, not a handle on a
 * row. That matters here: the sweep deletes each page before asking for the next one, so
 * by the time the cursor is used the object it names is gone, and a fake that resolved it
 * by lookup would pass a loop that hangs against the real thing.
 */
function fakeBucket(keys: string[]) {
  const store = new Set(keys);
  const calls: Call[] = [];

  const bucket = {
    async list(options: R2ListOptions = {}) {
      const prefix = options.prefix ?? '';
      const limit = options.limit ?? 1000;
      const cursor = options.cursor;
      const after = [...store]
        .filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor))
        .sort();
      const page = after.slice(0, limit);
      const truncated = page.length < after.length;
      calls.push({ op: 'list', prefix, keys: page });
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: page[page.length - 1] } : {}),
      };
    },
    async delete(keys: string | string[]) {
      const batch = Array.isArray(keys) ? keys : [keys];
      calls.push({ op: 'delete', keys: batch });
      for (const key of batch) store.delete(key);
    },
  };

  return { bucket: bucket as unknown as R2Bucket, store, calls };
}

/** `users/{id}/notes/{n}/files/{i}-f.txt`, the shape attachments-repo writes. */
function objectKeys(userId: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `users/${userId}/notes/n${i}/files/a${i}-file.txt`,
  );
}

describe('deleteUserBlobs', () => {
  it('deletes everything under the account', async () => {
    const { bucket, store } = fakeBucket(objectKeys('alice', 3));
    await deleteUserBlobs(bucket, 'alice');
    expect([...store]).toEqual([]);
  });

  /**
   * The reason the sweep exists at all: an imported archive is thousands of files, and
   * `list()` returns at most 1000. Three pages, and the cursor has to survive the fact
   * that the key it names was deleted before it was used.
   */
  it('follows the cursor through an account larger than one page', async () => {
    const { bucket, store, calls } = fakeBucket(objectKeys('alice', 2500));
    await deleteUserBlobs(bucket, 'alice');

    expect([...store]).toEqual([]);
    expect(calls.filter((c) => c.op === 'list')).toHaveLength(3);
    expect(calls.filter((c) => c.op === 'delete').map((c) => c.keys.length)).toEqual([
      1000, 1000, 500,
    ]);
  });

  /**
   * Each page is deleted before the next is listed. Buffering the account and deleting at
   * the end holds every key of it in a Worker's 128MB, and leaves everything behind if
   * the sweep dies halfway.
   */
  it('deletes each page before listing the next', async () => {
    const { bucket, calls } = fakeBucket(objectKeys('alice', 2500));
    await deleteUserBlobs(bucket, 'alice');

    expect(calls.map((c) => c.op)).toEqual([
      'list',
      'delete',
      'list',
      'delete',
      'list',
      'delete',
    ]);
  });

  /**
   * The safety property. The prefix is derived from the user id, so an id is the only
   * thing that can widen the sweep, and it cannot, because every key under another
   * account's prefix sorts outside this one.
   */
  it('never reaches outside the account it was given', async () => {
    const alice = objectKeys('alice', 2);
    const bob = objectKeys('bob', 2);
    const { bucket, store, calls } = fakeBucket([...alice, ...bob]);

    await deleteUserBlobs(bucket, 'alice');

    expect([...store].sort()).toEqual(bob.sort());
    for (const call of calls) {
      if (call.op === 'list') expect(call.prefix).toBe('users/alice/');
      else expect(call.keys.every((key) => key.startsWith('users/alice/'))).toBe(true);
    }
  });

  /** An account with an id that prefixes another's still only gets its own objects. */
  it('does not treat one id as a prefix of a longer one', async () => {
    const { bucket, store } = fakeBucket([
      ...objectKeys('alice', 1),
      ...objectKeys('alice2', 1),
    ]);

    await deleteUserBlobs(bucket, 'alice');

    expect([...store]).toEqual(objectKeys('alice2', 1));
  });

  /** An empty account should cost one list and no deletes, not a delete of nothing. */
  it('issues no delete for an account with no objects', async () => {
    const { bucket, calls } = fakeBucket(objectKeys('bob', 2));
    await deleteUserBlobs(bucket, 'alice');
    expect(calls.map((c) => c.op)).toEqual(['list']);
  });
});

describe('deleteUserBlobsPage', () => {
  /**
   * The sweep's form, which must stay inside two R2 calls whatever the account holds: a
   * page at a time, saying whether to come back, and each call starting over from what
   * the last one left rather than from a cursor.
   */
  it('deletes one page per call and says when the prefix is empty', async () => {
    const { bucket, store, calls } = fakeBucket([...objectKeys('alice', 5), ...objectKeys('alice2', 1)]);

    expect(await deleteUserBlobsPage(bucket, 'alice', 2)).toEqual({ deleted: 2, more: true });
    expect(calls.map((c) => c.op)).toEqual(['list', 'delete']);
    expect(await deleteUserBlobsPage(bucket, 'alice', 2)).toEqual({ deleted: 2, more: true });
    expect(await deleteUserBlobsPage(bucket, 'alice', 2)).toEqual({ deleted: 1, more: false });
    expect([...store]).toEqual(objectKeys('alice2', 1));
  });

  it('costs one list and no delete when nothing is there', async () => {
    const { bucket, calls } = fakeBucket(objectKeys('alice2', 1));
    expect(await deleteUserBlobsPage(bucket, 'alice')).toEqual({ deleted: 0, more: false });
    expect(calls.map((c) => c.op)).toEqual(['list']);
  });
});

describe('deleteKeys', () => {
  /** R2 takes at most 1000 keys per call, and the sweeps that use this can exceed it. */
  it('batches at R2 limit', async () => {
    const keys = objectKeys('alice', 2500);
    const { bucket, store, calls } = fakeBucket(keys);

    await deleteKeys(bucket, keys);

    expect([...store]).toEqual([]);
    expect(calls.map((c) => c.keys.length)).toEqual([1000, 1000, 500]);
  });

  it('makes no call at all for an empty list', async () => {
    const { bucket, calls } = fakeBucket([]);
    await deleteKeys(bucket, []);
    expect(calls).toEqual([]);
  });
});
