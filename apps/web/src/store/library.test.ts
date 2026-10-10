import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEED_TIMEOUT_MS, FeedTimeoutError, LIBRARY_OPEN_TIMEOUT_MS, LIBRARY_ROOTS, LibraryOpenTimeoutError, acquireLibrary, closeLibraryAndStore, currentLibrary, fetchJson, resetLibraryForTests, rootsOfNoteChanges, settleWrites, subscribeLibrary } from './library.js';
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
