import type { AttachmentTexts } from '@unbent/shared';
import { ApiError, isOfflineError, request } from '../notes-api.js';
import { reportError } from '../report-error.js';
import { offlineNow, recheck, subscribeConnectivity } from '../connectivity.js';
import { openLocalStore, openSearchDatabase, closeLocalStore } from './db.js';
import { createCollections, cursorStore, type Collections, type LocalNote } from './collections.js';
import { createOutbox, provideLibrary, type Outbox } from './actions.js';
import { FeedEngine, isWhole, type FeedState } from './feed.js';
import { createKeeper, type Keeper } from './keep.js';
import { askToPersist, readKeptNotebooks } from './files.js';
import { SearchIndex } from './search-index.js';
import { createSearchSync, type SearchSync } from './search-sync.js';

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
  /**
   * The index a search reads with no connection, and what keeps it in step with the rows
   * (`search-index.ts`, `search-sync.ts`). Null when its file could not be opened: the
   * library is whole without it, and a search offline then says it needs a connection,
   * as it did before there was an index. Null too until it has opened, which is after
   * the library has: see `searchReady`.
   */
  readonly search: Searching | null;
  /** Settles once the search index has opened or failed to; never rejects. */
  searchReady: Promise<void>;
  /** The engine's state, for the hydration line and the offline banner. */
  subscribe: (listener: (state: FeedState) => void) => () => void;
  state: () => FeedState;
  socket: () => 'open' | 'closed';
  close: () => Promise<void>;
}

export interface Searching {
  index: SearchIndex;
  sync: SearchSync;
}

/** What a reader of the library needs of it: the collections, the feed's state and the version — and the search index, where there is one. */
export type ReadableLibrary = Pick<Library, 'notes' | 'notebooks' | 'tags' | 'attachments' | 'state' | 'version'> & Partial<Pick<Library, 'search' | 'searchReady'>>;

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

/**
 * Says a note was opened on this device, to the open library's search index: the text of
 * its files is then fetched and kept, so what someone has looked at here can be found
 * here with no connection (`SearchSync.opened`). Nothing on a device with no index.
 */
export function noteOpened(noteId: string): void {
  void current?.library
    .then(async (lib) => {
      // A note is often open before the index is: the first one after a cold start.
      await lib.searchReady;
      await lib.search?.sync.opened(noteId);
    })
    .catch(() => {});
}

/** Installs an in-memory library for a test to read; see `test-library.ts`. */
export function setLibraryForTests(library: ReadableLibrary | null): void {
  forTests = library;
  libraryChanged();
}

const indexedListeners = new Set<() => void>();

/**
 * Hears the open library's search index gain something: its first pass finishing, a
 * note indexed, the text of a kept notebook's files arriving. What the query bridge
 * listens to so that a search answered on the device is asked again when the index it
 * was answered from has moved on (`installLibraryQueries`).
 */
export function onSearchIndexed(listener: () => void): () => void {
  indexedListeners.add(listener);
  return () => void indexedListeners.delete(listener);
}

/** For a test library: every listener told the index moved. */
export function notifySearchIndexed(): void {
  indexedListeners.forEach((l) => l());
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

const resetListeners = new Set<() => void>();

/**
 * The library starting over: the feed engine has emptied the collections, to walk the
 * snapshot again after a `reset` from the server (an operator's wind-back or load) or a
 * walk position it refuses. Told once the old rows are gone. Distinct from a change:
 * after a reset a row may be *older* than a cached answer, and `installLibraryQueries`
 * in `queries.ts` drops the cached answers no view is watching rather than asking them
 * again (MAK-196).
 */
export function onLibraryReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => void resetListeners.delete(listener);
}

/** For a test library: every listener told the library has started over. */
export function notifyLibraryReset(): void {
  resetListeners.forEach((l) => l());
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

/**
 * A failed pull, to the error reports. `reportError` already drops an `OfflineError` and
 * says each message once a page load, so a retry failing the same way is one report. A
 * lapsed session is dropped here too: the app answers a 401 by asking for a sign-in, and
 * every device whose sign-in ran out would otherwise report it as a fault.
 */
function reportPullFailure(err: unknown): void {
  if (err instanceof ApiError && err.status === 401) return;
  reportError(err, 'error');
}

/**
 * How long one page of the feed or the snapshot may take, headers and body together. A
 * snapshot page is cut at about 4 MB of bodies (`FEED_PAGE_BYTES`), which a slow phone
 * connection takes tens of seconds over; a minute is room for that and still an answer
 * someone waiting on a first copy gets.
 */
export const FEED_TIMEOUT_MS = 60_000;

/** A page of the feed that did not arrive in time. Reported, unlike an `OfflineError`. */
export class FeedTimeoutError extends Error {
  constructor(route: string) {
    super(`${route} did not answer within ${FEED_TIMEOUT_MS / 1000} s`);
    this.name = 'FeedTimeoutError';
  }
}

/**
 * The engine's fetch, with a timeout of its own that covers the body as well as the
 * headers. `request`'s `timeout` stops at the headers, and a page is megabytes, so a
 * connection that stalls halfway through one is the hang it would miss.
 *
 * Without any timeout, a request that never answered held the engine's pull for good: a
 * fresh sign-in sat on "Copying your notes to this device…" until a reload, because every
 * later reason to pull — focus, the socket, the connection back — coalesces into the pull
 * in flight (seen in a new private window, 2026-10-08). Timed out, it is a failed pull,
 * which the engine retries.
 *
 * Aborted with its own error as the reason, so `request` rethrows that rather than calling
 * it offline: an answer that never came from a server whose health check passes is worth
 * seeing in the error reports, which drop an `OfflineError`. Connectivity is still asked
 * about, as `request` would for a fetch that failed. The route is the path without its
 * query, so the message reads the same for every page and groups as one.
 */
export async function fetchJson<T>(path: string, stop?: AbortSignal): Promise<T> {
  const route = path.replace(/\?.*$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new FeedTimeoutError(route)), FEED_TIMEOUT_MS);
  // The engine's stop, folded in by hand rather than with `AbortSignal.any`, which the
  // older WebViews the apps run in do not all have.
  const onStop = () => controller.abort(stop?.reason);
  if (stop?.aborted) onStop();
  else stop?.addEventListener('abort', onStop, { once: true });
  try {
    const res = await request(path, { signal: controller.signal });
    if (!res.ok) throw new ApiError(res.status, `${route} answered ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    if (controller.signal.aborted) {
      if (controller.signal.reason instanceof FeedTimeoutError) recheck();
      throw controller.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    stop?.removeEventListener('abort', onStop);
  }
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
    // Once the old rows are gone, not when the count moves: a read in between would
    // cache them again, and nothing would drop that answer (found in review).
    onTruncated: () => resetListeners.forEach((l) => l()),
    onError: reportPullFailure,
    onStall: (err) => reportError(err, 'error'),
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
  /*
   * The search index hears the same changes, by name: the notes that changed, and
   * whether more than their text did. Opened further down, once the outbox says whether
   * this tab leads; what changes before then is found by its first pass, which compares
   * everything.
   */
  let search: Searching | null = null;
  const subscriptions = [
    collections.notes.subscribeChanges((changes) => {
      const roots = rootsOfNoteChanges(changes);
      changed(roots);
      search?.sync.touch(changes.map((c) => String(c.key)), { textOnly: !roots.has('tags') });
    }),
    // A renamed field is read from its definition when a match is drawn; nothing indexed changes.
    collections.notebooks.subscribeChanges(everything),
    collections.tags.subscribeChanges(() => {
      everything();
      search?.sync.touch([]);
    }),
    collections.attachments.subscribeChanges(() => {
      everything();
      search?.sync.touchFiles();
    }),
  ];

  // What makes the engine pull. None of these is a timer: a device that is open and
  // idle costs nothing, and the socket is what carries another device's edit here. The
  // engine's own retry of a copy that is not whole is the one exception (`retry`).
  const pull = () => void engine.pull();
  const onVisible = () => {
    if (document.visibilityState === 'visible') pull();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', pull);
  const unsubscribeConnectivity = subscribeConnectivity(() => {
    if (offlineNow()) return;
    pull();
    // The text of files still wanted is fetched with a connection, so one returning is a reason to look.
    search?.sync.touchFiles();
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
  askToPersist();
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
  /*
   * Whole once a walk has finished — see `isWhole` for what that means and why. Not "the
   * last pull succeeded": a device opened on a plane never has one, and that is exactly
   * where someone looks to see their files are here (review of #236).
   *
   * One answer for everything that works over the library in the background — the
   * keeper of files and the search index — as is which tab does that work: the one that
   * holds the outbox.
   */
  const settled = () => isWhole(engine.state);
  const leading = () => outbox.executor.isOfflineEnabled;
  const keeper = createKeeper({
    userId,
    snapshot: () => ({ notes: rows.notes.values(), attachments: rows.attachments.values() }),
    settled,
    leading,
  });
  const stopKeeping = onLibraryChange((roots) => {
    if (roots.has('attachments')) keeper.nudge();
  });
  // And by every pull settling — the first copy finishing, or a pull failing offline with
  // the copy already whole — before which the keeper stands down.
  listeners.add(() => keeper.nudge());

  /*
   * The search index, in a file of its own, opened behind the library rather than
   * before it. It is a second worker and a second copy of the engine to start, and in a
   * second tab its file can be busy with the leading tab's write; none of that is
   * something the note list should wait for, and it did, on every cold start. So the
   * library is returned without it and `search` is filled in when it is ready; what
   * needs the index meanwhile waits on `searchReady`. Opening it can also fail where
   * opening the library did not — storage that filled between the two — and the library
   * is not failed by it. Its passes run in the tab the keeper's do, and wait for the
   * same thing: a library that is whole.
   *
   * `giveUp` ends an open still in hand when the library closes: a close is what a
   * sign-out waits on, and it has to wait for this, since a file being opened cannot be
   * removed.
   */
  const giveUp = new AbortController();
  /** The feed said reset before there was an index to tell; it is told when it opens. */
  let resetUnheard = false;
  const searchReady = (async () => {
    try {
      const index = new SearchIndex(await openSearchDatabase(userId, giveUp.signal));
      await index.ready();
      if (giveUp.signal.aborted) {
        await index.close().catch(() => {});
        return;
      }
      search = {
        index,
        sync: createSearchSync({
          index,
          snapshot: () => ({ notes: rows.notes.values(), notebooks: rows.notebooks.values(), tags: rows.tags.values(), attachments: rows.attachments.values() }),
          settled,
          leading,
          kept: () => readKeptNotebooks(userId),
          offline: offlineNow,
          fetchTexts: async (ids, signal) => {
            // A timeout as well as the signal: a request that never answers would otherwise hold the pass, and every pass after it.
            const res = await request('/api/attachments/texts', { method: 'POST', signal, timeout: 30_000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
            if (!res.ok) throw new ApiError(res.status, `/api/attachments/texts answered ${res.status}`);
            return (await res.json()) as AttachmentTexts;
          },
          isOffline: isOfflineError,
          channel: `unbent-search-${userId}`,
          onIndexed: notifySearchIndexed,
        }),
      };
      if (resetUnheard) search.sync.startOver();
    } catch (err) {
      if (!giveUp.signal.aborted) console.warn('[library] no search index on this device; searching needs a connection:', err);
    }
  })();
  // The walk finishing is what makes a library whole, and a notebook kept or released
  // changes which files' text is wanted; the index looks again at both.
  // A library that starts over takes its index with it: see `SearchSync.startOver`.
  listeners.add((state) => {
    if (state.phase !== 'reset') return search?.sync.wake();
    if (search) search.sync.startOver();
    else resetUnheard = true;
  });
  let keptNow = keeper.status().kept;
  const stopKeptWatch = keeper.subscribe((status) => {
    if (status.kept === keptNow) return;
    keptNow = status.kept;
    search?.sync.touchFiles();
  });

  return {
    ...collections,
    userId,
    engine,
    outbox,
    keeper,
    get search() {
      return search;
    },
    searchReady,
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
      stopKeptWatch();
      keeper.stop();
      giveUp.abort();
      await searchReady;
      await search?.sync.stop();
      await outbox.dispose();
      await engine.settled();
      for (const s of subscriptions) s.unsubscribe();
      if (collections) {
        await Promise.all(Object.values(collections).map((c) => c.cleanup()));
      }
      // After its sync has stopped: a pass in hand finishes its write, and the file is free for a wipe.
      await search?.index.close().catch(() => {});
      await closeLocalStore();
    },
  };
}
