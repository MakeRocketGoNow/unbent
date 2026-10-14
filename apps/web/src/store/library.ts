import type { AttachmentTexts } from '@unbent/shared';
import { ApiError, isOfflineError, request } from '../notes-api.js';
import { reportError } from '../report-error.js';
import { offlineNow, recheck, subscribeConnectivity } from '../connectivity.js';
import { openLocalStore, openSearchDatabase, closeLocalStore } from './db.js';
import { createCollections, cursorStore, type Collections, type LocalAttachment, type LocalNote } from './collections.js';
import { createOutbox, provideForwarder, provideLibrary, type Outbox } from './actions.js';
import { FeedEngine, isWhole, type FeedState } from './feed.js';
import { createKeeper, type Keeper } from './keep.js';
import { askToPersist, readKeptNotebooks } from './files.js';
import { SearchIndex } from './search-index.js';
import { createSearchSync, type SearchSync } from './search-sync.js';
import { holdLibrary, whenLibraryFree, type LibraryHold } from './library-lock.js';
import { attachClientLibrary, type ClientLibrary, type Rows } from './client-library.js';
import type { SearchReader } from './search-index.js';
import { openPort } from './library-channel.js';
import { serveLibrary, type Server } from './library-serve.js';
import { LIBRARY_ROOTS, rootsOfNoteChanges } from './library-roots.js';
import type { FeedNotebook, FeedTag } from '@unbent/shared';

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
  /** Never set on the holder's library; a client's says `true` (`client-library.ts`). */
  readonly remote?: false;
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

/**
 * What a reader of the library needs of it: the rows, the feed's state and the version —
 * and the search index, where there is one. The holder's library answers it from its
 * collections; a client tab's answers it from the rows the holder sent it
 * (`client-library.ts`), and a test's from collections in memory (`test-library.ts`).
 */
export interface ReadableLibrary {
  notes: Rows<LocalNote>;
  notebooks: Rows<FeedNotebook>;
  tags: Rows<FeedTag>;
  attachments: Rows<LocalAttachment>;
  state: () => FeedState;
  version: () => number;
  search?: { index: SearchReader; sync: { opened: (noteId: string) => Promise<void> } } | null;
  searchReady?: Promise<void>;
}

/** The library this tab holds, or the one it is a client of. */
export type AnyLibrary = Library | ClientLibrary;

/**
 * The account whose library this tab holds or is opening. `opened` is the open itself,
 * the queue's step; `library` is what callers are given, which is `opened` bounded by
 * `LIBRARY_OPEN_TIMEOUT_MS` — the same promise while the open is quick, a refusal after
 * the bound, and the library again once a slow open has finished (`acquireLibrary`).
 */
let current: { userId: string; library: Promise<AnyLibrary>; opened: Promise<AnyLibrary>; halt: () => void } | null = null;
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
    const lib = await current.library;
    // A client's writes are the holder's: `provideForwarder` below is its way.
    return lib.remote ? null : lib;
  } catch {
    return null;
  }
});

provideForwarder(async () => {
  if (forTests || !current) return null;
  try {
    const lib = await current.library;
    if (!lib.remote) return null;
    return Object.assign((name: Parameters<typeof lib.call>[0], args: unknown[]) => lib.call(name, args), { stillMine: () => current?.userId === lib.userId });
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
 * Another tab of this device holds the account's library and this one cannot join it:
 * a browser without BroadcastChannel, where there is no channel to be a client over. It
 * reads the server, as it did for any second tab before 2026-10-13.
 */
export class LibraryElsewhereError extends Error {
  constructor() {
    super('Another tab holds this account’s library');
    this.name = 'LibraryElsewhereError';
  }
}

/**
 * The account whose library another tab holds, while this tab is its client, or — in a
 * browser with no channel to be one over — reads the server: what Settings → Offline
 * says, with the way to bring the library here (`library-lock.ts`). `waiting` is the
 * request in the lock's queue, so this tab opens the library on its own when the holder
 * goes. `refusal` is only the no-channel case: what every ask for the library gets
 * meanwhile, one promise with its catch attached rather than a fresh rejection per
 * navigation. A client has a library to give instead.
 */
let elsewhere: { userId: string; waiting: AbortController; refusal?: Promise<never> } | null = null;

/** The account whose library another tab holds, or null; follows `subscribeLibrary`. */
export function libraryElsewhere(): string | null {
  return elsewhere?.userId ?? null;
}

/**
 * Takes the account's library from the tab that holds it: that tab closes its library
 * and stands aside, and this one opens it. The way out of a tab that holds the library
 * and is wedged on something it waits for, as much as of a window someone forgot. Not of
 * a tab the browser has frozen: its worker cannot hand the store's file over, so this
 * tab's open waits out its bound and reads the server until that tab is closed or
 * resumed, when the open finishes on its own.
 */
export function takeOverLibrary(): Promise<AnyLibrary> | undefined {
  const userId = elsewhere?.userId;
  if (!userId) return undefined;
  return openFor(userId, true);
}

/** Stops waiting for another tab's library, on any change to what this tab holds. */
function standDown(): void {
  if (!elsewhere) return;
  elsewhere.waiting.abort();
  elsewhere = null;
  // Settings → Offline follows this: a wipe heard from another tab clears it with no
  // library open, and `closeStep` tells the hooks only for a library.
  libraryChanged();
}

/**
 * Another tab holds the account's library: this one is its client (or, with no channel,
 * reads the server), says so, and waits in the lock's queue to open the library the
 * moment that tab lets go. Called from inside the open's step for a client, so the wait
 * covers the attach too; what it starts is a new step, which closes the client.
 */
function standAside(userId: string, refusal?: Promise<never>): void {
  standDown();
  const waiting = new AbortController();
  const entry: NonNullable<typeof elsewhere> = { userId, waiting };
  if (refusal) entry.refusal = refusal;
  elsewhere = entry;
  libraryChanged();
  // Only if nothing has changed what this tab holds since: a sign-out or another
  // account's sign-in meanwhile decides what is open, not the lock's queue.
  const asOf = generation;
  whenLibraryFree(userId, waiting.signal).then(
    async () => {
      if (elsewhere !== entry || generation !== asOf) return;
      elsewhere = null;
      // The lock first, and the client's close only with it in hand: every waiting
      // tab is woken when the holder goes, one after another, and all but one would
      // otherwise have closed a working client — dropping its rows and refusing its
      // calls — to find the lock taken and attach again from nothing (review of #354).
      // A tab that lost the race stays the client it is and waits again.
      const hold = await holdLibrary(userId);
      if (generation !== asOf) {
        hold?.release();
        return;
      }
      if (!hold) {
        standAside(userId);
        return;
      }
      void openFor(userId, false, hold).catch(() => {});
    },
    () => {},
  );
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
  // The library itself is waited for under the same `ms`: Sign out pressed while an open
  // is still inside its own bound would otherwise sit for that bound first, with nothing
  // said. A library that has not opened has no outbox to drain.
  const deadline = Date.now() + ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lib = await Promise.race([
    open.catch(() => null),
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms))),
  ]).finally(() => clearTimeout(timer));
  if (!lib || lib.outbox.status().pending === 0) return 0;
  await new Promise<void>((resolve) => {
    const left = setTimeout(done, Math.max(0, deadline - Date.now()));
    const stop = lib.outbox.subscribe((s) => {
      if (s.pending === 0) done();
    });
    function done() {
      clearTimeout(left);
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

/**
 * How long opening the library may take before the app stops waiting for it and reads
 * the server instead. A warm open is milliseconds; a first open on a phone fetches and
 * boots the persistence worker and restores the outbox, several seconds on a slow
 * connection. Twenty is several times that, and the cost of cutting a slow open off is
 * one page load that reads the server, where the cost of waiting is a status line and
 * nothing else for as long as this is (review of the first draft, which said a minute).
 */
export const LIBRARY_OPEN_TIMEOUT_MS = 20_000;

/** The library did not open in time; reported, since nothing on the device or the server would otherwise say. */
export class LibraryOpenTimeoutError extends Error {
  constructor() {
    super(`The library did not open within ${LIBRARY_OPEN_TIMEOUT_MS / 1000} s`);
    this.name = 'LibraryOpenTimeoutError';
  }
}

/**
 * The one queue every change to which library is open goes through: an open for an
 * account, the close of the one before it, the close a wipe or a refused session asks
 * for, the close the outbox asks for, the close and reopen after a page comes back from
 * the back/forward cache. Each is a step, and a step runs only once every step queued
 * before it has settled, however it settled. A path that is not a step cannot exist
 * here, since the store is only ever touched inside one; a new way to open or close the
 * library is a new call to `enqueue`, and nothing else.
 *
 * Two designs were tried and rejected. A chain of closes that each open waited on, kept
 * by hand: every open or close added later had to be added to it too, and the ones
 * that were missed raced the store. A queue that gave up on a slow open, tore down what
 * it had built and barred the account until the teardown was done: the teardown was one
 * more thing beside the queue, and the bar was either too wide (every account) or absent
 * (a fresh wait on every click). So a step is never abandoned; it runs to its end, and
 * what is bounded is what a caller sees — an open answers within
 * `LIBRARY_OPEN_TIMEOUT_MS` whatever the queue is doing, and a wipe waits on the queue
 * for a bounded time (`closeLocalStores`) — with the page reading the server meanwhile.
 *
 * A step that never settles — an open held by another tab's queued delete of the
 * outbox, or by a leader that is not running — holds the steps after it until a reload.
 * What it holds besides is the store's file and the outbox's connection, and nothing
 * live: the moment a close or a switch takes its entry, the open's engine, socket and
 * listeners are halted (`halt` in `open`), since a bounded wipe lets a sign-out move on
 * past such an open, and an engine left pulling would pull the next person's feed into
 * the old account's file.
 */
let queue: Promise<void> = Promise.resolve();

/**
 * Moves whenever which library this tab holds changes: an open for an account, or a
 * close. What a reopen queued earlier checks before it opens, since a close is now a
 * step that can wait behind a stuck open for as long as that open hangs, and a sign-out
 * or another account's sign-in may have happened meanwhile (`onPageShow` in `open`).
 */
let generation = 0;

function enqueue<T>(step: () => Promise<T>): Promise<T> {
  const run = queue.then(step);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * What a close or a switch uses to halt an open's engine and socket before the step
 * ends: a signal, so a halt asked for while the open is still booting the store — a
 * sign-out pressed during a cold open on a phone — is honoured when the open arms the
 * handle rather than dropped. A slot the open filled later dropped it, and the open went
 * on to start the engine and socket the halt was for. The open checks the signal when it
 * has something to halt, and listens from then on.
 */
type Halting = AbortSignal;

/**
 * The account's library for this tab: the one it holds, the one it is a client of, or
 * the open of either. Asked on every navigation (`hand-over.ts`), so what is already
 * current is answered as it stands.
 */
export function acquireLibrary(userId: string, options: { takeOver?: boolean } = {}): Promise<AnyLibrary> {
  if (current?.userId === userId && !options.takeOver) return current.library;
  // Another tab holds it, this one cannot join it, and nobody asked to take it: the
  // same refusal as last time.
  if (!options.takeOver && elsewhere?.userId === userId && elsewhere.refusal) return elsewhere.refusal;
  return openFor(userId, options.takeOver ?? false);
}

/**
 * The hooks a client library tells this module through: the same listeners the holder's
 * library fires, and the one thing a client decides for itself — that its holder has
 * gone silent, on which it takes the library over, if it is still this tab's library.
 */
const clientHooks = (userId: string, isMine: () => boolean, deadline: number) => {
  // The attach's own deadline, until the first attach: a takeover on unanswered hellos
  // is the same ask continued, and a frozen holder's file keeps the open waiting just
  // as its silence kept the attach, so the caller is refused at the bound it was
  // promised and not the hellos' six seconds later. A takeover from a holder that went
  // quiet after serving — pings unanswered with a call in hand, or no holder since the
  // last one closed — is a new ask, made minutes or hours later, and gets a bound of
  // its own: under the attach's it was refused at once, reported as a timeout, and the
  // save it was for went out as a plain request (review of #358, twice). A hello
  // takeover can itself come after the attach's bound — `opening` after `opening`, then
  // silence, with the backoff grown to thirty seconds — and is then refused at once, as
  // its callers already were; `reportError` says each message once a page, so that is
  // not a second report.
  let inherited: number | undefined = deadline;
  return {
    onChange: (roots: ReadonlySet<string>) => changeListeners.forEach((l) => l(roots)),
    onAttached: () => {
      inherited = undefined;
      changeListeners.forEach((l) => l(LIBRARY_ROOTS));
    },
    onReset: () => resetListeners.forEach((l) => l()),
    onIndexed: () => indexedListeners.forEach((l) => l()),
    onSilent: () => {
      if (isMine()) void openFor(userId, true, undefined, inherited).catch(() => {});
    },
  };
};

/**
 * Tells the account's other tabs that this one has the lock and is opening the library:
 * once at the start, and again in answer to every hello until the open has settled. A
 * client waiting for a holder takes the library over from a tab that answers nothing
 * (`UNANSWERED_HELLOS` in `client-library.ts`), and an open on a phone takes longer than
 * that silence; a single announcement was not enough, since a client whose attach began
 * after it never heard it, and one that did ran out of patience on the hellos after it
 * (review of #358), and a live open stolen from mid-way steals back once it has
 * finished. So "answers nothing" means exactly that. A port of its own, since the
 * holder's is made inside `open` with its id, and closed by the returned function when
 * the open settles or the hold is taken: `open` resolves only after the holder has begun
 * serving, so the two never overlap. A tab wedged inside its open keeps answering, and
 * its clients wait out the bound as they did before, which is what Open here is for.
 */
function announceOpening(userId: string): () => void {
  const port = openPort(userId);
  if (!port) return () => {};
  const holder = crypto.randomUUID();
  const say = () => port.post({ type: 'opening', holder });
  say();
  const stop = port.listen((m) => {
    if (m.type === 'hello') say();
  });
  return () => {
    stop();
    port.close();
  };
}

/**
 * Opens the account's library in this tab as a step on the queue, closing whatever was
 * current first — another account's library, or this account's client library when the
 * holder has gone (`standAside`) or Open here was pressed (`takeOver`). Holds the
 * lock when it can; otherwise attaches to the tab that holds it, as its client.
 */
function openFor(userId: string, takeOver: boolean, held?: LibraryHold, inherited?: number): Promise<AnyLibrary> {
  const deadline = inherited ?? Date.now() + LIBRARY_OPEN_TIMEOUT_MS;
  standDown();
  generation += 1;
  const previous = current;
  previous?.halt();
  const halting = new AbortController();
  const opened: Promise<AnyLibrary> = enqueue(async () => {
    // The account before this one, closed first; what it was told is the queue's.
    if (previous) await previous.opened.then((l) => l.close()).catch(() => {});
    // One tab holds an account's library (`library-lock.ts`): this one, or another, in
    // which case this tab is that one's client — or, with no channel to be one over,
    // reads the server.
    const hold = held ?? (await holdLibrary(userId, takeOver));
    if (!hold) {
      // A close or a switch took this entry while the step waited: that decided what is
      // open, and this tab must not join the lock's queue for an account it has left.
      if (halting.signal.aborted) throw new DOMException('The open was halted before it attached', 'AbortError');
      const me = crypto.randomUUID();
      const port = openPort(userId, me);
      if (!port) throw new LibraryElsewhereError();
      // In the lock's queue from now, not from the attach: the holder may be a page on
      // its way out — this tab's own previous page, on a reload — whose lock is let go a
      // moment after this ask found it held, and nobody would answer hello. The queue
      // then gives this tab the library, and the open that follows closes this attach.
      standAside(userId);
      return attachClientLibrary(userId, me, port, clientHooks(userId, () => current?.opened === opened, deadline), halting.signal);
    }
    const quiet = announceOpening(userId);
    void hold.taken.then(quiet);
    try {
      // Whether the library this open makes is still the one this tab holds: the
      // entry's own step, which the late-finish replacement of the entry copies. Not the
      // account — a reopen after a back/forward-cache restore, or a slow open finishing
      // late, is the same account's and a different library.
      return await open(userId, halting.signal, () => current?.opened === opened, hold);
    } catch (err) {
      hold.release();
      throw err;
    } finally {
      quiet();
    }
  });
  /*
   * Bounded, so the app is never dead on a storage wedge: an open can wait for good on
   * things outside this tab (`store/wipe.ts`), and before this it did, with every screen
   * on "Opening your notes…". Past the bound the caller is refused and the error
   * reported; the queries read the server, which is the app as it is on a device that
   * cannot keep a copy. The open itself goes on (see `queue`) and stays the account's
   * entry, so every later ask — the root `beforeLoad` asks on every navigation — is
   * answered at once with the same refusal, and if it does finish it is the library from
   * then on, with the hooks told. The deadline is `LIBRARY_OPEN_TIMEOUT_MS` from now, or
   * the one a client's takeover inherited from its attach (`clientHooks`).
   */
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LibraryOpenTimeoutError()), Math.max(0, deadline - Date.now()));
  });
  const library = Promise.race([opened, timeout]).finally(() => clearTimeout(timer));
  const entry = { userId, library, opened, halt: () => halting.abort() };
  current = entry;
  libraryChanged();
  let late = false;
  library.catch((err: unknown) => {
    if (err instanceof LibraryOpenTimeoutError) {
      late = true;
      reportError(err, 'error');
      return;
    }
    if (current === entry) {
      current = null;
      libraryChanged();
    }
    if (err instanceof LibraryElsewhereError) {
      // Not a fault: Settings → Offline says so, and this tab opens the library when
      // the holding tab lets go, or when asked to take it over.
      console.info('[library] another tab holds this account’s library and there is no channel to join it over; reading from the server until it lets go');
      standAside(userId, library as Promise<never>);
      return;
    }
    // A client's attach halted by a close or a switch: that decided what is open.
    if (err instanceof DOMException && err.name === 'AbortError') return;
    // A browser without the origin-private file system, or one refusing it in a private
    // window: there is no local copy here, and the queries read the server instead (see
    // `queries.ts`). Said once in the console; the next sign-in tries again.
    console.warn('[library] not available on this device; reading from the server instead:', err);
  });
  opened.then(
    (lib) => {
      if (late && current === entry) {
        current = { ...entry, library: Promise.resolve(lib) };
        libraryChanged();
      }
    },
    () => {
      // Failed after its caller was refused: the entry is no longer anyone's; the next sign-in tries again.
      if (late && current === entry) {
        current = null;
        libraryChanged();
      }
    },
  );
  return library;
}

/** For tests: forgets what is open and every step still queued, as a reload would. */
export function resetLibraryForTests(): void {
  standDown();
  current = null;
  queue = Promise.resolve();
}

/** The close of what is open now, if anything, as a step: the library's close, then whatever `then` adds. */
function closeStep(then?: () => Promise<void>): Promise<void> {
  generation += 1;
  // A tab waiting for another's library stops: a sign-out or a switch decides what is
  // open, not the lock's queue.
  standDown();
  const open = current;
  current = null;
  if (open) {
    libraryChanged();
    // At once, not in the step: the step may be a long way behind a stuck open.
    open.halt();
  }
  return enqueue(async () => {
    // The open itself, not the bounded answer its callers were given: an open its caller
    // was refused is still a library once it finishes, and this step runs after it has.
    // One the device refused was never built; there is nothing to close.
    if (open) await open.opened.then((l) => l.close()).catch(() => {});
    await then?.();
  });
}

/** Closes the open library, if any, before the store is closed or wiped. Waits for every step queued before it. */
export function closeLibrary(): Promise<void> {
  return closeStep();
}

/**
 * Closes the open library and then the store, in one step. What a wipe does
 * (`closeLocalStores`). One step rather than `closeLibrary` then `closeLocalStore` from
 * the caller: an open queued behind the library's close would otherwise run between the
 * two, take a fresh store from `db.ts`, and have it closed under it by the store close
 * that ran next.
 */
export function closeLibraryAndStore(): Promise<void> {
  return closeStep(closeLocalStore);
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

async function open(userId: string, halting: Halting, isMine: () => boolean, hold: LibraryHold): Promise<Library> {
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
    onTruncated: () => {
      resetListeners.forEach((l) => l());
      server?.reset();
    },
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
  /** The account's other tabs, served from here once the library is built (`library-serve.ts`). */
  let server: Server | null = null;
  /*
   * `includeInitialState: false`, spelled out. Left unset, a subscription reports only
   * the rows it has emitted before: a tombstone for a note that had not changed since
   * the library opened — purged on another device, say — was dropped, so the list kept
   * the note until something else moved it, and an update of such a row arrived as an
   * insert, which reaches every query (`rootsOfNoteChanges`) rather than the note's own.
   * `true` would fix both by emitting every row at open, which `rootsOfNoteChanges` would
   * then walk for nothing (`library-serve.ts` takes that, since it emits to nobody);
   * `false` marks the state as seen without emitting it, which is what is wanted here.
   */
  const every = { includeInitialState: false } as const;
  const subscriptions = [
    collections.notes.subscribeChanges((changes) => {
      const roots = rootsOfNoteChanges(changes);
      changed(roots);
      search?.sync.touch(changes.map((c) => String(c.key)), { textOnly: !roots.has('tags') });
    }, every),
    // A renamed field is read from its definition when a match is drawn; nothing indexed changes.
    collections.notebooks.subscribeChanges(everything, every),
    collections.tags.subscribeChanges(() => {
      everything();
      search?.sync.touch([]);
    }, every),
    collections.attachments.subscribeChanges(() => {
      everything();
      search?.sync.touchFiles();
    }, every),
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
    const closing = closeLibrary();
    const asOf = generation;
    void closing
      .then(() => {
        // Only if nothing has changed what this tab holds since: the close is a step
        // that can wait behind a stuck open, and a sign-out or another account's
        // sign-in meanwhile decides what is open, not this. Reopened regardless, a
        // sign-out's wipe had its store file made anew, and another account's library
        // was closed and this one opened in its place.
        if (generation === asOf) return acquireLibrary(userId);
        return undefined;
      })
      .catch(() => {});
  };
  window.addEventListener('pageshow', onPageShow);

  const outbox = createOutbox(userId, { ...collections, userId, engine }, {
    // Another tab is wiping this device's copies, or a newer deploy there is opening
    // the outbox at a newer version: this library goes with its outbox, keeping every
    // file, as `closeLocalStores` does for a refused session. This library only, by
    // identity (`isMine`): neither a later account's open nor this account's own
    // reopen is this outbox's to close. Said in the console, since the second case
    // closes a library mid-session with nothing else to show for it, and its reopen on
    // the next navigation fails at the old version.
    onAskedToClose: () => {
      if (!isMine()) return;
      console.warn('[library] closed: another tab deleted this account’s outbox or opened it at a newer version');
      void closeLibrary();
    },
  });

  /**
   * Stops what no caller can use any more: the engine's pulls, the socket and the
   * listeners that make it pull, and the reopen after a back/forward-cache restore. Run
   * by the close or the switch that takes this library's entry, at once, and again as
   * the first thing `close` does. Not the store, the outbox or the collections, which
   * stay the step's: a bounded wipe lets a sign-out move on past an open that is stuck
   * below, and an engine left running would go on pulling with whatever cookie the tab
   * has next, into a file named for this account.
   */
  let halted = false;
  const halt = () => {
    if (halted) return;
    halted = true;
    closed = true;
    server?.stop();
    engine.stop();
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', pull);
    unsubscribeConnectivity();
    if (reconnect) clearTimeout(reconnect);
    socket?.close();
  };
  // Nothing awaits between the store opening and here, so a halt asked for meanwhile
  // closes the socket before its `open` event could pull.
  if (halting.aborted) halt();
  else halting.addEventListener('abort', halt, { once: true });

  /*
   * Another tab took the library over (`takeOverLibrary` there): this library closes,
   * and this tab attaches to that one as its client, waiting its turn in the lock's
   * queue. Only while it is still this tab's library: a close or a switch that already
   * took its entry has decided for it.
   */
  void hold.taken.then(() => {
    if (!isMine()) return;
    console.info('[library] another tab took this account’s library over; this tab is its client until it lets go');
    const closing = closeLibrary();
    // The close is a step that can wait; a sign-out or another account's sign-in
    // meanwhile decides what this tab holds, and opening for the old account would
    // bring its library back when the other tab let go. The open finds the lock held
    // and attaches to the tab that took it.
    const asOf = generation;
    void closing.then(() => {
      if (generation === asOf) void openFor(userId, false).catch(() => {});
    });
  });

  /*
   * The one wait in here that can wedge — the outbox's database held by another tab's
   * queued delete (`store/wipe.ts`) — and so the one that can hold this step, and the
   * queue behind it, for good. Not given up on: a step runs to its end (see `queue`),
   * and what `acquireLibrary` bounds is its caller's wait, not this. Before the keeper
   * and the search index are started, so an open stuck here holds the store and this
   * connection and nothing else.
   */
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
          onIndexed: () => {
            notifySearchIndexed();
            server?.indexed();
          },
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

  /*
   * The account's other tabs on this device are this library's clients
   * (`library-channel.ts`): from here on, the rows, the feed's state and the two
   * statuses go to them as they move, and their writes come here to be queued. Started
   * last, once the outbox is ready, so nothing a client asks for finds the library
   * half built; a client that said hello before this hears `serving` and asks again.
   * Stopped by `halt`, at once, so a client waits for the next holder rather than on a
   * library that is being closed.
   */
  const holderId = crypto.randomUUID();
  const port = openPort(userId, holderId);
  if (port && !halted) {
    server = serveLibrary(
      port,
      {
      collections,
      state: () => latest ?? engine.state,
      onState: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      outbox,
      keeper,
      search: () => search,
      searchReady,
      },
      holderId,
    );
  }

  const close = async () => {
    halt();
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
    port?.close();
    // Last, once the file is let go: the next tab in the queue opens the store on its own.
    hold.release();
  };

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
    close,
  };
}
