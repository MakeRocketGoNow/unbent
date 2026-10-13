import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEED_TIMEOUT_MS, FeedTimeoutError, LIBRARY_OPEN_TIMEOUT_MS, LIBRARY_ROOTS, LibraryElsewhereError, LibraryOpenTimeoutError, acquireLibrary, closeLibraryAndStore, currentLibrary, fetchJson, libraryElsewhere, resetLibraryForTests, rootsOfNoteChanges, settleWrites, subscribeLibrary, takeOverLibrary } from './library.js';
import { setLocksForTests } from './library-lock.js';
import { fakeLocks } from './test-locks.js';
import { fakeChannel } from './test-channel.js';
import { HOLDER_SILENT_MS, PING_MS } from './client-library.js';
import { serveLibrary } from './library-serve.js';
import type { Port } from './library-channel.js';
import { libraryLockName } from './names.js';
import { openLocalStore, type LocalStore } from './db.js';
import { reportError } from '../report-error.js';
import { FeedEngine } from './feed.js';
import { createCollections } from './collections.js';
import { createOutbox } from './actions.js';
import { createKeeper } from './keep.js';

vi.mock('./db.js', () => ({ openLocalStore: vi.fn(), closeLocalStore: vi.fn(async () => {}), openSearchDatabase: vi.fn() }));
import { closeLocalStore } from './db.js';
vi.mock('../report-error.js', () => ({ reportError: vi.fn() }));
/*
 * What `open` builds on, stood in for so the lifecycle — the queue, the bound, a close
 * taking a stuck open's entry — can be driven end to end without a worker or a file. The
 * engine is real; its pull never starts, since the stand-in collections never register.
 */
vi.mock('./collections.js', () => ({ createCollections: vi.fn(), cursorStore: vi.fn() }));
vi.mock('./actions.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./actions.js')>()), createOutbox: vi.fn() }));
vi.mock('./keep.js', () => ({ createKeeper: vi.fn() }));
vi.mock('./search-index.js', () => ({
  SearchIndex: class {
    ready = async () => {};
    close = async () => {};
  },
}));
vi.mock('./search-sync.js', () => ({ createSearchSync: vi.fn(() => ({ touch() {}, touchFiles() {}, wake() {}, startOver() {}, stop: async () => {}, opened: async () => {} })) }));
vi.mock('./files.js', () => ({ askToPersist: vi.fn(), readKeptNotebooks: vi.fn(async () => new Set()) }));
/* The channel to the account's other tabs: a fake per test, or none, as a test says. */
vi.mock('./library-channel.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./library-channel.js')>()), openPort: vi.fn(() => null) }));
import { openPort } from './library-channel.js';

/**
 * Which queries a change to the notes collection reaches. A save that changed only the
 * text re-runs the list and the note; anything that moves a note between lists or counts
 * — filing, tagging, trashing, a field, a row arriving or going — re-runs everything.
 */
const row = { id: 'n1', title: 'a', body: 'b', updatedAt: 1, deletedAt: undefined, notebookId: 'nb', tagIds: ['t1', 't2'], fields: [{ fieldId: 'f', value: 1 }] };

describe('rootsOfNoteChanges', () => {
  it('reaches only the list and the note for a change of text', () => {
    const roots = rootsOfNoteChanges([{ type: 'update', previousValue: row, value: { ...row, title: 'b', body: 'c', updatedAt: 2 } }]);
    expect([...roots].sort()).toEqual(['note', 'notes']);
  });

  it('reaches the trash too when the note is in it', () => {
    const trashed = { ...row, deletedAt: 5 };
    const roots = rootsOfNoteChanges([{ type: 'update', previousValue: trashed, value: { ...trashed, title: 'b' } }]);
    expect([...roots].sort()).toEqual(['note', 'notes', 'trash']);
  });

  it.each([
    ['filing', { notebookId: 'other' }],
    ['a notebook named by a write made here', { notebookName: 'New' }],
    ['tagging', { tagIds: ['t1'] }],
    ['tags named by a write made here', { tagNames: ['x'] }],
    ['trashing', { deletedAt: 9 }],
    ['a field', { fields: [{ fieldId: 'f', value: 2 }] }],
  ])('reaches everything for %s', (_what, change) => {
    expect(rootsOfNoteChanges([{ type: 'update', previousValue: row, value: { ...row, ...change } }])).toBe(LIBRARY_ROOTS);
  });

  it('reaches everything for a row arriving or going, or a change it cannot read', () => {
    expect(rootsOfNoteChanges([{ type: 'insert', value: row }])).toBe(LIBRARY_ROOTS);
    expect(rootsOfNoteChanges([{ type: 'delete' }])).toBe(LIBRARY_ROOTS);
    expect(rootsOfNoteChanges([{ type: 'update', value: row }])).toBe(LIBRARY_ROOTS);
  });

  it('is the union over a batch', () => {
    const roots = rootsOfNoteChanges([
      { type: 'update', previousValue: row, value: { ...row, title: 'x' } },
      { type: 'update', previousValue: row, value: { ...row, tagIds: [] } },
    ]);
    expect(roots).toBe(LIBRARY_ROOTS);
  });
});

/**
 * The engine's fetch. A page that never arrived held the first copy for good until a
 * reload; timed out, it is a failed pull the engine can retry, and an error worth reporting.
 */
describe('fetchJson', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A fetch whose answer never comes, or whose body never finishes, until it is aborted. */
  function stalling(at: 'headers' | 'body') {
    return vi.fn((_input: string, init?: RequestInit) => {
      const aborted = new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
      if (at === 'headers') return aborted;
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => aborted } as unknown as Response);
    });
  }

  it.each(['headers', 'body'] as const)('gives up on a page whose %s never arrive, naming the route and not the cursor', async (at) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', stalling(at));
    const result = fetchJson('/api/changes/snapshot?limit=200&cursor=abc');
    const settled = expect(result).rejects.toBeInstanceOf(FeedTimeoutError);
    await vi.advanceTimersByTimeAsync(FEED_TIMEOUT_MS);
    await settled;
    await expect(result).rejects.toThrow('/api/changes/snapshot did not answer within 60 s');
  });

  it('gives up at once when the engine stops, as the stop and not as a timeout', async () => {
    vi.stubGlobal('fetch', stalling('headers'));
    const stop = new AbortController();
    const result = fetchJson('/api/changes?since=10&epoch=e1&limit=200', stop.signal);
    stop.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('names the route alone when the server refuses, so every page groups as one report', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, headers: new Headers() }) as unknown as Response));
    await expect(fetchJson('/api/changes?since=10&epoch=e1&limit=200')).rejects.toMatchObject({ status: 503, message: '/api/changes answered 503' });
  });
});

/**
 * Opening the library is bounded for its caller. It waits on things outside the tab —
 * the outbox's database, the collections' leader — and an open that never settled left
 * every screen on "Opening your notes…" with nothing reported. Past the bound the page
 * reads the server and the error is reported; the open itself goes on in the queue, the
 * account keeps its refusal so no navigation waits again, and a close or a later open
 * waits behind it.
 */
/**
 * A page with a store to open: the stand-ins above, a socket that records itself, and
 * an outbox whose `ready` the test holds. What `open` reaches before that wait — the
 * engine, the socket, the listeners — is real.
 */
function page(opts: { ready?: Promise<void>; pending?: number } = {}) {
  class FakeSocket {
    static all: FakeSocket[] = [];
    closed = false;
    constructor(readonly url: string) {
      FakeSocket.all.push(this);
    }
    addEventListener() {}
    close() {
      this.closed = true;
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  const collection = () => ({ subscribeChanges: () => ({ unsubscribe() {} }), values: () => [], cleanup: vi.fn(async () => {}), preload: async () => {}, get: () => undefined, has: () => false });
  const collections = { notes: collection(), notebooks: collection(), tags: collection(), attachments: collection(), syncState: collection() };
  vi.mocked(createCollections).mockReturnValue(collections as never);
  let pending = opts.pending ?? 0;
  const listeners = new Set<(s: { pending: number }) => void>();
  const outbox = {
    ready: opts.ready ?? Promise.resolve(),
    executor: { isOfflineEnabled: true },
    dispose: vi.fn(async () => {}),
    subscribe: (l: (s: { pending: number }) => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    status: () => ({ pending, durable: true, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map() }),
    onAcknowledged: () => () => {},
    /** The writes went: what a drained outbox tells its subscribers. */
    drain: () => {
      pending = 0;
      listeners.forEach((l) => l({ pending }));
    },
  };
  vi.mocked(createOutbox).mockReturnValue(outbox as never);
  vi.mocked(createKeeper).mockReturnValue({ status: () => ({ kept: new Set() }), subscribe: () => () => {}, stop: vi.fn(), nudge: vi.fn() } as never);
  vi.mocked(openLocalStore).mockResolvedValue({ userId: 'u1', persistence: {}, coordinator: {}, database: {} } as never);
  const stop = vi.spyOn(FeedEngine.prototype, 'stop');
  return { sockets: FakeSocket.all, outbox, collections, stop };
}

describe('acquireLibrary', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetLibraryForTests();
    setLocksForTests(undefined);
    vi.mocked(openLocalStore).mockReset();
    vi.mocked(reportError).mockReset();
  });

  it('halts a stuck open’s engine and socket the moment a sign-out takes its entry, and closes it fully once the open ends', async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    const { sockets, outbox, collections, stop } = page({ ready: new Promise((r) => (ready = r)) });
    const first = acquireLibrary('u1');
    first.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    // Built up to the one wait that can wedge: the socket is up, the engine is live.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    // A sign-out. Its close is behind the stuck open on the queue, but the open's engine
    // and socket stop now: a bounded wipe lets the sign-out move on, and the next
    // person's feed must not be pulled into this account's file.
    const closing = closeLibraryAndStore();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(sockets[0]!.closed).toBe(true);
    expect(outbox.dispose).not.toHaveBeenCalled();
    expect(closeLocalStore).not.toHaveBeenCalled();
    // The open ends: the close step runs it down, store last.
    ready();
    await vi.advanceTimersByTimeAsync(10);
    await closing;
    expect(outbox.dispose).toHaveBeenCalledTimes(1);
    expect(collections.notes.cleanup).toHaveBeenCalledTimes(1);
    // The store after the collections' cleanup, as `db.ts` requires; the library's own
    // close and the wipe's step both ask, and the second ask is a no-op in `db.ts`.
    expect(closeLocalStore).toHaveBeenCalled();
    expect(vi.mocked(closeLocalStore).mock.invocationCallOrder[0]).toBeGreaterThan(collections.notes.cleanup.mock.invocationCallOrder[0]!);
  });

  it('honours a halt asked for while the store was still opening', async () => {
    vi.useFakeTimers();
    let opened!: (store: LocalStore) => void;
    const { sockets, stop } = page({ ready: new Promise(() => {}) });
    vi.mocked(openLocalStore).mockImplementationOnce(() => new Promise<LocalStore>((resolve) => (opened = resolve)));
    const first = acquireLibrary('u1');
    first.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(0);
    // A sign-out during the cold open: nothing to halt yet, and the request must keep.
    void closeLibraryAndStore();
    await vi.advanceTimersByTimeAsync(0);
    opened({ userId: 'u1', persistence: {}, coordinator: {}, database: {} } as never);
    await vi.advanceTimersByTimeAsync(0);
    // The open built its engine and socket, and halted them at once; it is now stuck on
    // the outbox, holding the store and nothing live.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(true);
    expect(stop).toHaveBeenCalled();
  });

  /** The page coming back from the back/forward cache, as the browser says it. */
  const restored = () => {
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
  };

  it('reopens the same account after a back/forward-cache restore, and the old outbox cannot close the new library', async () => {
    vi.useFakeTimers();
    page();
    const first = await acquireLibrary('u1');
    restored();
    await vi.advanceTimersByTimeAsync(10);
    const second = await currentLibrary();
    expect(second).toMatchObject({ userId: 'u1' });
    expect(second).not.toBe(first);
    // The first library's outbox, asked to close by another tab after the reopen: it is
    // not the current library's outbox, so the current library stays.
    const firstEvents = vi.mocked(createOutbox).mock.calls[0]![2]!;
    firstEvents.onAskedToClose!();
    await vi.advanceTimersByTimeAsync(10);
    await expect(currentLibrary()).resolves.toBe(second);
  });

  it('does not reopen an account after a back/forward-cache restore when a switch came first', async () => {
    vi.useFakeTimers();
    let disposed!: () => void;
    const { outbox } = page();
    outbox.dispose.mockImplementationOnce(() => new Promise<void>((resolve) => (disposed = resolve)));
    await acquireLibrary('u1');
    restored();
    await vi.advanceTimersByTimeAsync(10);
    // The restore's close is still in hand; another account signs in meanwhile.
    const switched = acquireLibrary('u2');
    disposed();
    await vi.advanceTimersByTimeAsync(10);
    await switched;
    await expect(currentLibrary()).resolves.toMatchObject({ userId: 'u2' });
    expect(vi.mocked(openLocalStore).mock.calls.map(([id]) => id)).toEqual(['u1', 'u2']);
  });

  it('becomes the library once an open its caller was refused finishes, and tells the hooks', async () => {
    vi.useFakeTimers();
    let ready!: () => void;
    page({ ready: new Promise((r) => (ready = r)) });
    const first = acquireLibrary('u1');
    const refused = expect(first).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    await refused;
    const heard = vi.fn();
    const stopListening = subscribeLibrary(heard);
    ready();
    await vi.advanceTimersByTimeAsync(10);
    expect(heard).toHaveBeenCalled();
    await expect(currentLibrary()).resolves.toMatchObject({ userId: 'u1' });
    await expect(acquireLibrary('u1')).resolves.toMatchObject({ userId: 'u1' });
    stopListening();
  });

  it('does not let Sign out wait on an open past the sign-out’s own bound', async () => {
    vi.useFakeTimers();
    page({ ready: new Promise(() => {}) });
    const first = acquireLibrary('u1');
    first.catch(() => {});
    let left: number | null = null;
    void settleWrites(5_000).then((n) => (left = n));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(left).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(left).toBe(0);
  });

  it('gives a library with writes waiting the rest of the sign-out’s bound to drain them', async () => {
    vi.useFakeTimers();
    const { outbox } = page({ pending: 2 });
    await acquireLibrary('u1');
    let left: number | null = null;
    void settleWrites(5_000).then((n) => (left = n));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(left).toBeNull();
    outbox.drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(left).toBe(0);
  });

  it('refuses its caller when an open does not settle, reports it, and answers every later ask at once', async () => {
    vi.useFakeTimers();
    vi.mocked(openLocalStore).mockImplementation(() => new Promise(() => {}));
    const first = acquireLibrary('u1');
    const settled = expect(first).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    await settled;
    expect(reportError).toHaveBeenCalledWith(expect.any(LibraryOpenTimeoutError), 'error');
    // The queries read the server: what they are given is the refusal.
    await expect(currentLibrary()).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    // The root `beforeLoad` asks again on every navigation: the same refusal, now, not
    // another wait and another report.
    const again = acquireLibrary('u1');
    expect(again).toBe(first);
    await expect(again).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    expect(openLocalStore).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('lets a close and a later open wait behind the open it refused, and opens anew once that has settled', async () => {
    vi.useFakeTimers();
    let fail!: (err: Error) => void;
    vi.mocked(openLocalStore).mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    const first = acquireLibrary('u1');
    first.catch(() => {});
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    // A sign-out: its close is queued behind the open still in hand.
    let closed = false;
    void closeLibraryAndStore().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    expect(closeLocalStore).not.toHaveBeenCalled();
    // The open ends: the close runs, and a sign-in after it opens anew.
    fail(new Error('store gone'));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(true);
    vi.mocked(openLocalStore).mockRejectedValueOnce(new Error('no OPFS'));
    await expect(acquireLibrary('u1')).rejects.toThrow('no OPFS');
    expect(openLocalStore).toHaveBeenCalledTimes(2);
  });

  it('closes the account before a switch inside the queue, so a wipe meanwhile waits for it too', async () => {
    vi.useFakeTimers();
    // An account whose open never settles, then a switch to another: the switch's open is
    // behind the first's step, and refuses its caller on its own clock.
    vi.mocked(openLocalStore).mockImplementation(() => new Promise(() => {}));
    const first = acquireLibrary('u1');
    first.catch(() => {});
    const second = acquireLibrary('u2');
    const secondSettled = expect(second).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    await secondSettled;
    expect(openLocalStore).toHaveBeenCalledTimes(1);
    // A wipe queued behind both does not reach the store while they are in hand.
    let wiped = false;
    void closeLibraryAndStore().then(() => (wiped = true));
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    expect(wiped).toBe(false);
    expect(closeLocalStore).not.toHaveBeenCalled();
  });

  /*
   * One tab holds an account's library (`library-lock.ts`), and the others are its
   * clients over the account's channel (`library-channel.ts`). The tests below play the
   * other tab with the fake lock manager and the fake channel directly: a request it
   * holds is that tab's library, open, and a holder served over the channel is that
   * library's rows on offer.
   */
  describe('with another tab', () => {
    const lock = libraryLockName('u1');
    let channel: ReturnType<typeof fakeChannel>;
    beforeEach(() => {
      channel = fakeChannel();
      vi.mocked(openPort).mockImplementation((_userId, clientId) => channel.port(clientId));
    });
    afterEach(() => vi.mocked(openPort).mockReset().mockImplementation(() => null));

    /** The other tab's library, served over the channel from the stand-in collections. */
    function theirs(port: Port = channel.port()) {
      const collection = () => ({ subscribeChanges: () => ({ unsubscribe() {} }), values: () => [{ id: 'n1', title: 'theirs' }], preload: async () => {}, get: () => undefined, has: () => false });
      const outbox = { status: () => ({ pending: 3, durable: true, waiting: new Set(), conflicts: new Map(), uploadNotices: new Map() }), subscribe: () => () => {}, onAcknowledged: () => () => {} };
      const keeper = { status: () => ({ supported: true, kept: new Set(['nb1']) }), subscribe: () => () => {} };
      return serveLibrary(port, {
        collections: { notes: collection(), notebooks: collection(), tags: collection(), attachments: collection(), syncState: collection() } as never,
        state: () => ({ phase: 'current', cursor: { seq: 9, epoch: 'e' }, lastError: null, total: null, applied: 0, pulls: 1, resets: 0 }),
        onState: () => () => {},
        outbox: outbox as never,
        keeper: keeper as never,
        search: () => null,
        searchReady: Promise.resolve(),
      });
    }

    it('is a client of the tab that holds the library, and opens it once that tab lets go', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      page();
      let letGo!: () => void;
      void locks.request(lock, { mode: 'exclusive' }, () => new Promise<void>((r) => (letGo = r)));
      theirs();
      await vi.advanceTimersByTimeAsync(0);
      const first = acquireLibrary('u1');
      await vi.advanceTimersByTimeAsync(10);
      const client = await first;
      expect(client.remote).toBe(true);
      // The holder's rows, state and status are here; nothing of this tab's was opened.
      expect([...client.notes.values()]).toEqual([{ id: 'n1', title: 'theirs' }]);
      expect(client.state().cursor).toEqual({ seq: 9, epoch: 'e' });
      expect(client.outbox.status().pending).toBe(3);
      expect(libraryElsewhere()).toBe('u1');
      expect(openLocalStore).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
      // Every ask meanwhile is the client, with no second request to the lock.
      expect(acquireLibrary('u1')).toBe(first);
      await expect(currentLibrary()).resolves.toBe(client);
      // The other tab lets go: this one opens the library on its own, and the hooks hear.
      const heard = vi.fn();
      const stop = subscribeLibrary(heard);
      letGo();
      await vi.advanceTimersByTimeAsync(10);
      expect(libraryElsewhere()).toBeNull();
      await expect(currentLibrary()).resolves.toSatisfy((lib: { userId: string; remote?: true }) => lib.userId === 'u1' && !lib.remote);
      expect(heard).toHaveBeenCalled();
      expect(locks.held(lock)).toBe(true);
      stop();
    });

    it('is a library its caller is refused while no holder answers, and the client once one does', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      page();
      void locks.request(lock, { mode: 'exclusive' }, () => new Promise<void>(() => {}));
      await vi.advanceTimersByTimeAsync(0);
      // The holding tab is still opening, or frozen: nothing answers hello.
      const first = acquireLibrary('u1');
      const refused = expect(first).rejects.toBeInstanceOf(LibraryOpenTimeoutError);
      await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
      await refused;
      // It answers: this tab attaches, and is a client from then on.
      theirs();
      await vi.advanceTimersByTimeAsync(10);
      await expect(currentLibrary()).resolves.toMatchObject({ remote: true });
      expect(libraryElsewhere()).toBe('u1');
    });

    it('opens the library itself when the lock frees before any holder has answered', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      page();
      // The holder is a page on its way out: it lets go a moment after this tab asked.
      let letGo!: () => void;
      void locks.request(lock, { mode: 'exclusive' }, () => new Promise<void>((r) => (letGo = r)));
      await vi.advanceTimersByTimeAsync(0);
      const first = acquireLibrary('u1');
      first.catch(() => {});
      await vi.advanceTimersByTimeAsync(10);
      expect(libraryElsewhere()).toBe('u1');
      letGo();
      await vi.advanceTimersByTimeAsync(10);
      expect(libraryElsewhere()).toBeNull();
      await expect(currentLibrary()).resolves.toSatisfy((lib: { userId: string; remote?: true }) => lib.userId === 'u1' && !lib.remote);
      expect(locks.held(lock)).toBe(true);
      expect(openLocalStore).toHaveBeenCalledTimes(1);
      // The attach that was in hand was halted, not reported as a fault.
      expect(reportError).not.toHaveBeenCalled();
    });

    it('takes the library over itself when the holder it is a client of stops answering', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      page();
      const other = locks.request(lock, { mode: 'exclusive' }, () => new Promise<void>(() => {}));
      other.catch(() => {});
      const theirPort = channel.port();
      theirs(theirPort);
      await vi.advanceTimersByTimeAsync(0);
      const client = acquireLibrary('u1');
      await vi.advanceTimersByTimeAsync(10);
      await expect(client).resolves.toMatchObject({ remote: true });
      // The holder's tab freezes: it keeps the lock and answers nothing.
      theirPort.close();
      await vi.advanceTimersByTimeAsync(HOLDER_SILENT_MS + PING_MS * 2);
      await vi.advanceTimersByTimeAsync(10);
      await expect(other).rejects.toMatchObject({ name: 'AbortError' });
      await expect(currentLibrary()).resolves.toSatisfy((lib: { userId: string; remote?: true }) => lib.userId === 'u1' && !lib.remote);
      expect(libraryElsewhere()).toBeNull();
    });

    it('takes the library over on request', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      page();
      const other = locks.request(lock, { mode: 'exclusive' }, () => new Promise<void>(() => {}));
      other.catch(() => {});
      theirs();
      await vi.advanceTimersByTimeAsync(0);
      const client = acquireLibrary('u1');
      await vi.advanceTimersByTimeAsync(10);
      await expect(client).resolves.toMatchObject({ remote: true });
      const taken = takeOverLibrary();
      await vi.advanceTimersByTimeAsync(10);
      await expect(taken).resolves.toSatisfy((lib: { userId: string; remote?: true }) => lib.userId === 'u1' && !lib.remote);
      // The other tab's hold ended under it, which is how it learns to stand aside.
      await expect(other).rejects.toMatchObject({ name: 'AbortError' });
      expect(libraryElsewhere()).toBeNull();
    });

    it('closes its library and becomes a client when another tab takes it over, and has it back when that tab goes', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      const { outbox } = page();
      await acquireLibrary('u1');
      expect(locks.held(lock)).toBe(true);
      // Another tab presses Open here, and serves the library from there.
      let letGo!: () => void;
      void locks.request(lock, { mode: 'exclusive', steal: true }, () => new Promise<void>((r) => (letGo = r)));
      await vi.advanceTimersByTimeAsync(10);
      expect(outbox.dispose).toHaveBeenCalledTimes(1);
      expect(closeLocalStore).toHaveBeenCalled();
      // The holder that was closed told its clients so, before anything else.
      expect(channel.posted.some((m) => m.type === 'closing')).toBe(true);
      theirs();
      await vi.advanceTimersByTimeAsync(10);
      await expect(currentLibrary()).resolves.toMatchObject({ remote: true });
      expect(libraryElsewhere()).toBe('u1');
      // That tab closes: this one opens the library again without being asked.
      letGo();
      await vi.advanceTimersByTimeAsync(10);
      await expect(currentLibrary()).resolves.toSatisfy((lib: { userId: string; remote?: true }) => lib.userId === 'u1' && !lib.remote);
      expect(openLocalStore).toHaveBeenCalledTimes(2);
    });

    it('does not join the lock’s queue for an account a sign-out or a switch has already left', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      const { outbox } = page();
      let letGo!: () => void;
      void locks.request(lock, { mode: 'exclusive' }, () => new Promise<void>((r) => (letGo = r)));
      theirs();
      await vi.advanceTimersByTimeAsync(0);
      // The open for u1 is queued behind u2's close, which is still in hand when the switch comes.
      await acquireLibrary('u2');
      let disposed!: () => void;
      outbox.dispose.mockImplementationOnce(() => new Promise<void>((resolve) => (disposed = resolve)));
      const first = acquireLibrary('u1');
      first.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      // Another account signs in before u1's step has run.
      const switched = acquireLibrary('u2');
      switched.catch(() => {});
      disposed();
      await vi.advanceTimersByTimeAsync(10);
      await expect(currentLibrary()).resolves.toMatchObject({ userId: 'u2' });
      expect(libraryElsewhere()).toBeNull();
      // u1's holder lets go: nothing opens u1 here.
      letGo();
      await vi.advanceTimersByTimeAsync(10);
      await expect(currentLibrary()).resolves.toMatchObject({ userId: 'u2' });
      expect(vi.mocked(openLocalStore).mock.calls.map(([id]) => id)).not.toContain('u1');
    });

    it('stops waiting for another tab’s library on a sign-out', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      page();
      let letGo!: () => void;
      void locks.request(lock, { mode: 'exclusive' }, () => new Promise<void>((r) => (letGo = r)));
      theirs();
      await vi.advanceTimersByTimeAsync(0);
      const client = acquireLibrary('u1');
      await vi.advanceTimersByTimeAsync(10);
      await expect(client).resolves.toMatchObject({ remote: true });
      await closeLibraryAndStore();
      expect(libraryElsewhere()).toBeNull();
      expect(currentLibrary()).toBeNull();
      letGo();
      await vi.advanceTimersByTimeAsync(10);
      expect(currentLibrary()).toBeNull();
      expect(openLocalStore).not.toHaveBeenCalled();
    });

    it('serves its clients while it holds the library', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      page();
      await acquireLibrary('u1');
      expect(channel.posted.some((m) => m.type === 'serving')).toBe(true);
      // A client says hello: it is sent the rows and attached.
      const client = channel.port('c1');
      const heard: string[] = [];
      client.listen((m) => heard.push(m.type));
      client.post({ type: 'hello', client: 'c1' });
      await vi.advanceTimersByTimeAsync(10);
      expect(heard).toContain('rows');
      expect(heard).toContain('attached');
    });

    it('lets go of the lock when its library closes, for the next tab', async () => {
      vi.useFakeTimers();
      const locks = fakeLocks();
      setLocksForTests(locks);
      page();
      await acquireLibrary('u1');
      await closeLibraryAndStore();
      expect(locks.held(lock)).toBe(false);
    });

    /*
     * A browser without BroadcastChannel has no channel to be a client over, and reads
     * the server as every second tab did before: the refusal, kept, with no request to
     * the lock on every navigation.
     */
    it('reads the server while another tab holds the library and there is no channel to join it over', async () => {
      vi.useFakeTimers();
      vi.mocked(openPort).mockImplementation(() => null);
      const locks = fakeLocks();
      setLocksForTests(locks);
      page();
      let letGo!: () => void;
      void locks.request(lock, { mode: 'exclusive' }, () => new Promise<void>((r) => (letGo = r)));
      await vi.advanceTimersByTimeAsync(0);
      const first = acquireLibrary('u1');
      await expect(first).rejects.toBeInstanceOf(LibraryElsewhereError);
      expect(currentLibrary()).toBeNull();
      expect(libraryElsewhere()).toBe('u1');
      expect(acquireLibrary('u1')).toBe(first);
      letGo();
      await vi.advanceTimersByTimeAsync(10);
      expect(libraryElsewhere()).toBeNull();
      await expect(currentLibrary()).resolves.toMatchObject({ userId: 'u1' });
    });
  });

  it('is not a timeout that fires under an open that settled in time', async () => {
    vi.useFakeTimers();
    // A store whose open fails at once: the library is unavailable for that reason, not for time.
    vi.mocked(openLocalStore).mockRejectedValue(new Error('no OPFS'));
    await expect(acquireLibrary('u1')).rejects.toThrow('no OPFS');
    await vi.advanceTimersByTimeAsync(LIBRARY_OPEN_TIMEOUT_MS);
    expect(reportError).not.toHaveBeenCalled();
    expect(currentLibrary()).toBeNull();
  });
});
