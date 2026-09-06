import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { UNFILED } from '@unbent/shared';
import * as api from '../notes-api.js';
import { Route } from '../routes/notes.js';
import {
  notesQuery,
  tagsQuery,
  notebooksQuery,
  searchQuery,
  trashCountQuery,
  invalidateNoteMembership,
} from '../queries.js';
import { useNotesLayout, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from '../useNotesLayout.js';
import { ResizeHandle } from './ResizeHandle.js';
import { NoteListItem } from './NoteListItem.js';
import { useListKeys } from '../useListKeys.js';
import { SearchResults } from './SearchResults.js';
import { IndexingStatus } from './IndexingStatus.js';
import { Button } from './Button';
import { FilterControls } from './FilterControls.js';

/** Sidebar plus the routed workspace. Filters come from the URL; nothing here is mirrored into state. */
export function NotesLayout({ children }: { children: React.ReactNode }) {
  const { notebook, tag, q = '', sort, order, from, to } = Route.useSearch();
  /** The tag filter as a list, so the sidebar never has to care that it may be absent. */
  const selectedTags = tag ?? [];
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const layout = useNotesLayout('/notes/$noteId');
  const onListKeys = useListKeys();

  const filter = {
    ...(notebook ? { notebook } : {}),
    ...(tag ? { tag } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  const ordering = { ...(sort ? { sort } : {}), ...(order ? { order } : {}) };

  /**
   * The export link is the current filter, serialized. Because the filters already live in
   * the URL there is no separate state to keep in step — the link is the view.
   */
  const isFiltered = Boolean(notebook || selectedTags.length || from || to);

  const list = useInfiniteQuery(notesQuery(filter, ordering));
  const tags = useQuery(tagsQuery());
  const notebooks = useQuery(notebooksQuery());
  const trashCount = useQuery(trashCountQuery());
  const trashed = trashCount.data ?? 0;

  /**
   * The search term, debounced.
   *
   * The URL updates on every keystroke so the field stays a controlled input and the
   * query is shareable, but the request waits until typing settles.
   */
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q), 180);
    return () => clearTimeout(timer);
  }, [q]);
  const search = useQuery(searchQuery(debounced, filter));

  /** Null means "not searching", which is distinct from searching and finding nothing. */
  const results = debounced.trim() === '' ? null : (search.data ?? null);

  const notes = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? null;
  const error = list.error ?? search.error;

  async function newNote() {
    try {
      // Carry the active filter onto the new note, otherwise it is created and then
      // immediately filtered out of the list the user is looking at.
      const created = await api.createNote({
        title: 'Untitled',
        body: '',
        // Every active tag, not just one: with two tags filtered, a note carrying only
        // the first is still filtered out of the list it was created in.
        tags: tag ?? [],
        // UNFILED is a filter sentinel, not a notebook name — a note created while
        // viewing it belongs in no notebook.
        notebook: notebook === UNFILED ? null : (notebook ?? null),
      });
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      invalidateNoteMembership(queryClient);
      void navigate({ to: '/notes/$noteId', params: { noteId: created.id }, search: (p) => p });
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className={layout.className} style={layout.style} ref={layout.containerRef}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="count">
            {results !== null
              ? `${results.length} matches`
              : total !== null && total > notes.length
                ? `${notes.length} of ${total} notes`
                : `${notes.length} notes`}
          </span>
          <Button variant="primary" onClick={() => void newNote()}>
            New
          </Button>
        </div>

        {error && <p className="bad small">{(error as Error).message}</p>}

        <input
          className="search-field"
          type="search"
          value={q}
          placeholder="Search notes…"
          // replace, not push: the query updates per keystroke, and pushing would make
          // Back crawl out of a search one character at a time.
          onChange={(e) =>
            void navigate({
              to: '/notes',
              search: (prev) => ({ ...prev, q: e.target.value || undefined }),
              replace: true,
            })
          }
        />

        <FilterControls
          notebook={notebook}
          selectedTags={selectedTags}
          from={from}
          to={to}
          sort={sort}
          order={order}
          searching={results !== null}
          total={total}
          filter={filter}
          notebooks={notebooks}
          tags={tags}
        />

        <ul className="note-list" onKeyDown={onListKeys}>
          {results !== null && <SearchResults results={results} />}

          {results === null &&
            notes.map((n) => (
              <NoteListItem key={n.id} note={n} to="/notes/$noteId" sort={sort ?? 'updated'} />
            ))}

          {results === null && list.hasNextPage && (
            <li>
              <button
                type="button"
                className="load-more"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </li>
          )}

          {results === null && notes.length === 0 && !error && (
            <li className="muted small empty">
              {tag
                ? `No notes tagged ${tag}.`
                : notebook === UNFILED
                  ? 'Nothing in your inbox.'
                  : notebook
                    ? `No notes in ${notebook}.`
                    : 'No notes yet.'}
            </li>
          )}
        </ul>

        {/*
          * Trash, pinned under the note list.
          *
          * It sits below the list rather than up in the filter stack because it is a
          * destination, not a filter — but it belongs in this column all the same, since
          * what it holds is notes. Every notes app people arrive here from puts deleted
          * notes in the sidebar, and the topbar — now account chrome only — is the one
          * place nobody would think to look for them.
          *
          * `.note-list` takes the leftover height, so this lands on the sidebar floor
          * without anything here having to position it. The rule above it is what stops
          * it reading as one more filter; the count is what stays conditional. No
          * `activeProps`: /trash renders TrashLayout's own sidebar in place of this one,
          * so this link is never on screen while it is the active route.
          */}
        <Link to="/trash" className="trash-link">
          Trash
          {trashed > 0 && <span className="tag-count">{trashed}</span>}
        </Link>
        <IndexingStatus />
      </aside>

      <ResizeHandle
        label="Resize sidebar"
        containerRef={layout.containerRef}
        /**
         * Measured from the grid's left edge, less the channel between the two columns.
         *
         * The handle does not sit at the sidebar's right edge — the grid puts a gap either
         * side of the handle track, so the divider renders at `width + gap`. Treating the
         * pointer position as the width directly therefore set a width that pushed the
         * handle further right than the cursor, and it trailed the pointer by the gap for
         * the whole drag.
         */
        toValue={(clientX, rect, gap) => clientX - rect.left - gap}
        value={layout.width}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        step={16}
        defaultValue={SIDEBAR_DEFAULT}
        onResize={layout.onResize}
        onCommit={layout.onResizeCommit}
      />

      {children}
    </div>
  );
}
