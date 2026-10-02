import { ApiError, request } from '../notes-api.js';
import { offlineNow, recheck, subscribeConnectivity } from '../connectivity.js';
import { openLocalStore, closeLocalStore } from './db.js';
import { createCollections, cursorStore, type Collections } from './collections.js';
import { createOutbox, provideLibrary, type Outbox } from './actions.js';
import { FeedEngine, type FeedState } from './feed.js';

/**
 * One account's library on this device: its local store, the collections in it, the
 * engine that keeps them current, and the things that make the engine pull — the tab
 * being shown again, the connection returning, and the socket saying the feed moved.
 *
 * Opened once per account and shared by every component through `LibraryProvider`
 * (`library-context.tsx`); a different account signing in closes it first. Closing is
 * what the wipe on sign-out does before it removes the file, since the engine's worker
 * holds the file open.
 */
export interface Library extends Collections {
  userId: string;
  engine: FeedEngine;
  /** The writes made here the server has not taken yet, and the conflicts waiting on a choice. */
  outbox: Outbox;
  /** The engine's state, for the hydration line and the offline banner. */
  subscribe: (listener: (state: FeedState) => void) => () => void;
  state: () => FeedState;
  socket: () => 'open' | 'closed';
  close: () => Promise<void>;
}

/** What a reader of the library needs of it: the collections and the feed's state. */
export type ReadableLibrary = Pick<Library, 'notes' | 'notebooks' | 'tags' | 'attachments' | 'state'>;

let current: { userId: string; library: Promise<Library> } | null = null;
let forTests: ReadableLibrary | null = null;

provideLibrary(async () => {
  if (forTests || !current) return null;
  try {
    return await current.library;
  } catch {
    return null;
  }
});

/** The library open now, or null before anyone has signed in on this tab. */
export function currentLibrary(): Promise<ReadableLibrary> | null {
  if (forTests) return Promise.resolve(forTests);
  return current?.library ?? null;
}

/** Installs an in-memory library for a test to read; see `test-library.ts`. */
export function setLibraryForTests(library: ReadableLibrary | null): void {
  forTests = library;
}

const changeListeners = new Set<() => void>();

/**
 * Hears every change to any collection of the open library — a feed page applied, an
 * optimistic write, a replay settling — coalesced to one call per task. What the query
 * bridge in `queries.ts` listens to, so a view reads the library again when it moves.
 */
export function onLibraryChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
}

export function acquireLibrary(userId: string): Promise<Library> {
  if (current?.userId === userId) return current.library;
  const previous = current;
  const library = (async () => {
    if (previous) await previous.library.then((l) => l.close()).catch(() => {});
    return open(userId);
  })();
  current = { userId, library };
  library.catch((err) => {
    // A browser without the origin-private file system, or one refusing it in a private
    // window: there is no local copy here, and the queries read the server instead (see
    // `queries.ts`). Said once in the console; the next sign-in tries again.
    console.warn('[library] not available on this device; reading from the server instead:', err);
    if (current?.library === library) current = null;
  });
  return library;
}

/** Closes the open library, if any, before the store is closed or wiped. */
export async function closeLibrary(): Promise<void> {
  const open = current;
  current = null;
  if (open) await open.library.then((l) => l.close()).catch(() => {});
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await request(path);
  if (!res.ok) throw new ApiError(res.status, `${path} answered ${res.status}`);
  return (await res.json()) as T;
}

async function open(userId: string): Promise<Library> {
  const store = await openLocalStore(userId);
  const listeners = new Set<(state: FeedState) => void>();
  let latest: FeedState | null = null;
  let collections: Collections | null = null;
  const engine = new FeedEngine({
    fetchJson,
    readCursor: () => (collections ? cursorStore(collections.syncState).readCursor() : Promise.resolve(null)),
    writeCursor: (cursor) => (collections ? cursorStore(collections.syncState).writeCursor(cursor) : Promise.resolve()),
    onState: (state) => {
      latest = state;
      listeners.forEach((l) => l(state));
    },
  });
  collections = createCollections(store, engine);

  let scheduled = false;
  const changed = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      changeListeners.forEach((l) => l());
    });
  };
  const subscriptions = [
    collections.notes.subscribeChanges(changed),
    collections.notebooks.subscribeChanges(changed),
    collections.tags.subscribeChanges(changed),
    collections.attachments.subscribeChanges(changed),
  ];

  // What makes the engine pull. None of these is a timer: a device that is open and
  // idle costs nothing, and the socket is what carries another device's edit here.
  const pull = () => void engine.pull();
  const onVisible = () => {
    if (document.visibilityState === 'visible') pull();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', pull);
  const unsubscribeConnectivity = subscribeConnectivity(() => {
    if (!offlineNow()) pull();
  });

  /*
   * The push: a socket the object tells the feed's seq on after every write, and
   * nothing else, so the handler pulls and reads nothing from the message. Reconnected
   * with a growing wait while the server is unreachable; a reconnect is one request on
   * the Worker, which is why the wait grows. Opened lazily on the first pull so a tab
   * that never gets that far never holds a socket.
   */
  let socket: WebSocket | null = null;
  let socketState: 'open' | 'closed' = 'closed';
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let wait = 1000;
  let closed = false;
  const connect = () => {
    if (closed || socket) return;
    socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/changes/socket`);
    socket.addEventListener('open', () => {
      socketState = 'open';
      wait = 1000;
      pull();
    });
    socket.addEventListener('message', pull);
    socket.addEventListener('close', () => {
      socket = null;
      socketState = 'closed';
      if (closed) return;
      reconnect = setTimeout(connect, wait + Math.random() * wait);
      wait = Math.min(wait * 2, 5 * 60 * 1000);
      // A socket that drops is a reason to ask whether the server is still there.
      recheck();
    });
  };
  connect();

  /*
   * Asked to keep the store rather than evict it under storage pressure, once; the
   * answer is the browser's and a refusal changes nothing — an evicted copy is taken
   * again from a snapshot. Not awaited: some browsers answer only after a prompt.
   */
  void navigator.storage?.persist?.().catch(() => false);
  /*
   * A page restored from the back/forward cache comes back with the adapter's worker
   * and handles in whatever state they were left; the adapter wants fresh instances
   * after it, so the library is closed and opened again for the same account.
   */
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    window.removeEventListener('pageshow', onPageShow);
    void closeLibrary().then(() => acquireLibrary(userId)).catch(() => {});
  };
  window.addEventListener('pageshow', onPageShow);

  const outbox = createOutbox(userId, { ...collections, userId, engine });
  await outbox.executor.waitForInit();

  return {
    ...collections,
    userId,
    engine,
    outbox,
    subscribe: (listener) => {
      listeners.add(listener);
      if (latest) listener(latest);
      return () => void listeners.delete(listener);
    },
    state: () => latest ?? engine.state,
    socket: () => socketState,
    close: async () => {
      closed = true;
      engine.stop();
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', pull);
      unsubscribeConnectivity();
      if (reconnect) clearTimeout(reconnect);
      socket?.close();
      await outbox.dispose();
      await engine.settled();
      for (const s of subscriptions) s.unsubscribe();
      if (collections) {
        await Promise.all(Object.values(collections).map((c) => c.cleanup()));
      }
      await closeLocalStore();
    },
  };
}
