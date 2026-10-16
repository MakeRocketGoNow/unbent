import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { DEFAULT_NOTE_SORT, excerptMarkdown, sameName, UNFILED, type Note, type NoteSummary } from '@unbent/shared';
import type { NotePage, SearchHit } from './notes-api.js';
import type { SearchAnswer } from './queries.js';
import type { NoteFilter, NoteOrdering } from './queries.js';

/** Which parts of a note a save changed, as far as a list's membership and order care. */
export interface SavedChange {
  title?: boolean;
  notebook?: boolean;
  tags?: boolean;
  fields?: boolean;
}

/**
 * Brings every cached note list up to date with one saved note, without asking the server.
 *
 * Saves used to invalidate every list under `['notes']`, and an infinite query refetches
 * all the pages it holds, one request each: every pause while typing re-read every page
 * the list had been scrolled through. D1 bills every row a query visits, and a list page
 * reads hundreds to thousands of rows once its tag, field and file subqueries are counted,
 * so a writing session with a scrolled table open cost hundreds of thousands of rows for
 * rows that had not changed: the one being edited was the only one that could.
 *
 * The saved note is what the PATCH returned, so the row can be rebuilt exactly and put
 * where the server would list it. Only when the save could move the note into or out of a
 * list, or somewhere along it this code cannot place, is that one list refetched (see
 * `listAfterSave`). Counts beside a list only move when the note's filing did.
 */
export function applySaveToLists(queryClient: QueryClient, saved: Note, change: SavedChange) {
  for (const [key, data] of queryClient.getQueriesData<InfiniteData<NotePage>>({
    queryKey: ['notes'],
  })) {
    const list = noteListKey(key);
    if (!list) {
      // `['notes', 'exact-count', …]`: a count only a change of filing can move.
      if (change.notebook || change.tags) void queryClient.invalidateQueries({ queryKey: key, exact: true });
      continue;
    }
    if (!data?.pages) continue;
    const next = listAfterSave(data, list.filter, list.ordering, saved, change);
    if (next === 'refetch') void queryClient.invalidateQueries({ queryKey: key, exact: true });
    else if (next !== data) queryClient.setQueryData(key, next);
  }
  /*
     A table drawing a search draws each match's list row, so those rows follow the save
     too. In place, and never refetched: the matches are ranked, a save does not re-rank
     them, and the sidebar's results (titles and snippets) have never followed a save
     either. A search that carries no rows has nothing here to change.
  */
  for (const [key, data] of queryClient.getQueriesData<SearchAnswer>({ queryKey: ['search'] })) {
    if (!data?.results.some((r) => 'note' in r && r.id === saved.id)) continue;
    queryClient.setQueryData<SearchAnswer>(key, { ...data, results: searchAfterSave(data.results, saved) });
  }
}

/** A search's matches with one saved note's row rebuilt; see `applySaveToLists`. */
export function searchAfterSave(results: SearchHit[], saved: Note): SearchHit[] {
  return results.map((r) =>
    'note' in r && r.id === saved.id ? { ...r, title: saved.title, note: summaryOf(saved, r.note) } : r,
  );
}

function noteListKey(key: QueryKey): { filter: NoteFilter; ordering: NoteOrdering } | null {
  const [, filter, ordering] = key;
  if (typeof filter !== 'object' || filter === null) return null;
  return { filter: filter as NoteFilter, ordering: (ordering ?? {}) as NoteOrdering };
}

/**
 * One list after a save: the same data with the note's row rebuilt and placed, or
 * `'refetch'` when only the server can say where it goes.
 *
 * A patch can place the note when its position depends on something the save did not
 * touch, or on its updated date, which the save sets and the PATCH returns: under
 * "Recently updated" the row moves to the top, as it did when the list was refetched. It cannot when the save changed what a filter tests (filing under a notebook
 * or tag filter, a field under a field filter, the updated date under a range on it) or
 * what a title or field sort orders by: the new position is somewhere among rows this
 * list may not have loaded.
 */
export function listAfterSave(
  data: InfiniteData<NotePage>,
  filter: NoteFilter,
  ordering: NoteOrdering,
  saved: Note,
  change: SavedChange,
): InfiniteData<NotePage> | 'refetch' {
  const sort = ordering.sortField ? 'field' : (ordering.sort ?? DEFAULT_NOTE_SORT);
  const descending = (ordering.order ?? 'desc') === 'desc';

  if ((filter.notebook !== undefined || filter.tag?.length) && (change.notebook || change.tags)) {
    return 'refetch';
  }
  if (filter.field?.length && change.fields) return 'refetch';
  // Every sort but `created` applies a date range to the updated date (see SORTS in the API).
  if ((filter.from || filter.to) && sort !== 'created') return 'refetch';
  if (sort === 'field' && change.fields) return 'refetch';
  if (sort === 'title' && change.title) return 'refetch';

  const old = data.pages.flatMap((p) => p.items).find((n) => n.id === saved.id);
  const row = summaryOf(saved, old);
  const moves = sort === 'updated' && (old === undefined || old.updatedAt !== saved.updatedAt);

  if (!old) {
    // Not loaded. The only place a save can bring it into view is the top of a
    // newest-first list, and only if it belongs there.
    if (!moves || !descending) return data;
    const member = belongsTo(saved, filter);
    if (member === undefined) return 'refetch';
    if (!member) return data;
    return withRowAt(data, row, 'top');
  }

  if (!moves) {
    return {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items: p.items.map((n) => (n.id === saved.id ? row : n)),
      })),
    };
  }
  return withRowAt(data, row, descending ? 'top' : 'end');
}

/**
 * The list row for a saved note. The PATCH returns the note as `get` reads it, which has
 * the body rather than the excerpt and no attachments; the excerpt is the same function
 * the list query applies, and a save cannot change the files, so they are kept.
 */
function summaryOf(saved: Note, old: NoteSummary | undefined): NoteSummary {
  const row: NoteSummary = {
    id: saved.id,
    title: saved.title,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
    tags: saved.tags,
    notebook: saved.notebook ?? null,
    notebookId: saved.notebookId ?? null,
    excerpt: excerptMarkdown(saved.body),
  };
  if (saved.fields?.length) row.fields = saved.fields;
  if (old?.attachments) row.attachments = old.attachments;
  return row;
}

/**
 * Whether a note belongs in a list, judged from the filters a patch can check. Undefined
 * for a field filter, which would need the definitions to evaluate.
 */
function belongsTo(note: Note, filter: NoteFilter): boolean | undefined {
  if (filter.field?.length) return undefined;
  if (filter.notebook === UNFILED) {
    if (note.notebook) return false;
  } else if (filter.notebook !== undefined) {
    if ((note.notebook ?? '').toLowerCase() !== filter.notebook.toLowerCase()) return false;
  }
  // Tags without case, as the store's filter has them (MAK-127).
  return (filter.tag ?? []).every((t) => note.tags.some((held) => sameName(held, t)));
}

/**
 * The pages with the row taken out of wherever it was and put at the top, or at the end.
 *
 * The end only exists once the last page has been fetched; before that the row is simply
 * dropped, and arrives in its place when the list is scrolled to it. The cursors stay
 * valid either way: each encodes its page's last row as it was listed, and the moved row
 * now sorts beyond any of them in the direction it went.
 */
function withRowAt(
  data: InfiniteData<NotePage>,
  row: NoteSummary,
  where: 'top' | 'end',
): InfiniteData<NotePage> {
  const pages = data.pages.map((p) => ({ ...p, items: p.items.filter((n) => n.id !== row.id) }));
  if (where === 'top' && pages[0]) {
    pages[0] = { ...pages[0], items: [row, ...pages[0].items] };
  } else if (where === 'end') {
    const last = pages.at(-1);
    if (last && last.cursor === null) pages[pages.length - 1] = { ...last, items: [...last.items, row] };
  }
  return { ...data, pages };
}
