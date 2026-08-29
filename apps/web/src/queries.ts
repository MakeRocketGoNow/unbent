import { queryOptions, infiniteQueryOptions } from '@tanstack/react-query';
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
  tag?: string;
}

export const keys = {
  notes: (filter: NoteFilter) => ['notes', filter] as const,
  note: (id: string) => ['note', id] as const,
  attachments: (noteId: string) => ['attachments', noteId] as const,
  tags: () => ['tags'] as const,
  notebooks: () => ['notebooks'] as const,
  trash: () => ['trash'] as const,
  trashCount: () => ['trash', 'count'] as const,
  noteCount: () => ['notes', 'count'] as const,
  search: (q: string, filter: NoteFilter = {}) => ['search', q, filter] as const,
};

/** Live notes matching a filter, paged. */
export const notesQuery = (filter: NoteFilter) =>
  infiniteQueryOptions({
    queryKey: keys.notes(filter),
    queryFn: ({ pageParam }) =>
      api.listNotes({ ...filter, ...(pageParam ? { cursor: pageParam } : {}) }),
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

export const notebooksQuery = () =>
  queryOptions({ queryKey: keys.notebooks(), queryFn: () => api.listNotebooks() });

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
