import {
  queryOptions,
  infiniteQueryOptions,
  keepPreviousData,
  type QueryClient,
} from '@tanstack/react-query';
import type { AttachmentInfo, BackupsStatus, OperatorOrder, FieldDef, Note, NoteSort, NoteSummary, NotebookSummary, NotebookView } from '@unbent/shared';
import * as api from './notes-api.js';
import { ApiError, OfflineError } from './notes-api.js';
import { offlineNow } from './connectivity.js';
import { count, fieldSums, list, lookups, notebookFields, notebookFiles, notebookList, summaries, tagSummaries, toAttachmentInfo, toNote, viewList, type LocalAttachmentInfo, type Lookups, type Snapshot } from './store/derive.js';
import type { LocalNote } from './store/collections.js';
import { currentLibrary, onLibraryChange, onLibraryReset, onSearchIndexed, type ReadableLibrary as Library } from './store/library.js';
import { LIBRARY_ROOTS } from './store/library-roots.js';
import { onDirectWrite } from './store/actions.js';
import { searchLocal, type LocalCoverage } from './store/search-local.js';
import { isWhole, type FeedState } from './store/feed.js';

/**
 * Query definitions, colocated with their keys.
 *
 * Keys are defined once here rather than written at each call site, because an
 * invalidation only works if it names exactly the same key the query was stored under:
 * a mismatch fails silently, leaving stale data on screen with nothing to debug.
 *
 * Every key that varies by filter takes the filter as a structured object. React Query
 * hashes keys deterministically regardless of property order, so `{ notebook, tag }` and
 * `{ tag, notebook }` are the same entry.
 *
 * The notes, the trash, the counts, the tags, the notebooks, a notebook's fields and a
 * note's files are read from the local copy of the library (`store/`), not from the
 * API: each query function derives its answer from the collections, in the shape the
 * route used to answer with (`store/derive.ts`), so every component reads what it always
 * read and a warm open draws the list with no request. The change feed keeps the copy
 * current, and `installLibraryQueries` below re-runs these queries when it moves. What
 * still goes to the server is what the copy cannot answer: the instance's config, every
 * write (`store/actions.ts`), and search while there is a
 * connection, since the server holds every file's text and a device only some.
 */

/**
 * The open library, once its collections have restored what they persisted, or null
 * when this device has none: a browser without the origin-private file system, or one
 * refusing it in a private window, or a test. Every query below then asks the server
 * for what it would have derived, as the app did before the copy existed; nothing is
 * kept on the device, and nothing works offline, which is what such a browser had.
 *
 * Also null, for now, when there is a connection and the library is still opening after
 * `LIBRARY_READ_WAIT_MS`: the read goes to the server, and once the open lands every
 * library query is asked again and reads the copy (`rereadWhenOpen`). Offline the read
 * waits for the open, since the server is no answer then; so does a caller that has
 * already asked the server and had no answer (`patient`), which the connectivity state
 * may not know yet.
 */
async function library(patient = offlineNow()): Promise<Library | null> {
  const open = currentLibrary();
  if (!open) return null;
  let lib: Library | null;
  try {
    lib = patient ? await open : await openWithin(open, LIBRARY_READ_WAIT_MS);
  } catch {
    return null;
  }
  if (!lib) {
    rereadWhenOpen(open);
    return null;
  }
  await Promise.all([lib.notes.preload(), lib.notebooks.preload(), lib.tags.preload(), lib.attachments.preload(), lib.views.preload()]);
  return lib;
}

/**
 * How long a read waits for the library to open before asking the server instead.
 *
 * A warm open is milliseconds, so this is never felt on its own. What it is for is an
 * open that waits on another tab: a tab the browser has frozen (Chrome's Memory Saver, a
 * background tab on a phone) keeps the store's file locked in its worker and answers
 * nothing, and the open waits out `LIBRARY_OPEN_TIMEOUT_MS` before the library gives up.
 * Every read used to wait the same twenty seconds, and the note route's loader is one, so
 * a reload beside a frozen tab was a white page until the tab was closed or the twenty
 * seconds ran out; most people closed the tab first. Two seconds is a cold open on a
 * desktop with room to spare. A phone's cold open can take longer, and then reads the
 * server for its first screen, which is what the app did before the copy existed: the
 * list's page, the sidebar's tags, notebooks and counts, and the open note with its
 * files and fields, each a request and its rows read.
 */
const LIBRARY_READ_WAIT_MS = 2000;

/** The open, or null if it has not landed within `ms`; a refused open still throws. */
function openWithin(open: Promise<Library>, ms: number): Promise<Library | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  return Promise.race([open, late]).finally(() => clearTimeout(timer));
}

/**
 * What `installLibraryQueries` asks again with, and the opens already being waited for,
 * so that the reads which gave up on one open are asked again once, when it lands.
 * Nothing else would ask: a holder's open fires no change of its own, and the server's
 * answers would stay on screen until the feed next moved.
 *
 * Once its first pull has settled, not the moment it opens. A copy restored from the
 * device is as old as this device's last pull, and a note made elsewhere since is not in
 * it: read again then, a note the server had just drawn became "not found" under the
 * person's cursor (`notHeld`) until the pull brought it.
 */
let rereadAll: (() => void) | null = null;
const awaitedOpens = new WeakSet<Promise<Library>>();

function rereadWhenOpen(open: Promise<Library>): void {
  if (awaitedOpens.has(open)) return;
  awaitedOpens.add(open);
  open.then(
    (lib) => {
      const feed = lib as Library & { subscribe?: (listener: (state: FeedState) => void) => () => void };
      if (lib.state().phase !== 'starting' || !feed.subscribe) {
        rereadAll?.();
        return;
      }
      const stop = feed.subscribe((state) => {
        if (state.phase === 'starting') return;
        stop();
        rereadAll?.();
      });
    },
    () => {},
  );
}

/**
 * What every query derives from, computed once per version of the library: the rows as
 * arrays, the lookups over them, and each list that has been asked for, filtered and
 * sorted. The library's version changes with every change to any collection, so a read
 * between two changes finds all of this ready, and three pages of one list sort it once.
 * Summaries are not here: they are made for the page read, and `excerptOf` keeps each
 * row's excerpt for as long as the row is the same object.
 */
interface View {
  version: number;
  snapshot: Snapshot;
  lookups: Lookups;
  lists: Map<string, LocalNote[]>;
}

const views = new WeakMap<Library, View>();

function view(lib: Library): View {
  const version = lib.version();
  let v = views.get(lib);
  if (!v || v.version !== version) {
    const snapshot: Snapshot = {
      notes: [...lib.notes.values()],
      notebooks: [...lib.notebooks.values()],
      tags: [...lib.tags.values()],
      attachments: [...lib.attachments.values()],
      views: [...lib.views.values()],
    };
    v = { version, snapshot, lookups: lookups(snapshot), lists: new Map() };
    views.set(lib, v);
  }
  return v;
}

/** A list's rows, filtered and sorted, computed once per version of the library and per spelling of the filter. */
function rowsOf(lib: Library, filter: NoteFilter & { trashed?: boolean }, ordering: NoteOrdering): LocalNote[] {
  const v = view(lib);
  const key = JSON.stringify([filter, ordering]);
  let rows = v.lists.get(key);
  if (!rows) {
    rows = list(v.snapshot, filter, ordering, v.lookups);
    v.lists.set(key, rows);
  }
  return rows;
}

/** The rows a page of the list carries, the server's default. */
const PAGE = 50;

/**
 * Re-runs the library's queries whenever one of its collections changes: a feed page
 * applied, a write landing locally, a replay settling. One invalidation per change,
 * coalesced by the library, and the query functions read in-memory rows, so a change
 * is on screen on the next frame. Installed once, beside the client.
 *
 * And whenever a write was made as a request instead (on a device with no library, or
 * in a tab that does not hold the outbox), since there the same queries ask the server,
 * and nothing else would tell them a note was trashed or a title changed.
 */
export function installLibraryQueries(queryClient: QueryClient): () => void {
  const refetch = (roots: ReadonlySet<string>) => {
    void queryClient.invalidateQueries({ predicate: ({ queryKey }) => roots.has(String(queryKey[0])) });
  };
  const stopLibrary = onLibraryChange(refetch);
  const reread = () => refetch(LIBRARY_ROOTS);
  rereadAll = reread;
  // What the write reaches, as the library's own notices say (a view's write, the views).
  const stopDirect = onDirectWrite(refetch);
  /*
   * A reset is more than a change. The rows it brings can be older than a cached
   * answer, and an answer nobody is looking at is not refetched: it is handed, as it
   * stands, to the next view that mounts (a route loader's `ensureQueryData` serves
   * whatever is cached), and the note workspace seeds from it, then refuses the true,
   * older copy the refetch brings as a stale row (MAK-196). Answers with a view on them
   * are refetched by the change notifications the walk makes; the rest are dropped, so
   * the next mount reads the library afresh. Cheap: every one is derived from rows on
   * this device.
   */
  const stopReset = onLibraryReset(() => {
    queryClient.removeQueries({ type: 'inactive', predicate: ({ queryKey }) => LIBRARY_ROOTS.has(String(queryKey[0])) });
  });
  /*
   * A search answered on the device was answered from the index as it stood, and says
   * so: "still indexing", or without the text of some files. When the index gains
   * something, those answers (and only those; the server's are not the index's to
   * correct) are asked for again, so the line under the results stops being true of
   * a moment ago. Search is not a library root: a change to a note does not re-rank a
   * search, and the index is what a local answer reads, not the collections.
   */
  const stopIndexed = onSearchIndexed(() => {
    void queryClient.invalidateQueries({
      queryKey: ['search'],
      predicate: ({ state }) => (state.data as SearchAnswer | undefined)?.local !== undefined,
    });
  });
  return () => {
    stopLibrary();
    if (rereadAll === reread) rereadAll = null;
    stopDirect();
    stopReset();
    stopIndexed();
  };
}

export interface NoteFilter {
  notebook?: string;
  /**
   * Tags, ANDed. Order is not meaningful to the server but it is to the key hash, so
   * whatever builds this must produce a stable order for the same selection: otherwise
   * two spellings of one filter become two cache entries and the list refetches for a
   * change the user did not make. The URL is that order: it is where the filter lives.
   */
  tag?: string[];
  /**
   * Custom-field filters, ANDed, as the `<fieldId>:<op>[:<value>]` strings the URL and
   * the API both carry: kept as strings rather than parsed here for the same reason the
   * tags keep the URL's order: the key hash wants one spelling per filter, and the URL is
   * that spelling. `parseFieldFilter` reads one when a label is needed.
   */
  field?: string[];
  /** Inclusive `YYYY-MM-DD` bounds. A range narrows membership, so it is a filter. */
  from?: string;
  to?: string;
}

/**
 * Ordering for the note list.
 *
 * Kept out of `NoteFilter` because it is not a filter: it changes the order of a result
 * set, not its membership, and search results are ranked by relevance rather than sorted.
 */
export interface NoteOrdering {
  sort?: NoteSort;
  order?: 'asc' | 'desc';
  /** A custom field's id, which outranks `sort` (see the API's `listNotesQuerySchema`). */
  sortField?: string;
}

export const keys = {
  notes: (filter: NoteFilter, ordering: NoteOrdering = {}) =>
    ['notes', filter, ordering] as const,
  note: (id: string) => ['note', id] as const,
  attachments: (noteId: string) => ['attachments', noteId] as const,
  tags: () => ['tags'] as const,
  notebooks: () => ['notebooks'] as const,
  /**
   * Every saved view of the account, under a root of its own (`VIEW_ROOTS`): a view
   * saved or renamed reaches this and nothing else, and the notebook list, which every
   * save invalidates, does not take the views with it. One list rather than one per
   * notebook, since the rail draws every notebook's views at once and the whole set is
   * a few rows.
   */
  views: () => ['views'] as const,
  /**
   * Under its own root rather than `['notebooks', id]`: invalidating the notebook list
   * (which happens on every save) must not refetch every open notebook's definitions.
   */
  /**
   * What a notebook's files come to. Under `attachments`, the root a file arriving or
   * leaving reaches, and not under `notebooks`, which every save invalidates.
   */
  notebookFiles: (notebookId: string) => ['attachments', 'notebook', notebookId] as const,
  notebookFields: (notebookId: string) => ['notebook-fields', notebookId] as const,
  /**
   * The same definitions with each field's value count. Its own key under the one above,
   * so invalidating a notebook's fields reaches both, but a cached count-free entry can
   * never be served to the page that shows counts: its delete confirmation would then
   * name no notes.
   */
  notebookFieldCounts: (notebookId: string) => ['notebook-fields', notebookId, 'counts'] as const,
  trash: () => ['trash'] as const,
  trashCount: () => ['trash', 'count'] as const,
  /** Under `notes`, so the invalidations that root gets on every create and trash reach it. */
  noteCount: () => ['notes', 'count'] as const,
  /** Under `notes` like the count; `whole` is the feed's word on it, see `libraryTotalQuery`. */
  libraryTotal: (whole: boolean | null, enabled = true) => ['notes', 'library-total', { whole, enabled }] as const,
  /**
   * Under `trash` for the trash and `notes` for the rest, so the invalidations those roots
   * already get on every trash, restore, move and save reach these too.
   */
  exactCount: (filter: ExactCountFilter) =>
    filter.trashed ? (['trash', 'exact-count'] as const) : (['notes', 'exact-count', filter] as const),
  /** Under `notes`, so every write that can move a value reaches it, as the list's own key does. */
  fieldTotals: (filter: NoteFilter, fieldIds: readonly string[]) => ['notes', 'field-totals', filter, fieldIds] as const,
  search: (q: string, filter: NoteFilter = {}, rows = false) => ['search', q, filter, { rows }] as const,
  config: () => ['config'] as const,
  /** The account's plan (MAK-108), its own root: nothing a note write does changes it. */
  plan: () => ['plan'] as const,
  planUsage: () => ['plan', 'usage'] as const,
  autofillUsage: () => ['autofill', 'usage'] as const,
  /** The operator page's reads, under one root so an action can invalidate all of them at once. */
  operatorBackups: () => ['operator', 'backups'] as const,
  operatorAccounts: () => ['operator', 'accounts'] as const,
  operatorFeedback: () => ['operator', 'feedback'] as const,
  /** One search's pages of the list, under its key; an object, so no account id can be mistaken for it. */
  operatorAccountsList: (q: string, order: OperatorOrder = {}) => ['operator', 'accounts', { q, ...order }] as const,
  /** Under the list's key, so one invalidation refreshes the list and every account page. */
  operatorAccount: (userId: string) => ['operator', 'accounts', userId] as const,
  storeStats: (userId: string) => ['operator', 'stats', userId] as const,
  accountDumps: (userId: string) => ['operator', 'dumps', userId] as const,
  accountRestores: (userId: string) => ['operator', 'restores', userId] as const,
  /**
   * A note's history and one copy from it. Under a root of their own rather than
   * `['note', id]`: that key is set by hand on every save, and nothing about a save
   * should touch a list that is only looked at with the History sheet open.
   */
  revisions: (noteId: string) => ['revisions', noteId] as const,
  revision: (noteId: string, revisionId: number) => ['revisions', noteId, revisionId] as const,
};

/**
 * Live notes matching a filter, paged.
 *
 * `keepPreviousData`: changing the filter changes the key, and a fresh key has no data
 * until its request lands. Without this the list emptied for the duration and refilled,
 * which reads as a flash; with it the previous rows stay on screen, marked stale through
 * `isPlaceholderData` so the layout can dim them, and are replaced in one step. The
 * route's loader deliberately no longer waits for this query, so this is what carries the
 * list across the gap.
 */
export const notesQuery = (filter: NoteFilter, ordering: NoteOrdering = {}) =>
  infiniteQueryOptions({
    queryKey: keys.notes(filter, ordering),
    queryFn: async ({ pageParam }) => {
      const lib = await library();
      return lib
        ? pageOf(lib, filter, ordering, pageParam)
        : api.listNotes({ ...filter, ...ordering, ...(pageParam ? { cursor: pageParam } : {}) });
    },
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.cursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/**
 * One page of a list from the library: the whole list's rows, then the page cut from
 * them and only that page summarised. The cursor is the offset of the next page, which
 * is enough for rows that are all here; the server's keyset cursor existed for pages it
 * had to read from disk.
 */
function pageOf(lib: Library, filter: NoteFilter & { trashed?: boolean }, ordering: NoteOrdering, pageParam: string): api.NotePage {
  const rows = rowsOf(lib, filter, ordering);
  const from = pageParam ? Number(pageParam) : 0;
  const items = summaries(rows, from, PAGE, view(lib).lookups);
  const end = from + items.length;
  return { items, cursor: end < rows.length ? String(end) : null, total: from === 0 ? rows.length : null };
}

/**
 * What each named field adds up to over every note the filter matches, for the table's
 * totals: the whole list, not the pages loaded so far, since a total of the first fifty
 * rows under a heading that says "Total" would be wrong the moment there is a second page.
 *
 * From the library, as the list is, so it costs a pass over rows already in memory (the
 * same filtered list a page is cut from, cached per version; see `ordering`). `null` on a device with no
 * library: the server keeps no sums and the list is paged there, so the table totals the
 * rows it has only once it has them all (see `NotesLayout`).
 */
export const fieldTotalsQuery = (filter: NoteFilter, fieldIds: readonly string[], ordering: NoteOrdering = {}) =>
  queryOptions({
    queryKey: keys.fieldTotals(filter, fieldIds),
    queryFn: async (): Promise<Record<string, number> | null> => {
      const lib = await library();
      if (!lib) return null;
      // The list's own ordering, only so this reads the rows its pages are cut from, which
      // `rowsOf` keeps per version and per spelling: with `{}` a sorted table filtered the
      // notebook twice on every change. A sum does not depend on order, so the ordering
      // stays out of the key and a re-sort does not ask again for the same answer.
      return Object.fromEntries(fieldSums(rowsOf(lib, filter, ordering), new Set(fieldIds)));
    },
    enabled: fieldIds.length > 0,
    placeholderData: keepPreviousData,
  });

/** Trashed notes. Deliberately unfiltered: see the trash view in Notes. */
export const trashQuery = () =>
  infiniteQueryOptions({
    queryKey: keys.trash(),
    queryFn: async ({ pageParam }) => {
      const lib = await library();
      return lib
        ? pageOf(lib, { trashed: true }, {}, pageParam)
        : api.listNotes({ trashed: true, ...(pageParam ? { cursor: pageParam } : {}) });
    },
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.cursor ?? undefined,
  });

/**
 * How many notes are in the trash.
 *
 * Fetched even when not viewing the trash so the toggle can show a count: the trash is
 * then discoverable rather than something the user has to guess at. Only the total is
 * used, so this asks for a single row.
 */
export const trashCountQuery = () =>
  queryOptions({
    queryKey: keys.trashCount(),
    queryFn: async () => {
      const lib = await library();
      return lib ? count(view(lib).snapshot, { trashed: true }, view(lib).lookups) : ((await api.listNotes({ trashed: true, limit: 1 })).total ?? 0);
    },
  });

/**
 * How many live notes there are, from the stored counts, as `trashCountQuery` reads the
 * trash's. What a page shows before a confirmation asks for the exact number.
 */
export const noteCountQuery = () =>
  queryOptions({
    queryKey: keys.noteCount(),
    queryFn: async () => {
      const lib = await library();
      return lib ? count(view(lib).snapshot, {}, view(lib).lookups) : ((await api.listNotes({ limit: 1 })).total ?? 0);
    },
  });

/**
 * How many live notes the account holds, but only once that is known: null while the
 * library on this device is still arriving (opening, taking its first copy, or walking
 * again after a reset) when the rows it holds are not yet the account's.
 *
 * What the empty state reads (`useLibraryTotal`). `noteCountQuery` answers a count for a
 * page that only wants a number; this one answers whether the number is true, since "No
 * notes yet" over a library that is a page away from arriving is the wrong thing to tell
 * someone.
 *
 * Whether the library is whole is read here, from the library, in the same call that
 * counts its rows, so the two can never come from different moments. `whole` in the key
 * is the feed's state as the component last heard it: when it turns true the key changes
 * and the count is taken afresh, rather than a count from before the last page was
 * applied being read for one render as the answer. `gcTime: 0` so an entry nobody is
 * watching (the one from before a reset) is not there to be read when the key comes
 * back to it.
 *
 * A device with no library asks the server, whose count is always whole.
 *
 * `enabled` is the caller saying the answer matters right now (see `useLibraryTotal`).
 * It is in the key as well as the options, so a count left over from the last time the
 * answer mattered is never read when it starts to matter again: switched off, the query
 * watches an entry of its own that never runs, the enabled entry has no watcher and
 * `gcTime: 0` drops it, and switched back on the count is taken afresh. Left to the
 * options alone, a cached zero from an empty account could be read for the render before
 * the refetch landed, after the account had filled and emptied down to one note.
 */
export const libraryTotalQuery = (whole: boolean | null, enabled = true) =>
  queryOptions({
    queryKey: keys.libraryTotal(whole, enabled),
    enabled,
    queryFn: async (): Promise<number | null> => {
      const lib = await library();
      if (!lib) return (await api.listNotes({ limit: 1 })).total ?? 0;
      if (!isWhole(lib.state())) return null;
      return count(view(lib).snapshot, {}, view(lib).lookups);
    },
    gcTime: 0,
  });

/**
 * One note, by id.
 *
 * `retry: false` because a 404 here is an expected outcome, not a transient fault: note
 * ids arrive from shared links and reloads long after the note was deleted. Retrying
 * would delay the explanation the workspace shows.
 */
/**
 * A read of a note the local copy does not hold. A library that has never taken its
 * snapshot holds nothing yet, and a note not in it is not missing: the copy is. With a
 * connection the server answers for it, as it did before the copy existed: a link
 * followed during the first copy opens, and on a phone that copy can take minutes.
 * Without one, say so (the workspace's offline line) rather than that the note does not
 * exist. Once a snapshot has been taken, an id the copy does not hold gets the answer the
 * route gave for an id that is not a note. The writes in `store/actions.ts` draw the same
 * line (`firstCopy`), and the two must agree.
 */
function notHeld<T>(lib: Library, ask: () => Promise<T>): Promise<T> {
  if (lib.state().cursor === null) {
    if (!offlineNow()) return ask();
    throw new OfflineError();
  }
  throw new ApiError(404, 'Not found');
}

export const noteQuery = (id: string) =>
  queryOptions({
    queryKey: keys.note(id),
    queryFn: async (): Promise<Note> => {
      const lib = await library();
      if (!lib) return api.getNote(id);
      const row = lib.notes.get(id);
      if (!row) return notHeld(lib, () => api.getNote(id));
      return toNote(row, view(lib).lookups);
    },
    retry: false,
  });

/**
 * Files stored on a note. Independent of whether the markdown still links them:
 * that is what the attachments panel exists to surface.
 */
export const attachmentsQuery = (noteId: string) =>
  queryOptions({
    queryKey: keys.attachments(noteId),
    queryFn: async (): Promise<LocalAttachmentInfo[]> => {
      const lib = await library();
      if (!lib) return api.listAttachments(noteId);
      // A note opened from the server during the first copy has files too; a 404 here
      // hid every one of them (the PDF the note is) until the walk reached it.
      if (!lib.notes.has(noteId)) return notHeld(lib, () => api.listAttachments(noteId));
      return (view(lib).lookups.filesByNote.get(noteId) ?? []).map(toAttachmentInfo);
    },
  });

export const tagsQuery = () =>
  queryOptions({
    queryKey: keys.tags(),
    queryFn: async (): Promise<api.TagSummary[]> => {
      const lib = await library();
      return lib ? tagSummaries(view(lib).snapshot) : api.listTags();
    },
  });

/**
 * The instance's sign-in methods. Never stale: they change only with a redeploy, and a
 * login screen that refetched them on every mount would flash its buttons in.
 */
export const configQuery = () =>
  queryOptions({ queryKey: keys.config(), queryFn: () => api.getConfig(), staleTime: Infinity });

/**
 * The account's plan: trial, paid or lapsed, and what it holds against its quota
 * (MAK-108). A minute's staleness is right for it: a plan changes a few times a year,
 * and the moments it does (a checkout, a portal visit) invalidate it by hand. And it is
 * read again on focus, which the app turns off by default: a tab left open while the
 * plan changed on another device, or in Stripe's portal, should notice on the way back.
 * Only where the instance sells one: the caller passes `config.billing` as `enabled`,
 * since the route answers 404 everywhere else.
 */
export const planQuery = (enabled: boolean) =>
  queryOptions({ queryKey: keys.plan(), queryFn: () => api.getPlan(), staleTime: 60_000, refetchOnWindowFocus: true, enabled });

/**
 * The same, with what the account holds, which is a call to its store: under the plan's
 * key so a change to the plan invalidates both, and asked only by the Plan page, which
 * is the one place the figure is shown.
 */
export const planUsageQuery = (enabled: boolean) =>
  queryOptions({ queryKey: keys.planUsage(), queryFn: () => api.getPlan({ usage: true }), staleTime: 60_000, refetchOnWindowFocus: true, enabled });

/**
 * What Auto-fill has cost the account this year, for Maintenance. The server's alone: the
 * counter lives in the account's store and is in no feed. Read each time the page opens,
 * since a press a minute ago is the one someone came to see counted.
 */
export const autofillUsageQuery = () =>
  queryOptions({ queryKey: keys.autofillUsage(), queryFn: () => api.autofillUsage(), staleTime: 0 });

/**
 * A note's history, for the History sheet. One of the reads that goes to the server
 * rather than the local copy: the copies are kept there and nowhere else. Never fresh:
 * the sheet is opened to find what a write just replaced, and that write may have been
 * seconds ago, on another device or by an assistant.
 */
export const revisionsQuery = (noteId: string) =>
  queryOptions({ queryKey: keys.revisions(noteId), queryFn: () => api.listRevisions(noteId), staleTime: 0, gcTime: 0 });

/**
 * One copy, whole. A copy never changes once kept, so it is not asked for twice in one
 * opening of the sheet. Its `unfit` list does: that is worked out against the note and
 * its notebooks, tags and fields as they stand, so the sheet drops these when it closes
 * and reads them again the next time it opens.
 */
export const revisionQuery = (noteId: string, revisionId: number) =>
  queryOptions({
    queryKey: keys.revision(noteId, revisionId),
    queryFn: () => api.getRevision(noteId, revisionId),
    staleTime: Infinity,
  });

/**
 * Which user each cache currently holds rows for.
 *
 * Kept beside the client rather than in a variable of this module's own, so that a second
 * client (every test builds one) starts out owned by nobody instead of inheriting
 * whichever answer this module last happened to record.
 */
const cacheOwner = new WeakMap<QueryClient, string>();

/**
 * Hand the cache to whoever is signed in now, emptying it first if that is somebody new.
 *
 * Signing out leaves every row this cache holds (notes, tags, notebooks, counts) sitting
 * in memory. Nothing renders them, because the sign-in screen renders none of it. The next
 * person to sign in is where it becomes a bug: loaders resolve through `ensureQueryData`,
 * an entry younger than `staleTime` is served without asking the server, and so the first
 * paint of `/notes` was the previous user's list.
 *
 * The clearing is keyed on the user id, and happens on the way *in*, rather than in the
 * sign-out handler. Sign-out has nowhere good to stand: before the navigation to `/login`
 * the signed-in app is still mounted, so its observers see their queries vanish and
 * refetch with no cookie, 401ing into the screen the `/login` route was added to keep
 * quiet; after the navigation, the router has committed but React may not have unmounted
 * those observers yet, which is the same race with better odds. And sign-out is not the
 * only way one user follows another in a tab nobody reloaded: a session can expire, or be
 * ended from another tab, with nothing pressed here at all.
 *
 * An unchanged user id keeps its cache. Being served your own rows is not the leak, and
 * staleness already covers them, so signing out and back in stays as cheap as it was.
 *
 * `keys.config()` is spared. It describes the instance rather than the user, and it is
 * `staleTime: Infinity` precisely so that the sign-in screen does not flash its provider
 * buttons in, which is the screen mounted and observing it at the moment this runs.
 */
export function claimCacheFor(queryClient: QueryClient, userId: string | undefined): void {
  // The two ungated shells reach here without a session: `/login` before anyone has signed
  // in, and the app's WebView, which is never a second user arriving. Neither is evidence
  // that the cache has changed hands.
  if (!userId) return;
  if (cacheOwner.get(queryClient) === userId) return;
  cacheOwner.set(queryClient, userId);
  const [config] = keys.config();
  queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] !== config });
}

export const notebooksQuery = () =>
  queryOptions({
    queryKey: keys.notebooks(),
    queryFn: async (): Promise<{ notebooks: NotebookSummary[]; unfiled: number }> => {
      const lib = await library();
      return lib ? notebookList(view(lib).snapshot) : api.listNotebooks();
    },
  });

/**
 * Every saved view, by notebook then place (`viewList`). From the library like the
 * notebooks, and from the server only on a device with none, as every read here.
 *
 * Read from the two collections themselves rather than from `view(lib)`: a view's
 * change moves the library's version, and the cached snapshot would be rebuilt (every
 * note of an archive copied into arrays, its lookups and list cache thrown away) to list
 * a few rows. The notes queries rebuild it when they next need it, as they would anyway.
 */
export const viewsQuery = () =>
  queryOptions({
    queryKey: keys.views(),
    queryFn: async (): Promise<NotebookView[]> => {
      const lib = await library();
      return lib ? viewList({ notebooks: lib.notebooks.values(), views: lib.views.values() }) : (await api.listViews()).views;
    },
  });

/**
 * How many files a notebook holds and their size: what keeping it on this device costs.
 * Only from the library: a device without one cannot keep files, and never asks.
 */
export const notebookFilesQuery = (notebookId: string) =>
  queryOptions({
    queryKey: keys.notebookFiles(notebookId),
    queryFn: async (): Promise<{ files: number; bytes: number }> => {
      const lib = await library();
      return lib ? notebookFiles(view(lib).snapshot, notebookId) : { files: 0, bytes: 0 };
    },
  });

/** A notebook's definitions from the library, or the route's 404 for an id that is not a notebook. */
async function fieldsOf(notebookId: string, counts: boolean): Promise<FieldDef[]> {
  const lib = await library();
  if (!lib) return api.listNotebookFields(notebookId, counts ? { counts } : undefined);
  const fields = notebookFields(view(lib).snapshot, notebookId, counts);
  if (!fields) throw new ApiError(404, 'Not found');
  return fields;
}

/** A notebook's custom field definitions. Disabled, not errored, for an unfiled note. */
export const notebookFieldsQuery = (notebookId: string | undefined) =>
  queryOptions({
    queryKey: keys.notebookFields(notebookId ?? ''),
    queryFn: () => fieldsOf(notebookId!, false),
    enabled: notebookId !== undefined && notebookId !== '',
  });

/**
 * A notebook's field definitions with how many notes hold a value for each, for the page
 * that manages them. Everything else asks `notebookFieldsQuery`: counting reads every
 * stored value, and only this page shows the numbers.
 */
export const notebookFieldCountsQuery = (notebookId: string) =>
  queryOptions({
    queryKey: keys.notebookFieldCounts(notebookId),
    queryFn: () => fieldsOf(notebookId, true),
  });

/**
 * Full-text search.
 *
 * Enabled only for a non-empty query, so clearing the box returns to the plain list
 * rather than searching for nothing. Callers debounce the term before it reaches here.
 */
/**
 * Search scoped to the filters already applied to the list.
 *
 * The filter is part of the cache key: the same words inside two different notebooks are
 * two different result sets, and sharing one entry between them would serve the wrong one.
 */
/**
 * Refetches everything a note's arrival or departure changes.
 *
 * A note moving between the live list and the trash (created, trashed, restored, or
 * destroyed) silently changes the sidebar: the notebook it was filed in loses a note
 * from its count, its tags lose one from theirs, and the "Inbox" option appears or
 * disappears with the last unfiled note. None of that is derivable from the note list
 * alone, so each of these was previously left stale until something else happened to
 * refetch it.
 *
 * Callers pass whichever of the two list keys they need to await; the counts are
 * fire-and-forget, since nothing renders differently while they are in flight.
 */
export function invalidateNoteMembership(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: keys.tags() });
  void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
}

/**
 * Notes matching a search: any search, one letter included.
 *
 * One letter used to send nothing, with "Keep typing to search notes." in place of
 * results: a one-letter prefix was the costliest request on D1, which billed every row it
 * read. In the per-account store it costs what any page of results does: the rows-read
 * meter sees the fifty matches and their joins, not the index walk behind them (measured:
 * 502 rows for "t" and for a whole word on a three-thousand-note store). Without the cost
 * there was only the confusion left: a field that took a letter and showed nothing.
 *
 * `keepPreviousData` for the reason `notesQuery` has it, and more so: every settled pause
 * in typing is a new key, so without it the results vanished at each one and came back
 * when the request landed. The previous term's results stay instead, marked through
 * `isPlaceholderData` so the list can dim them.
 *
 * `rows` asks for each match's list row as well, for the table (see `searchNotes`).
 *
 * One key with and without a connection, so the answer from the device and the server's
 * are the same entry: when the connection returns, `installConnectivity` refetches what
 * was read while it was away, and the server's matches replace the device's in the rows
 * already on screen rather than in a list drawn again.
 */
export const searchQuery = (q: string, filter: NoteFilter = {}, rows = false) =>
  queryOptions({
    queryKey: keys.search(q, filter, rows),
    queryFn: ({ signal }) => search(q, filter, rows, signal),
    enabled: q.trim() !== '',
    placeholderData: keepPreviousData,
  });

/**
 * The notes changed most recently, newest first, for a picker that opens on them. From
 * the library like every list, so it opens with no connection; asked of the server only
 * on a device with no library.
 */
export async function recentNotes(limit: number): Promise<NoteSummary[]> {
  const ordering: NoteOrdering = { sort: 'updated', order: 'desc' };
  const lib = await library();
  if (!lib) return (await api.listNotes({ limit, ...ordering })).items;
  return summaries(rowsOf(lib, {}, ordering), 0, limit, view(lib).lookups);
}

/** A search's matches, and when the device answered rather than the server, what it could see. */
export interface SearchAnswer {
  results: api.SearchHit[];
  local?: LocalCoverage;
}

/**
 * One search box, two engines. With a connection the server answers, as it always has:
 * it holds every file's text and its index is never behind. Without one (the app knows
 * it is offline, or the request got no answer), the device's own index answers
 * (`store/search-local.ts`): the same queries on the same FTS5, over the library's rows,
 * and over the text of the files this device holds text for. The answer says which it
 * was (`local`), since a search that could not see every file must not read as "no
 * matches".
 *
 * A device with no index (no library, or its file would not open) has nothing to
 * answer with, and the search fails as offline, which the list says in its own words.
 */
export async function search(q: string, filter: NoteFilter = {}, rows = false, signal?: AbortSignal): Promise<SearchAnswer> {
  if (!offlineNow()) {
    try {
      return { results: await api.searchNotes(q, filter, rows) };
    } catch (err) {
      if (!api.isOfflineError(err)) throw err;
    }
  }
  // Patient: this is only reached once the server has had no answer, or the app knows it
  // is offline, so the device's index is the only answer there is.
  const lib = await library(true);
  /*
   * The index opens behind the library (`searchReady`), so a search made in the first
   * moments of a cold start waits for it rather than being told search needs a
   * connection: an answer nothing would ever come back to correct.
   */
  await lib?.searchReady;
  if (!lib?.search) throw new OfflineError();
  const v = view(lib);
  const answer = await searchLocal({ index: lib.search.index, snapshot: v.snapshot, lookups: v.lookups, query: q, filter, rows, signal });
  return { results: answer.results, local: answer.coverage };
}

/** One of the scopes a destructive action names a count for; empty means every live note. */
export interface ExactCountFilter {
  notebook?: string;
  tag?: string;
  trashed?: boolean;
}

/**
 * How many notes a scope holds, counted from the notes themselves.
 *
 * Every other count in the app is the one the server keeps as notes change (0023), which
 * is one row to read instead of one per note. This is for the number a destructive action
 * names before it runs ("Permanently delete 47 notes", "Its 12 notes will become
 * unfiled") where a stored count that had somehow drifted would be telling the user
 * something false at the moment they decide. Only the total is used, so it asks for one
 * row of the list.
 */
export const exactCountQuery = (filter: ExactCountFilter = {}) =>
  queryOptions({
    queryKey: keys.exactCount(filter),
    queryFn: async () => {
      const scope = {
        ...(filter.notebook ? { notebook: filter.notebook } : {}),
        ...(filter.tag ? { tag: [filter.tag] } : {}),
        ...(filter.trashed ? { trashed: true } : {}),
      };
      const lib = await library();
      return lib ? count(view(lib).snapshot, scope, view(lib).lookups) : ((await api.listNotes({ ...scope, limit: 1, exact: true })).total ?? 0);
    },
  });

/**
 * The backup's health, and whether this session is an operator's at all: the route
 * answers anyone else 404, and that answer is data here (`null`) rather than an
 * error. Told apart on purpose: an error is "could not ask" (offline, a 5xx), and a
 * query that cannot tell the two apart either asks every non-operator again on every
 * Settings mount or, with retries off, hides the tab from an operator for the rest of
 * the session over one lost request (both found in review). As data, "not an operator"
 * is kept for the whole session and never asked again; an answer for an operator goes
 * stale as any other, and a failure retries as any other.
 */
export const operatorBackupsQuery = () =>
  queryOptions({
    queryKey: keys.operatorBackups(),
    queryFn: async (): Promise<BackupsStatus | null> => {
      try {
        return await api.operatorBackups();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    staleTime: (q) => (q.state.data === null ? Infinity : 5 * 60 * 1000),
    gcTime: Infinity,
    // A page someone leaves open in a tab: the status file is rewritten hourly, and a
    // cron that stopped overnight must not still read "Healthy" in the morning. The
    // refetch re-renders the cards, so "3 hours ago" and the stale decision move with
    // it. Two R2 reads every five minutes while any Settings page is open, since the
    // tab's probe (`use-operator.ts`) observes this query too.
    refetchInterval: (q) => (q.state.data ? 5 * 60 * 1000 : false),
    refetchOnWindowFocus: true,
  });

/**
 * The operator's accounts, by email, narrowed to `q` when there is one (trimmed by the
 * caller, so a stray space is not a second key). `keepPreviousData` for the reason
 * `notesQuery` has it: each settled pause in the search field is a new key, and without
 * it the table emptied to "Reading the directory…" and refilled on every one.
 */
export const operatorAccountsQuery = (q = '', order: OperatorOrder = {}) =>
  infiniteQueryOptions({
    queryKey: keys.operatorAccountsList(q, order),
    queryFn: ({ pageParam }) => api.operatorAccountsPage(pageParam, q, order),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next ?? undefined,
    staleTime: 60 * 1000,
    // As the backups query: the directory's dump columns move every hour. A refetch
    // reads again the pages the operator has opened, one D1 read each.
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });

/**
 * The assistants' unread feedback (MAK-212). Refetched as the page's other reads are, so
 * a page left open picks up what came in, and after each dismiss or Undo, so a full page
 * fills from behind; the list keeps the rows it has touched (`FeedbackList`).
 */
export const operatorFeedbackQuery = () =>
  queryOptions({
    queryKey: keys.operatorFeedback(),
    queryFn: () => api.operatorFeedback(),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

/** One account's row, for its page; null is the route's 404, an id the directory does not hold live. */
export const operatorAccountQuery = (userId: string) =>
  queryOptions({
    queryKey: keys.operatorAccount(userId),
    queryFn: () => api.operatorAccount(userId),
    staleTime: 60 * 1000,
    // As the list: the dump facts move on the hour and the page may stay open.
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

/**
 * Fresh for a minute. `stats` counts every row of every table (hundreds of thousands
 * on an archive), so going list → account → list → account must not count them each
 * time. A minute costs nothing: every action invalidates this, and a confirm quotes its
 * own dry run's counts, not these.
 */
export const storeStatsQuery = (userId: string) =>
  queryOptions({ queryKey: keys.storeStats(userId), queryFn: () => api.storeStats(userId), staleTime: 60 * 1000 });

export const accountDumpsQuery = (userId: string) =>
  queryOptions({ queryKey: keys.accountDumps(userId), queryFn: () => api.accountDumps(userId), retry: false, staleTime: 0 });

/**
 * Fresh whenever the page mounts, and on focus: a second operator's wind-back must not
 * leave this page offering an undo from beneath it. Every action here invalidates it.
 */
export const accountRestoresQuery = (userId: string) =>
  queryOptions({ queryKey: keys.accountRestores(userId), queryFn: () => api.accountRestores(userId), staleTime: 0, refetchOnWindowFocus: true });
