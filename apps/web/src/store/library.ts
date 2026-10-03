import { ApiError, request } from '../notes-api.js';
import { offlineNow, recheck, subscribeConnectivity } from '../connectivity.js';
import { openLocalStore, closeLocalStore } from './db.js';
import { createCollections, cursorStore, type Collections, type LocalNote } from './collections.js';
import { createOutbox, provideLibrary, type Outbox } from './actions.js';
import { FeedEngine, type FeedState } from './feed.js';
import { createKeeper, type Keeper } from './keep.js';

/**
 * One account's library on this device: its local store, the collections in it, the
 * engine that keeps them current, and the things that make the engine pull — the tab
 * being shown again, the connection returning, and the socket saying the feed moved.
 *
 * Opened once per account, as a module singleton the queries and actions look up and
 * the hooks in `use-outbox.ts` and `use-feed-state.ts` follow through `subscribeLibrary`;
 * a different account signing in closes it first. (A React provider was written for this
 * and never mounted; the lookup is what every reader in fact needs, since the queries
 * run outside the tree.) Closing is what the wipe on sign-out does before it removes the
 * file, since the engine's worker holds the file open.
 */
export interface Library extends Collections {
  userId: string;
  engine: FeedEngine;
  /**
   * A number that changes with every change to any collection: what the queries key their
   * derived lookups and sorted lists on, so a read between two changes computes nothing
   * twice. See `view` in `queries.ts`.
   */
  version: () => number;
  /** The writes made here the server has not taken yet, and the conflicts waiting on a choice. */
  outbox: Outbox;
  /** The notebooks whose files this device keeps, and the fetching that keeps them (`keep.ts`). */
  keeper: Keeper;
  /** The engine's state, for the hydration line and the offline banner. */
  subscribe: (listener: (state: FeedState) => void) => () => void;
  state: () => FeedState;
  socket: () => 'open' | 'closed';
  close: () => Promise<void>;
}

/** What a reader of the library needs of it: the collections, the feed's state and the version. */
export type ReadableLibrary = Pick<Library, 'notes' | 'notebooks' | 'tags' | 'attachments' | 'state' | 'version'>;

/** The query roots a change to the library can reach; see `installLibraryQueries`. */
export const LIBRARY_ROOTS: ReadonlySet<string> = new Set(['notes', 'note', 'trash', 'tags', 'notebooks', 'notebook-fields', 'attachments']);

let current: { userId: string; library: Promise<Library> } | null = null;
let forTests: ReadableLibrary | null = null;

const libraryListeners = new Set<() => void>();

/**
 * Hears every change of which library is open: one acquired, one closed, one that failed
 * to open, the one installed for a test. A hook that read `currentLibrary()` once on mount
 * kept a disposed outbox after the page came back from the back/forward cache (`pageshow`
 * below closes and reopens the library) or after an account change, and stayed null for
 * good if the library was not open yet when it mounted (review of #232).
 */
export function subscribeLibrary(listener: () => void): () => void {
  libraryListeners.add(listener);
  return () => void libraryListeners.delete(listener);
}

const libraryChanged = () => libraryListeners.forEach((l) => l());

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

/** Whose library is open now, if anyone's; for the wipe that keeps one account's files. */
export function currentLibraryUser(): string | null {
  return current?.userId ?? null;
}

/**
 * Hears how many writes the open library's outbox holds, as it changes, starting now.
 * Nothing until the library has opened; nothing at all on a device without one.
 */
export function subscribeWrites(listener: (pending: number) => void): () => void {
  let stop: (() => void) | undefined;
  let alive = true;
  const open = current?.library;
  if (open) {
    open.then(
      (lib) => {
        if (alive) stop = lib.outbox.subscribe((s) => listener(s.pending));
      },
      () => {},
    );
  }
  return () => {
    alive = false;
    stop?.();
  };
}

/**
 * Waits, for at most `ms`, for the writes the open library's outbox holds to reach the
 * server, and answers with how many are still waiting. What a sign-out does first: the
 * wipe that follows removes the outbox, and the menu offers Sign out only with a
 * connection, so what waits is usually mid-replay and gone in a moment.
 */
export async function settleWrites(ms: number): Promise<number> {
  const open = current?.library;
  if (!open) return 0;
  let lib: Library;
  try {
    lib = await open;
  } catch {
    return 0;
  }
  if (lib.outbox.status().pending === 0) return 0;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const stop = lib.outbox.subscribe((s) => {
      if (s.pending === 0) done();
    });
    function done() {
      clearTimeout(timer);
      stop();
      resolve();
    }
  });
  return lib.outbox.status().pending;
}

/** Installs an in-memory library for a test to read; see `test-library.ts`. */
export function setLibraryForTests(library: ReadableLibrary | null): void {
  forTests = library;
  libraryChanged();
}

const changeListeners = new Set<(roots: ReadonlySet<string>) => void>();

/**
 * Hears every change to any collection of the open library — a feed page applied, an
 * optimistic write, a replay settling — coalesced to one call per task, with the query
 * roots the changes can reach. What the query bridge in `queries.ts` listens to, so a
 * view reads the library again when it moves — and only the views the change reaches: a
 * save that changed a body changes the list and the note, not the tags, the notebooks or
 * any count, and re-deriving those on every autosave was most of the cost of a keystroke
 * at archive scale (review of #232). Anything but an update of a note's text, or one the
 * change messages cannot describe, reaches everything.
 */
export function onLibraryChange(listener: (roots: ReadonlySet<string>) => void): () => void {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
}

/** For a test library: every listener told that everything may have changed. */
export function notifyLibraryChange(roots: ReadonlySet<string> = LIBRARY_ROOTS): void {
  changeListeners.forEach((l) => l(roots));
}

/** A change message as the collection reports it; the rows are read as notes. */
type NoteChange = { type: string; value?: object | undefined; previousValue?: object | undefined };
type LocalNoteLike = Pick<LocalNote, 'deletedAt' | 'notebookId' | 'notebookName' | 'tagIds' | 'tagNames' | 'fields'>;

/** The roots a batch of note changes reaches: the text's alone when that is all that changed. */
export function rootsOfNoteChanges(changes: ReadonlyArray<NoteChange>): ReadonlySet<string> {
  const roots = new Set<string>(['notes', 'note']);
  for (const c of changes) {
    const v = c.value as LocalNoteLike | undefined;
    const p = c.previousValue as LocalNoteLike | undefined;
    if (c.type !== 'update' || !v || !p) return LIBRARY_ROOTS;
    if (v.deletedAt !== undefined || p.deletedAt !== undefined) roots.add('trash');
    const same =
      v.deletedAt === p.deletedAt &&
      v.notebookId === p.notebookId &&
      v.notebookName === p.notebookName &&
      v.tagIds.length === p.tagIds.length &&
      v.tagIds.every((t, i) => t === p.tagIds[i]) &&
      JSON.stringify(v.tagNames) === JSON.stringify(p.tagNames) &&
      JSON.stringify(v.fields) === JSON.stringify(p.fields);
    if (!same) return LIBRARY_ROOTS;
  }
  return roots;
}

export function acquireLibrary(userId: string): Promise<Library> {
  if (current?.userId === userId) return current.library;
  const previous = current;
  const library = (async () => {
    if (previous) await previous.library.then((l) => l.close()).catch(() => {});
    return open(userId);
  })();
  current = { userId, library };
  libraryChanged();
  library.catch((err) => {
    // A browser without the origin-private file system, or one refusing it in a private
    // window: there is no local copy here, and the queries read the server instead (see
    // `queries.ts`). Said once in the console; the next sign-in tries again.
    console.warn('[library] not available on this device; reading from the server instead:', err);
    if (current?.library === library) {
      current = null;
      libraryChanged();
    }
  });
  return library;
}

/** Closes the open library, if any, before the store is closed or wiped. */
export async function closeLibrary(): Promise<void> {
  const open = current;
  current = null;
  if (open) libraryChanged();
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

  let version = 0;
  let scheduled = false;
  let touched = new Set<string>();
  const changed = (roots: ReadonlySet<string>) => {
    version += 1;
    for (const r of roots) touched.add(r);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const reached = touched;
      touched = new Set();
      changeListeners.forEach((l) => l(reached));
    });
  };
  const everything = () => changed(LIBRARY_ROOTS);
  const subscriptions = [
    collections.notes.subscribeChanges((changes) => changed(rootsOfNoteChanges(changes))),
    collections.notebooks.subscribeChanges(everything),
    collections.tags.subscribeChanges(everything),
    collections.attachments.subscribeChanges(everything),
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
  await outbox.ready;

  /*
   * The kept notebooks' files follow the library: a file the feed delivers into one is
   * fetched, one that leaves is dropped. Nudged by any change that can move a file or a
   * note between notebooks — not by a change to a note's text alone, which is most
   * changes and every keystroke.
   */
  const rows = collections;
  const keeper = createKeeper({
    userId,
    snapshot: () => ({ notes: rows.notes.values(), attachments: rows.attachments.values() }),
    /*
     * Whole once a walk has finished, which is what a cursor in the engine's state means:
     * it is set from a stored position with no page left to resume, or at the end of a
     * walk. Not "the last pull succeeded" — a device opened on a plane never has one, and
     * that is exactly where someone looks to see their files are here (review of #236).
     * Not during a walk either: a `reset` empties the collections before it starts one.
     */
    settled: () => engine.state.cursor !== null && engine.state.phase !== 'hydrating' && engine.state.phase !== 'reset',
    leading: () => outbox.executor.isOfflineEnabled,
  });
  const stopKeeping = onLibraryChange((roots) => {
    if (roots.has('attachments')) keeper.nudge();
  });
  // And by every pull settling — the first copy finishing, or a pull failing offline with
  // the copy already whole — before which the keeper stands down.
  listeners.add(() => keeper.nudge());

  return {
    ...collections,
    userId,
    engine,
    outbox,
    keeper,
    version: () => version,
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
      stopKeeping();
      keeper.stop();
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
