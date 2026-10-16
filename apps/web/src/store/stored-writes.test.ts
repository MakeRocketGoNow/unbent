import { afterEach, describe, expect, it, vi } from 'vitest';
import { countStoredWrites, OUTBOX_STORE } from './actions.js';
import { outboxName } from './names.js';

/**
 * What `countStoredWrites` reads: a stand-in IndexedDB that can already hold an
 * outbox, or not exist yet, or refuse the open. The real adapter is not used: the
 * peek must not create a database or leave a connection, and this is those two
 * properties, against the same request callbacks the production path uses.
 */
function fakeIndexedDB(opts: {
  missing?: boolean;
  keys?: string[];
  blocked?: boolean;
  fail?: boolean;
  noStore?: boolean;
  /** The read never answers, as one cut off by the sign-out's bound. */
  hang?: boolean;
}) {
  const closed: string[] = [];
  let aborted = false;
  let reads = 0;
  let opened: { onversionchange: (() => void) | null } | undefined;
  vi.stubGlobal('indexedDB', {
    open(name: string) {
      const req = {
        result: undefined as IDBDatabase | undefined,
        error: null as DOMException | null,
        onerror: null as ((this: unknown, ev?: unknown) => void) | null,
        onsuccess: null as ((this: unknown, ev?: unknown) => void) | null,
        onblocked: null as ((this: unknown, ev?: unknown) => void) | null,
        onupgradeneeded: null as ((this: unknown, ev?: unknown) => void) | null,
        transaction: {
          abort() {
            aborted = true;
            req.error = new DOMException('aborted', 'AbortError');
            queueMicrotask(() => req.onerror?.());
          },
        },
      };
      queueMicrotask(() => {
        if (opts.blocked) {
          req.onblocked?.();
          return;
        }
        if (opts.fail) {
          req.error = new DOMException('failed', 'UnknownError');
          req.onerror?.();
          return;
        }
        if (opts.missing) {
          req.onupgradeneeded?.();
          return;
        }
        const db = {
          onversionchange: null as (() => void) | null,
          objectStoreNames: { contains: (store: string) => !opts.noStore && store === OUTBOX_STORE },
          transaction() {
            reads++;
            return {
              objectStore() {
                return {
                  getAllKeys() {
                    const keysReq = { result: opts.keys ?? [], onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
                    if (!opts.hang) queueMicrotask(() => keysReq.onsuccess?.());
                    return keysReq;
                  },
                };
              },
            };
          },
          close() {
            closed.push(name);
          },
        };
        opened = db;
        req.result = db as unknown as IDBDatabase;
        req.onsuccess?.();
      });
      return req;
    },
  });
  return { closed, get aborted() { return aborted; }, get db() { return opened; }, get reads() { return reads; } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('countStoredWrites', () => {
  it('counts the waiting entries and closes the connection', async () => {
    const { closed } = fakeIndexedDB({ keys: ['tx:a', 'tx:b', 'conflict:n1', 'upload-notice:f'] });
    await expect(countStoredWrites('u1')).resolves.toBe(2);
    expect(closed).toEqual([outboxName('u1')]);
  });

  it('is zero when there is no outbox yet, and aborts so the open does not create one', async () => {
    const fake = fakeIndexedDB({ missing: true });
    await expect(countStoredWrites('u1')).resolves.toBe(0);
    expect(fake.aborted).toBe(true);
    expect(fake.closed).toEqual([]);
  });

  it('is zero when IndexedDB is not there', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(countStoredWrites('u1')).resolves.toBe(0);
  });

  it('is unknown when the open is blocked, so a sign-out still asks', async () => {
    fakeIndexedDB({ blocked: true });
    await expect(countStoredWrites('u1')).resolves.toBeNull();
  });

  it('is unknown when the open fails, rather than treating the failure as empty', async () => {
    fakeIndexedDB({ fail: true });
    await expect(countStoredWrites('u1')).resolves.toBeNull();
  });

  it('is zero when the database has no transactions store', async () => {
    const { closed } = fakeIndexedDB({ noStore: true, keys: ['tx:a'] });
    await expect(countStoredWrites('u1')).resolves.toBe(0);
    expect(closed).toEqual([outboxName('u1')]);
  });

  it('lets a wipe through when the read is still going, and answers unknown', async () => {
    const fake = fakeIndexedDB({ hang: true, keys: ['tx:a'] });
    const left = countStoredWrites('u1');
    await new Promise((r) => setTimeout(r, 0));
    fake.db?.onversionchange?.();
    await expect(left).resolves.toBeNull();
    expect(fake.closed).toEqual([outboxName('u1')]);
  });

  it('lets its connection go when no longer waited for, mid-read', async () => {
    const fake = fakeIndexedDB({ hang: true, keys: ['tx:a'] });
    const giveUp = new AbortController();
    const left = countStoredWrites('u1', giveUp.signal);
    await new Promise((r) => setTimeout(r, 0));
    giveUp.abort();
    await expect(left).resolves.toBeNull();
    expect(fake.closed).toEqual([outboxName('u1')]);
  });

  it('closes an open that arrives after it was given up on, without reading', async () => {
    const fake = fakeIndexedDB({ keys: ['tx:a'] });
    const giveUp = new AbortController();
    const left = countStoredWrites('u1', giveUp.signal);
    giveUp.abort();
    await expect(left).resolves.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.closed).toEqual([outboxName('u1')]);
    expect(fake.reads).toBe(0);
  });
});
