import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INDEX_URL, createFilesLedger, evictions, openedFilesUsage, type FilesBudget, type Index } from './budget.js';

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const budget: FilesBudget = { maxBytes: 100 * MB, maxEntries: 3, maxAgeMs: 30 * DAY };
const NOW = 100 * DAY;

describe('evictions', () => {
  it('drops nothing while the files fit', () => {
    expect(evictions({ a: { size: 40 * MB, used: NOW - 1 }, b: { size: 60 * MB, used: NOW - 2 } }, NOW, budget)).toEqual([]);
  });

  it('drops the oldest-opened first when the bytes do not fit, and only as many as it must', () => {
    const index: Index = {
      opened_last_week: { size: 50 * MB, used: NOW - 7 * DAY },
      opened_today: { size: 50 * MB, used: NOW - 1 },
      opened_yesterday: { size: 30 * MB, used: NOW - DAY },
    };
    expect(evictions(index, NOW, budget)).toEqual(['opened_last_week']);
  });

  it('drops the oldest-opened when there are too many, however small', () => {
    const index: Index = { a: { size: 1, used: 4 }, b: { size: 1, used: 1 }, c: { size: 1, used: 3 }, d: { size: 1, used: 2 }, e: { size: 1, used: 5 } };
    expect(evictions(index, 10, budget)).toEqual(['b', 'd']);
  });

  it('drops what has not been opened in a month, even with room to spare', () => {
    expect(evictions({ old: { size: 1, used: NOW - 31 * DAY }, recent: { size: 1, used: NOW - 29 * DAY } }, NOW, budget)).toEqual(['old']);
  });

  it('keeps a file opened again over one stored later and never reopened', () => {
    const index: Index = {
      stored_first_reopened_now: { size: 60 * MB, used: NOW },
      stored_later_never_reopened: { size: 60 * MB, used: NOW - DAY },
    };
    expect(evictions(index, NOW, budget)).toEqual(['stored_later_never_reopened']);
  });
});

/** Cache Storage with one cache in it: enough of `match`, `put`, `delete` and `keys` for the ledger. */
function fakeCaches() {
  const entries = new Map<string, Response>();
  const abs = (key: RequestInfo | URL) => new URL(typeof key === 'string' ? key : key instanceof URL ? key.href : key.url, 'https://unbent.example').href;
  const cache = {
    match: async (key: RequestInfo | URL) => entries.get(abs(key))?.clone(),
    put: async (key: RequestInfo | URL, res: Response) => void entries.set(abs(key), res),
    delete: async (key: RequestInfo | URL) => entries.delete(abs(key)),
    keys: async () => [...entries.keys()].map((url) => ({ url })),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  const file = (path: string, size: number) => entries.set(abs(path), new Response('x', { headers: { 'Content-Length': String(size) } }));
  const held = () => [...entries.keys()].filter((u) => !u.endsWith(INDEX_URL)).map((u) => new URL(u).pathname).sort();
  return { file, held, abs };
}

describe('the ledger a worker keeps', () => {
  let now = NOW;
  let store: ReturnType<typeof fakeCaches>;
  beforeEach(() => {
    now = NOW;
    store = fakeCaches();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('notes each stored file and drops the oldest-opened once the budget is passed', async () => {
    const ledger = createFilesLedger(budget, () => now);
    for (const [name, size] of [['a', 40], ['b', 40], ['c', 40]] as const) {
      now += 1000;
      store.file(`/f/${name}`, size * MB);
      await ledger.stored(store.abs(`/f/${name}`), size * MB);
    }
    expect(store.held()).toEqual(['/f/b', '/f/c']);
    expect(await openedFilesUsage()).toEqual({ files: 2, bytes: 80 * MB });
  });

  it('counts a reopening, so the file looked at again outlasts the one that was not', async () => {
    const ledger = createFilesLedger(budget, () => now);
    store.file('/f/a', 40 * MB);
    await ledger.stored(store.abs('/f/a'), 40 * MB);
    now += DAY;
    store.file('/f/b', 40 * MB);
    await ledger.stored(store.abs('/f/b'), 40 * MB);
    now += DAY;
    await ledger.touch(store.abs('/f/a'));
    store.file('/f/c', 40 * MB);
    await ledger.stored(store.abs('/f/c'), 40 * MB);
    expect(store.held()).toEqual(['/f/a', '/f/c']);
  });

  it('takes in a file something else put in the cache, and forgets one the cache lost', async () => {
    const ledger = createFilesLedger(budget, () => now);
    store.file('/f/a', 10 * MB);
    await ledger.stored(store.abs('/f/a'), 10 * MB);
    // The page puts a just-uploaded file's bytes in; the cache loses one to the browser.
    store.file('/f/from-the-page', 20 * MB);
    await (await caches.open('files-v1')).delete(store.abs('/f/a'));
    await ledger.sweep();
    expect(await openedFilesUsage()).toEqual({ files: 1, bytes: 20 * MB });
  });

  it('survives two files landing at once', async () => {
    const ledger = createFilesLedger(budget, () => now);
    store.file('/f/a', MB);
    store.file('/f/b', MB);
    await Promise.all([ledger.stored(store.abs('/f/a'), MB), ledger.stored(store.abs('/f/b'), MB)]);
    expect(await openedFilesUsage()).toEqual({ files: 2, bytes: 2 * MB });
  });
});
