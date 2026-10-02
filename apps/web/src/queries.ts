import {
  queryOptions,
  infiniteQueryOptions,
  keepPreviousData,
  type QueryClient,
} from '@tanstack/react-query';
import type { AttachmentInfo, FieldDef, Note, NoteSort, NoteSummary, NotebookSummary } from '@unbent/shared';
import * as api from './notes-api.js';
import { ApiError, OfflineError } from './notes-api.js';
import { count, list, lookups, notebookFields, notebookList, tagSummaries, toAttachmentInfo, toNote, type Snapshot } from './store/derive.js';
import { currentLibrary, onLibraryChange, type ReadableLibrary as Library } from './store/library.js';
import { onDirectWrite } from './store/actions.js';

/**
 * Query definitions, colocated with their keys.
 *
 * Keys are defined once here rather than written at each call site, because an
 * invalidation only works if it names exactly the same key the query was stored under —
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
 * still goes to the server is what the copy cannot answer: search, the instance's
 * config, the vision backlog, and every write (`store/actions.ts`).
 */

/**
 * The open library, once its collections have restored what they persisted — or null
 * when this device has none: a browser without the origin-private file system, or one
 * refusing it in a private window, or a test. Every query below then asks the server
 * for what it would have derived, as the app did before the copy existed; nothing is
 * kept on the device, and nothing works offline, which is what such a browser had.
 */
async function library(): Promise<Library | null> {
  const open = currentLibrary();
  if (!open) return null;
  let lib: Library;
  try {
    lib = await open;
  } catch {
    return null;
  }
  await Promise.all([lib.notes.preload(), lib.notebooks.preload(), lib.tags.preload(), lib.attachments.preload()]);
  return lib;
}

function snapshot(lib: Library): Snapshot {
  return { notes: lib.notes.values(), notebooks: lib.notebooks.values(), tags: lib.tags.values(), attachments: lib.attachments.values() };
}

/** The rows a page of the list carries, the server's default. */
const PAGE = 50;

/**
 * Re-runs the library's queries whenever one of its collections changes: a feed page
 * applied, a write landing locally, a replay settling. One invalidation per change,
 * coalesced by the library, and the query functions read in-memory rows, so a change
 * is on screen on the next frame. Installed once, beside the client.
 *
 * And whenever a write was made as a request instead — on a device with no library, or
 * in a tab that does not hold the outbox — since there the same queries ask the server,
 * and nothing else would tell them a note was trashed or a title changed.
 */
export function installLibraryQueries(queryClient: QueryClient): () => void {
  const roots = new Set(['notes', 'note', 'trash', 'tags', 'notebooks', 'notebook-fields', 'attachments']);
  const refetch = () => {
    void queryClient.invalidateQueries({ predicate: ({ queryKey }) => roots.has(String(queryKey[0])) });
  };
  const stopLibrary = onLibraryChange(refetch);
  const stopDirect = onDirectWrite(refetch);
  return () => {
    stopLibrary();
    stopDirect();
  };
}

export interface NoteFilter {
  notebook?: string;
  /**
   * Tags, ANDed. Order is not meaningful to the server but it is to the key hash, so
   * whatever builds this must produce a stable order for the same selection — otherwise
   * two spellings of one filter become two cache entries and the list refetches for a
   * change the user did not make. The URL is that order: it is where the filter lives.
   */
  tag?: string[];
  /**
   * Custom-field filters, ANDed, as the `<fieldId>:<op>[:<value>]` strings the URL and
   * the API both carry — kept as strings rather than parsed here for the same reason the
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
  /** A custom field's id, which outranks `sort` — see the API's `listNotesQuerySchema`. */
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
   * Under its own root rather than `['notebooks', id]`: invalidating the notebook list
   * (which happens on every save) must not refetch every open notebook's definitions.
   */
  notebookFields: (notebookId: string) => ['notebook-fields', notebookId] as const,
  /**
   * The same definitions with each field's value count. Its own key under the one above,
   * so invalidating a notebook's fields reaches both, but a cached count-free entry can
   * never be served to the page that shows counts — its delete confirmation would then
   * name no notes.
   */
  notebookFieldCounts: (notebookId: string) => ['notebook-fields', notebookId, 'counts'] as const,
  trash: () => ['trash'] as const,
  trashCount: () => ['trash', 'count'] as const,
  /** Under `notes`, so the invalidations that root gets on every create and trash reach it. */
  noteCount: () => ['notes', 'count'] as const,
  /**
   * Under `trash` for the trash and `notes` for the rest, so the invalidations those roots
   * already get on every trash, restore, move and save reach these too.
   */
  exactCount: (filter: ExactCountFilter) =>
    filter.trashed ? (['trash', 'exact-count'] as const) : (['notes', 'exact-count', filter] as const),
  search: (q: string, filter: NoteFilter = {}, rows = false) => ['search', q, filter, { rows }] as const,
  config: () => ['config'] as const,
  pendingImages: () => ['pending-images'] as const,
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
 * One page of a list from the library: the whole list derived, then the page cut from
 * it. The cursor is the offset of the next page, which is enough for rows that are all
 * here; the server's keyset cursor existed for pages it had to read from disk.
 */
function pageOf(lib: Library, filter: NoteFilter & { trashed?: boolean }, ordering: NoteOrdering, pageParam: string): api.NotePage {
  const rows = list(snapshot(lib), filter, ordering);
  const from = pageParam ? Number(pageParam) : 0;
  const items = rows.slice(from, from + PAGE);
  const end = from + items.length;
  return { items, cursor: end < rows.length ? String(end) : null, total: from === 0 ? rows.length : null };
}

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
 * Fetched even when not viewing the trash so the toggle can show a count — the trash is
 * then discoverable rather than something the user has to guess at. Only the total is
 * used, so this asks for a single row.
 */
export const trashCountQuery = () =>
  queryOptions({
    queryKey: keys.trashCount(),
    queryFn: async () => {
      const lib = await library();
      return lib ? count(snapshot(lib), { trashed: true }) : ((await api.listNotes({ trashed: true, limit: 1 })).total ?? 0);
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
      return lib ? count(snapshot(lib), {}) : ((await api.listNotes({ limit: 1 })).total ?? 0);
    },
  });

/**
 * One note, by id.
 *
 * `retry: false` because a 404 here is an expected outcome, not a transient fault: note
 * ids arrive from shared links and reloads long after the note was deleted. Retrying
 * would delay the explanation the workspace shows.
 */
export const noteQuery = (id: string) =>
  queryOptions({
    queryKey: keys.note(id),
    queryFn: async (): Promise<Note> => {
      const lib = await library();
      if (!lib) return api.getNote(id);
      const row = lib.notes.get(id);
      // A library that has never taken its snapshot holds nothing yet, and a note not in
      // it is not missing — the copy is: say that (the workspace's offline line) rather
      // than that the note does not exist. Once a snapshot has been taken, an id the
      // copy does not hold gets the answer the route gave for an id that is not a note.
      if (!row && lib.state().cursor === null) throw new OfflineError();
      if (!row) throw new ApiError(404, 'Not found');
      return toNote(row, lookups(snapshot(lib)));
    },
    retry: false,
  });

/**
 * Files stored on a note. Independent of whether the markdown still links them —
 * that is what the attachments panel exists to surface.
 */
export const attachmentsQuery = (noteId: string) =>
  queryOptions({
    queryKey: keys.attachments(noteId),
    queryFn: async (): Promise<AttachmentInfo[]> => {
      const lib = await library();
      if (!lib) return api.listAttachments(noteId);
      if (!lib.notes.has(noteId)) throw new ApiError(404, 'Not found');
      return (lookups(snapshot(lib)).filesByNote.get(noteId) ?? []).map(toAttachmentInfo);
    },
  });

export const tagsQuery = () =>
  queryOptions({
    queryKey: keys.tags(),
    queryFn: async (): Promise<api.TagSummary[]> => {
      const lib = await library();
      return lib ? tagSummaries(snapshot(lib)) : api.listTags();
    },
  });

/**
 * The instance's sign-in methods. Never stale: they change only with a redeploy, and a
 * login screen that refetched them on every mount would flash its buttons in.
 */
export const configQuery = () =>
  queryOptions({ queryKey: keys.config(), queryFn: () => api.getConfig(), staleTime: Infinity });

/**
 * How many files wait for the vision model — the count on Maintenance's button.
 *
 * Never considered fresh, because what changes it runs outside the panel: a pass started
 * here keeps going after the panel is closed, and an upload from the editor adds to it.
 * So the panel fetches on every mount and again when a pass ends, rather than trusting a
 * number from the last visit.
 */
export const pendingImagesQuery = () =>
  queryOptions({ queryKey: keys.pendingImages(), queryFn: () => api.pendingImages(), staleTime: 0 });

/**
 * Which user each cache currently holds rows for.
 *
 * Kept beside the client rather than in a variable of this module's own, so that a second
 * client — every test builds one — starts out owned by nobody instead of inheriting
 * whichever answer this module last happened to record.
 */
const cacheOwner = new WeakMap<QueryClient, string>();

/**
 * Hand the cache to whoever is signed in now, emptying it first if that is somebody new.
 *
 * Signing out leaves every row this cache holds — notes, tags, notebooks, counts — sitting
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
 * only way one user follows another in a tab nobody reloaded — a session can expire, or be
 * ended from another tab, with nothing pressed here at all.
 *
 * An unchanged user id keeps its cache. Being served your own rows is not the leak, and
 * staleness already covers them, so signing out and back in stays as cheap as it was.
 *
 * `keys.config()` is spared. It describes the instance rather than the user, and it is
 * `staleTime: Infinity` precisely so that the sign-in screen does not flash its provider
 * buttons in — which is the screen mounted and observing it at the moment this runs.
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
      return lib ? notebookList(snapshot(lib)) : api.listNotebooks();
    },
  });

/** A notebook's definitions from the library, or the route's 404 for an id that is not a notebook. */
async function fieldsOf(notebookId: string, counts: boolean): Promise<FieldDef[]> {
  const lib = await library();
  if (!lib) return api.listNotebookFields(notebookId, counts ? { counts } : undefined);
  const fields = notebookFields(snapshot(lib), notebookId, counts);
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
 * A note moving between the live list and the trash — created, trashed, restored, or
 * destroyed — silently changes the sidebar: the notebook it was filed in loses a note
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
 * Notes matching a search — any search, one letter included.
 *
 * One letter used to send nothing, with "Keep typing to search notes." in place of
 * results: a one-letter prefix was the costliest request on D1, which billed every row it
 * read. In the per-account store it costs what any page of results does — the rows-read
 * meter sees the fifty matches and their joins, not the index walk behind them (measured:
 * 502 rows for "t" and for a whole word on a three-thousand-note store). Without the cost
 * there was only the confusion left: a field that took a letter and showed nothing.
 *
 * `keepPreviousData` for the reason `notesQuery` has it, and more so: every settled pause
 * in typing is a new key, so without it the results vanished at each one and came back
 * when the request landed. The previous term's results stay instead, marked through
 * `isPlaceholderData` so the list can dim them.
 *
 * `rows` asks for each match's list row as well, for the table — see `searchNotes`.
 */
export const searchQuery = (q: string, filter: NoteFilter = {}, rows = false) =>
  queryOptions({
    queryKey: keys.search(q, filter, rows),
    queryFn: () => api.searchNotes(q, filter, rows),
    enabled: q.trim() !== '',
    placeholderData: keepPreviousData,
  });

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
 * names before it runs — "Permanently delete 47 notes", "Its 12 notes will become
 * unfiled" — where a stored count that had somehow drifted would be telling the user
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
      return lib ? count(snapshot(lib), scope) : ((await api.listNotes({ ...scope, limit: 1, exact: true })).total ?? 0);
    },
  });
