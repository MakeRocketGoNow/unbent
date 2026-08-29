import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { UNFILED, type NoteSort } from '@unbent/shared';
import * as api from '../notes-api.js';
import { Route } from '../routes/notes.js';
import { notesQuery, tagsQuery, notebooksQuery, searchQuery, keys } from '../queries.js';
import { useNotesLayout, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from '../useNotesLayout.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { ResizeHandle } from './ResizeHandle.js';
import { NoteListItem } from './NoteListItem.js';
import { SearchResults } from './SearchResults.js';

/** Sidebar plus the routed workspace. Filters come from the URL; nothing here is mirrored into state. */
export function NotesLayout({ children }: { children: React.ReactNode }) {
  const { notebook, tag, q = '', sort, order } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const layout = useNotesLayout('/notes/$noteId');
  /**
   * Tags start collapsed on a phone and open everywhere else.
   *
   * CSS cannot do this: `<details open>` is an attribute, not a style, so a media query
   * cannot close it. The initial state is all that is decided here — once the user
   * toggles it, the element owns its own state and this stops applying.
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const filter = { ...(notebook ? { notebook } : {}), ...(tag ? { tag } : {}) };
  const ordering = { ...(sort ? { sort } : {}), ...(order ? { order } : {}) };

  const list = useInfiniteQuery(notesQuery(filter, ordering));
  const tags = useQuery(tagsQuery());
  const notebooks = useQuery(notebooksQuery());

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
        tags: tag ? [tag] : [],
        // UNFILED is a filter sentinel, not a notebook name — a note created while
        // viewing it belongs in no notebook.
        notebook: notebook === UNFILED ? null : (notebook ?? null),
      });
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
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
          <button type="button" className="primary" onClick={() => void newNote()}>
            New
          </button>
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

        {/*
            A notebook that no longer exists is syntactically valid, so validateSearch
            cannot reject it — only the loaded list can. Saying so beats the old silent
            desync, where the URL filtered by a notebook while the picker read "All
            notebooks" and the empty list looked like a data problem.
        */}
        {results === null &&
          notebook &&
          notebook !== UNFILED &&
          notebooks.isSuccess &&
          !notebooks.data.some((nb) => nb.name === notebook) && (
            <p className="bad small">
              No notebook named “{notebook}”.{' '}
              <Link to="/notes" search={(prev) => ({ ...prev, notebook: undefined })}>
                Show all notes
              </Link>
            </p>
          )}

        {results === null && (notebooks.data?.length ?? 0) > 0 && (
          <div className={`notebook-scope-wrap${(tags.data?.length ?? 0) === 0 ? ' filters-end' : ''}`}>
            <select
              className="notebook-scope"
              value={notebook ?? ''}
              // Clearing the tag matters: tags cross notebook boundaries, so keeping one
              // selected here routinely yields an empty list with no visible cause.
              onChange={(e) =>
                void navigate({
                  to: '/notes',
                  search: (prev) => ({
                    ...prev,
                    notebook: e.target.value || undefined,
                    tag: undefined,
                  }),
                })
              }
              aria-label="Notebook"
            >
              <option value="">All notebooks</option>
              {notebooks.data?.map((nb) => (
                <option key={nb.id} value={nb.name}>
                  {nb.name} ({nb.count})
                </option>
              ))}
              {/* Reachable only once a notebook is deleted, which unfiles its notes. */}
              <option value={UNFILED}>Unfiled</option>
            </select>
          </div>
        )}

        {/*
          * Sort is one control rather than a field plus a direction, because the useful
          * combinations are few and naming them ("Oldest first") is plainer than asking
          * someone to assemble "created" and "ascending" themselves.
          *
          * Hidden while searching: results come back ranked by relevance, and reordering
          * them by date would throw away the ranking that makes them worth showing.
          */}
        {results === null && (
          <div className="notebook-scope-wrap">
            <select
              className="notebook-scope"
              value={`${sort ?? 'updated'}:${order ?? 'desc'}`}
              onChange={(e) => {
                const [nextSort, nextOrder] = e.target.value.split(':') as [NoteSort, 'asc' | 'desc'];
                void navigate({
                  to: '/notes',
                  // The default stays out of the URL so a plain /notes link is clean.
                  search: (prev) => ({
                    ...prev,
                    sort: nextSort === 'updated' ? undefined : nextSort,
                    order: nextOrder === 'desc' ? undefined : nextOrder,
                  }),
                });
              }}
              aria-label="Sort notes"
            >
              <option value="updated:desc">Recently updated</option>
              <option value="created:desc">Newest first</option>
              <option value="created:asc">Oldest first</option>
              <option value="title:asc">Title A–Z</option>
              <option value="title:desc">Title Z–A</option>
            </select>
          </div>
        )}

        {results === null && (tags.data?.length ?? 0) > 0 && (
          /*
              A disclosure rather than a flat list.

              The tag list is as long as the user has tags — this account has sixteen, and
              they filled most of a phone screen before a single note was visible. Collapsed
              it costs one row; the summary carries the active tag so a filter can never be
              applied invisibly.

              `open` is a default, not a controlled value — `key` re-mounts the element when
              the breakpoint changes so the new default takes, and between those crossings
              the element owns its own state and the user's toggle sticks.
          */
          <details className="tag-filter-wrap" key={String(isMobile)} open={!isMobile}>
            <summary>
              Tags
              {/* The active tag stays on the row while collapsed, so a filter is never
                  applied invisibly; otherwise the count says what is hidden. */}
              {tag ? (
                <span className="tag-filter-active">{tag}</span>
              ) : (
                <span className="tag-filter-summary-count">{tags.data?.length}</span>
              )}
            </summary>
            <div className="tag-filter">
              {tags.data?.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className={tag === t.name ? 'tag-filter-item active' : 'tag-filter-item'}
                  onClick={() =>
                    void navigate({
                      to: '/notes',
                      search: (prev) => ({ ...prev, tag: tag === t.name ? undefined : t.name }),
                    })
                  }
                >
                  {t.name}
                  <span className="tag-count">{t.count}</span>
                </button>
              ))}
            </div>
          </details>
        )}

        <ul className="note-list">
          {results !== null && <SearchResults results={results} />}

          {results === null &&
            notes.map((n) => <NoteListItem key={n.id} note={n} to="/notes/$noteId" />)}

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
                  ? 'No unfiled notes.'
                  : notebook
                    ? `No notes in ${notebook}.`
                    : 'No notes yet.'}
            </li>
          )}
        </ul>
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
