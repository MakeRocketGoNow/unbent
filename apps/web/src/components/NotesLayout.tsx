import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { UNFILED, type NoteSort } from '@unbent/shared';
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
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { ResizeHandle } from './ResizeHandle.js';
import { NoteListItem } from './NoteListItem.js';
import { useListKeys } from '../useListKeys.js';
import { SearchResults } from './SearchResults.js';
import { IndexingStatus } from './IndexingStatus.js';

/** Sidebar plus the routed workspace. Filters come from the URL; nothing here is mirrored into state. */
export function NotesLayout({ children }: { children: React.ReactNode }) {
  const { notebook, tag, q = '', sort, order, from, to } = Route.useSearch();
  /** The tag filter as a list, so the sidebar never has to care that it may be absent. */
  const selectedTags = tag ?? [];
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const layout = useNotesLayout('/notes/$noteId');
  const onListKeys = useListKeys();
  /**
   * Tags start collapsed on a phone and open everywhere else.
   *
   * CSS cannot do this: `<details open>` is an attribute, not a style, so a media query
   * cannot close it. The initial state is all that is decided here — once the user
   * toggles it, the element owns its own state and this stops applying.
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);

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
          !notebooks.data.notebooks.some((nb) => nb.name === notebook) && (
            <p className="bad small">
              No notebook named “{notebook}”.{' '}
              <Link to="/notes" search={(prev) => ({ ...prev, notebook: undefined })}>
                Show all notes
              </Link>
            </p>
          )}

        {results === null && (notebooks.data?.notebooks.length ?? 0) > 0 && (
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
              {notebooks.data?.notebooks.map((nb) => (
                <option key={nb.id} value={nb.name}>
                  {nb.name} ({nb.count})
                </option>
              ))}
              {/*
                  "Inbox" is the label for having no notebook — the same state the API and
                  the UNFILED sentinel still call unfiled. One name for one bucket: notes
                  arrive here from a phone share and from a deleted notebook alike, and both
                  want the same triage. Renaming the sentinel would churn the API for a word.

                  Offered only when there is something to see; with nothing unfiled the
                  option leads to a guaranteed empty list. It stays rendered while it is the
                  active filter so the select never falls back to showing "All notebooks"
                  over a URL that says otherwise.
              */}
              {((notebooks.data?.unfiled ?? 0) > 0 || notebook === UNFILED) && (
                <option value={UNFILED}>Inbox ({notebooks.data?.unfiled ?? 0})</option>
              )}
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

        {/*
          * Shown while searching too: a date range narrows which notes match, which is a
          * question worth asking of search results, unlike sort which would discard their
          * relevance ranking.
          */}
        <div className="date-range">
          <label>
            <span className="small">From</span>
            <input
              type="date"
              value={from ?? ''}
              max={to ?? undefined}
              onChange={(e) =>
                void navigate({
                  to: '/notes',
                  search: (prev) => ({ ...prev, from: e.target.value || undefined }),
                })
              }
            />
          </label>
          <label>
            <span className="small">To</span>
            <input
              type="date"
              value={to ?? ''}
              min={from ?? undefined}
              onChange={(e) =>
                void navigate({
                  to: '/notes',
                  search: (prev) => ({ ...prev, to: e.target.value || undefined }),
                })
              }
            />
          </label>
          {(from || to) && (
            <button
              type="button"
              className="link-button small"
              onClick={() =>
                void navigate({
                  to: '/notes',
                  search: (prev) => ({ ...prev, from: undefined, to: undefined }),
                })
              }
            >
              Clear
            </button>
          )}
        </div>

        {/*
          * Export the current filter.
          *
          * Here rather than only in Settings because this is where the scope was chosen:
          * having filtered to a tag and a year, being sent to another page to describe the
          * same slice again is the failure mode. Shown only when a filter is active — with
          * none, this is the whole-library export, which has its own page and a warning
          * about size that belongs with it.
          *
          * An anchor, like the export page's: the archive is generated as it downloads, so
          * letting the browser consume the response is what keeps a corpus larger than the
          * Worker's memory from ever landing in a JS buffer.
          */}
        {results === null && isFiltered && (
          <a className="export-filtered small" href={api.exportUrl({ ...filter, sort: sort ?? 'updated' })} download>
            {total !== null ? `Export these ${total} notes` : 'Export these notes'}
          </a>
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
              {selectedTags.length > 0 ? (
                // Every selected tag, not the first and a count: two tags ANDed are a
                // different question from either alone, and the collapsed row is the only
                // place a filter shows while the list is closed.
                selectedTags.map((name) => (
                  <span className="tag-filter-active" key={name}>
                    {name}
                  </span>
                ))
              ) : (
                <span className="tag-filter-summary-count">{tags.data?.length}</span>
              )}
            </summary>
            <div className="tag-filter">
              {tags.data?.map((t) => {
                const on = selectedTags.includes(t.name);
                return (
                  <button
                    key={t.name}
                    type="button"
                    className={on ? 'tag-filter-item active' : 'tag-filter-item'}
                    aria-pressed={on}
                    onClick={() =>
                      void navigate({
                        to: '/notes',
                        search: (prev) => {
                          /*
                           * Tags accumulate rather than replace: picking a second one
                           * narrows to notes carrying both. Dropping to undefined at zero
                           * keeps `?tag=` out of the URL when nothing is selected.
                           */
                          const next = on
                            ? selectedTags.filter((name) => name !== t.name)
                            : [...selectedTags, t.name];
                          return { ...prev, tag: next.length ? next : undefined };
                        },
                      })
                    }
                  >
                    {t.name}
                    <span className="tag-count">{t.count}</span>
                  </button>
                );
              })}
            </div>
          </details>
        )}

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
