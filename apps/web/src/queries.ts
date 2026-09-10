import { queryOptions, infiniteQueryOptions, type QueryClient } from '@tanstack/react-query';
import type { NoteSort } from '@unbent/shared';
import * as api from './notes-api.js';

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
 */

export interface NoteFilter {
  notebook?: string;
  /**
   * Tags, ANDed. Order is not meaningful to the server but it is to the key hash, so
   * whatever builds this must produce a stable order for the same selection — otherwise
   * two spellings of one filter become two cache entries and the list refetches for a
   * change the user did not make. The URL is that order: it is where the filter lives.
   */
  tag?: string[];
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
  trash: () => ['trash'] as const,
  trashCount: () => ['trash', 'count'] as const,
  noteCount: () => ['notes', 'count'] as const,
  search: (q: string, filter: NoteFilter = {}) => ['search', q, filter] as const,
  config: () => ['config'] as const,
};

/** Live notes matching a filter, paged. */
export const notesQuery = (filter: NoteFilter, ordering: NoteOrdering = {}) =>
  infiniteQueryOptions({
    queryKey: keys.notes(filter, ordering),
    queryFn: ({ pageParam }) =>
      api.listNotes({ ...filter, ...ordering, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.cursor ?? undefined,
  });

/** Trashed notes. Deliberately unfiltered: see the trash view in Notes. */
export const trashQuery = () =>
  infiniteQueryOptions({
    queryKey: keys.trash(),
    queryFn: ({ pageParam }) =>
      api.listNotes({ trashed: true, ...(pageParam ? { cursor: pageParam } : {}) }),
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
    queryFn: () => api.listNotes({ trashed: true, limit: 1 }),
    select: (page) => page.total ?? 0,
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
    queryFn: () => api.getNote(id),
    retry: false,
  });

/**
 * Files stored on a note. Independent of whether the markdown still links them —
 * that is what the attachments panel exists to surface.
 */
export const attachmentsQuery = (noteId: string) =>
  queryOptions({
    queryKey: keys.attachments(noteId),
    queryFn: () => api.listAttachments(noteId),
  });

export const tagsQuery = () =>
  queryOptions({ queryKey: keys.tags(), queryFn: () => api.listTags() });

/**
 * The instance's sign-in methods. Never stale: they change only with a redeploy, and a
 * login screen that refetched them on every mount would flash its buttons in.
 */
export const configQuery = () =>
  queryOptions({ queryKey: keys.config(), queryFn: () => api.getConfig(), staleTime: Infinity });

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
  queryOptions({ queryKey: keys.notebooks(), queryFn: () => api.listNotebooks() });

/** A notebook's custom field definitions. Disabled, not errored, for an unfiled note. */
export const notebookFieldsQuery = (notebookId: string | undefined) =>
  queryOptions({
    queryKey: keys.notebookFields(notebookId ?? ''),
    queryFn: () => api.listNotebookFields(notebookId!),
    enabled: notebookId !== undefined && notebookId !== '',
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

export const searchQuery = (q: string, filter: NoteFilter = {}) =>
  queryOptions({
    queryKey: keys.search(q, filter),
    queryFn: () => api.searchNotes(q, filter),
    enabled: q.trim() !== '',
  });

/**
 * How many live notes exist.
 *
 * Sibling of `trashCountQuery`, and asked for the same reason: a destructive button that
 * names its blast radius before you press it is worth more than the confirm that follows.
 * Only the total is used, so this asks for a single row.
 */
export const noteCountQuery = () =>
  queryOptions({
    queryKey: keys.noteCount(),
    queryFn: () => api.listNotes({ limit: 1 }),
    select: (page) => page.total ?? 0,
  });
