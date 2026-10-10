import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeLocalStores, installLibraryCloser, wipeLocalStores } from './wipe.js';

vi.mock('./library.js', () => ({ closeLibraryAndStore: vi.fn(async () => {}), currentLibraryUser: vi.fn(() => null) }));
import { closeLibraryAndStore as closeLibrary, currentLibraryUser } from './library.js';

/**
 * What the wipe removes, against a stand-in file system and IndexedDB: every account's
 * copy, outbox and files, or every account's but the one named — whose database, its
 * journal and WAL beside it, its files directory and its outbox stay, since the outbox may hold writes the server has
 * not heard of. The engine's own directory is never ours to remove.
 */
function device(files: string[], dbs: string[], opts: { refuse?: (name: string, attempt: number) => boolean } = {}) {
  const removed: string[] = [];
  const deleted: string[] = [];
  /** Everything that happened, in order: what was posted, deleted and removed. */
  const order: string[] = [];
  const attempts = new Map<string, number>();
  const remaining = new Set(files);
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        entries: async function* () {
          for (const f of remaining) yield [f, {}];
        },
        removeEntry: async (name: string) => {
          const attempt = (attempts.get(name) ?? 0) + 1;
          attempts.set(name, attempt);
          if (opts.refuse?.(name, attempt)) throw new DOMException('held', 'NoModificationAllowedError');
          remaining.delete(name);
          removed.push(name);
          order.push(`remove:${name}`);
        },
      }),
    },
  });
  vi.stubGlobal('indexedDB', {
    databases: async () => dbs.map((name) => ({ name })),
    deleteDatabase: (name: string) => {
      deleted.push(name);
      order.push(`delete:${name}`);
      const req = {} as { onsuccess?: () => void };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  });
  return { removed, deleted, order, attempts };
}

const files = ['unbent-a.sqlite', 'unbent-a.sqlite-wal', 'unbent-a.sqlite-journal', 'unbent-a.search.sqlite', 'unbent-b.sqlite', 'unbent-b.search.sqlite', 'unbent-files-a', 'unbent-files-b', '.ahp-pigei0c7inp'];
const dbs = ['unbent-outbox-a', 'unbent-outbox-b', 'offline-transactions'];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('wipeLocalStores', () => {
  it('removes every account’s copy and outbox, after closing the open library', async () => {
    const { removed, deleted } = device(files, dbs);
    await wipeLocalStores();
    expect(removed.sort()).toEqual(['unbent-a.search.sqlite', 'unbent-a.sqlite', 'unbent-a.sqlite-journal', 'unbent-a.sqlite-wal', 'unbent-b.search.sqlite', 'unbent-b.sqlite', 'unbent-files-a', 'unbent-files-b']);
    expect(deleted.sort()).toEqual(['unbent-outbox-a', 'unbent-outbox-b']);
    expect(closeLibrary).toHaveBeenCalled();
  });

  it('keeps the named account’s files and outbox, and their open library', async () => {
    const { removed, deleted } = device(files, dbs);
    vi.mocked(currentLibraryUser).mockReturnValue('a');
    await wipeLocalStores('a');
    // Their search index stays with the copy it indexes.
    expect(removed.sort()).toEqual(['unbent-b.search.sqlite', 'unbent-b.sqlite', 'unbent-files-b']);
    expect(deleted).toEqual(['unbent-outbox-b']);
    expect(closeLibrary).not.toHaveBeenCalled();
  });

  it('closes another account’s open library before keeping the named one’s files', async () => {
    device(files, dbs);
    vi.mocked(currentLibraryUser).mockReturnValue('b');
    await wipeLocalStores('a');
    expect(closeLibrary).toHaveBeenCalled();
  });
});

/**
 * A stand-in for the channel between tabs: every instance under a name hears what the
 * others post, and nothing it posted itself, as the real one does.
 */
function channels(order: string[] = []) {
  const open = new Map<string, Set<{ onmessage: ((e: { data: unknown }) => void) | null }>>();
  class FakeChannel {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) {
      if (!open.has(name)) open.set(name, new Set());
      open.get(name)!.add(this);
    }
    postMessage(data: unknown) {
      order.push('post');
      for (const other of open.get(this.name) ?? []) if (other !== this) other.onmessage?.({ data });
    }
    close() {
      open.get(this.name)?.delete(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  /** Another tab's listener on the same channel: counts the closes it was told of. */
  const anotherTab = () => {
    const heard: unknown[] = [];
    const theirs = new FakeChannel('unbent-libraries');
    theirs.onmessage = (e) => heard.push(e.data);
    return heard;
  };
  return { anotherTab };
}

describe('other tabs', () => {
  it('are told to close their libraries before the wipe deletes or removes anything', async () => {
    const { order } = device(files, dbs);
    const { anotherTab } = channels(order);
    const stop = installLibraryCloser();
    const theirs = anotherTab();
    await wipeLocalStores();
    expect(theirs).toEqual([{ type: 'close' }]);
    // This tab's own close is the wipe's, once; its own listener does not hear its post.
    expect(closeLibrary).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('post');
    expect(order.filter((o) => o === 'post')).toHaveLength(1);
    stop();
  });

  it('hear which account a wipe keeps, while the tab keeping it does not close its own', async () => {
    device(files, dbs);
    const { anotherTab } = channels();
    vi.mocked(currentLibraryUser).mockReturnValue('a');
    const stop = installLibraryCloser();
    const theirs = anotherTab();
    await wipeLocalStores('a');
    expect(theirs).toEqual([{ type: 'close', except: 'a' }]);
    // The kept account's library, open here, stays open: a wipe `except` it is a sign-in, not a sign-out.
    expect(closeLibrary).not.toHaveBeenCalled();
    stop();
  });

  it('keep the kept account’s library when told of a wipe that keeps it, and close any other', async () => {
    device(files, dbs);
    channels();
    const onClosed = vi.fn();
    const stop = installLibraryCloser(onClosed);
    const theirs = new BroadcastChannel('unbent-libraries');
    // This tab holds the account the other tab's sign-in keeps: nothing of this tab's is wiped.
    vi.mocked(currentLibraryUser).mockReturnValue('a');
    theirs.postMessage({ type: 'close', except: 'a' });
    await new Promise((r) => setTimeout(r, 0));
    expect(closeLibrary).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
    // This tab holds another account: the wipe takes it, and the session is checked after.
    vi.mocked(currentLibraryUser).mockReturnValue('b');
    theirs.postMessage({ type: 'close', except: 'a' });
    await vi.waitFor(() => expect(closeLibrary).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    stop();
  });

  it('do not hold a sign-in on the store-file retries, which still run', async () => {
    vi.useFakeTimers();
    try {
      const { removed, attempts } = device(files, dbs, { refuse: (name, attempt) => name === 'unbent-b.sqlite' && attempt < 3 });
      vi.mocked(currentLibraryUser).mockReturnValue('a');
      let done = false;
      void wipeLocalStores('a').then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      // The sign-in's wipe has returned with the file still held…
      expect(done).toBe(true);
      expect(removed).not.toContain('unbent-b.sqlite');
      // …and the tries go on behind it.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(removed).toContain('unbent-b.sqlite');
      expect(attempts.get('unbent-b.sqlite')).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('get a moment to let go of the store’s file: a removal they still hold is tried again', async () => {
    vi.useFakeTimers();
    try {
      const { removed, attempts } = device(files, dbs, { refuse: (name, attempt) => name === 'unbent-b.sqlite' && attempt < 3 });
      const wipe = wipeLocalStores();
      await vi.advanceTimersByTimeAsync(2000);
      await wipe;
      expect(removed).toContain('unbent-b.sqlite');
      expect(attempts.get('unbent-b.sqlite')).toBe(3);
      // What went the first time is not asked for again.
      expect(attempts.get('unbent-a.sqlite')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leave a file a tab will not let go of for the next wipe, after a bounded wait', async () => {
    vi.useFakeTimers();
    try {
      const { removed, attempts } = device(files, dbs, { refuse: (name) => name === 'unbent-b.sqlite' });
      const wipe = wipeLocalStores();
      await vi.advanceTimersByTimeAsync(5000);
      await wipe;
      expect(removed).not.toContain('unbent-b.sqlite');
      expect(attempts.get('unbent-b.sqlite')).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hear nothing once the listener is stopped, and the wipe still goes', async () => {
    const { deleted } = device(files, dbs);
    const { anotherTab } = channels();
    installLibraryCloser()();
    const theirs = anotherTab();
    await wipeLocalStores();
    expect(theirs).toEqual([]);
    expect(closeLibrary).toHaveBeenCalledTimes(1);
    expect(deleted.sort()).toEqual(['unbent-outbox-a', 'unbent-outbox-b']);
  });

  it('run what the caller asks once a received close has settled', async () => {
    device(files, dbs);
    channels();
    const onClosed = vi.fn();
    const stop = installLibraryCloser(onClosed);
    // Another tab's wipe, as this tab hears it.
    new BroadcastChannel('unbent-libraries').postMessage({ type: 'close' });
    await vi.waitFor(() => expect(closeLibrary).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    stop();
  });

  it('are not a reason a browser without the channel cannot wipe', async () => {
    const { deleted } = device(files, dbs);
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(installLibraryCloser()).toBeTypeOf('function');
    await wipeLocalStores();
    expect(deleted.sort()).toEqual(['unbent-outbox-a', 'unbent-outbox-b']);
  });
});

describe('closeLocalStores', () => {
  it('closes and removes nothing', async () => {
    const { removed, deleted } = device(files, dbs);
    await closeLocalStores();
    expect(closeLibrary).toHaveBeenCalled();
    expect(removed).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('does not wait for ever on a close the queue never reaches, so a sign-out still ends', async () => {
    vi.useFakeTimers();
    try {
      const { deleted } = device(files, dbs);
      vi.mocked(closeLibrary).mockImplementationOnce(() => new Promise(() => {}));
      const wipe = wipeLocalStores();
      let done = false;
      void wipe.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(done).toBe(true);
      // The removals went ahead; a file still held would fail and be tried by the next wipe.
      expect(deleted.sort()).toEqual(['unbent-outbox-a', 'unbent-outbox-b']);
    } finally {
      vi.useRealTimers();
    }
  });
});
