import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { UNFILED } from '@unbent/shared';
import * as api from '../notes-api.js';
import { Route } from '../routes/notes.js';
import { notesQuery, tagsQuery, notebooksQuery, trashCountQuery, searchQuery, keys } from '../queries.js';
import { NoteListItem } from './NoteListItem.js';
import { SearchResults } from './SearchResults.js';

/** Sidebar plus the routed workspace. Filters come from the URL; nothing here is mirrored into state. */
export function NotesLayout({ children }: { children: React.ReactNode }) {
  const { notebook, tag, q = '' } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const filter = { ...(notebook ? { notebook } : {}), ...(tag ? { tag } : {}) };

  const list = useInfiniteQuery(notesQuery(filter));
  const tags = useQuery(tagsQuery());
  const notebooks = useQuery(notebooksQuery());
  const trashCount = useQuery(trashCountQuery());

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
  const search = useQuery(searchQuery(debounced));

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
    <div className="notes">
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
            Always offered, empty or not. Navigation is a map, and one that redraws itself
            teaches no stable habit — you cannot learn that the trash is here if "here" is
            usually blank space. Worse, the moment you most need it, having just deleted
            something, used to be the first moment the link had ever appeared. The count
            is what stays conditional.
        */}
        <Link to="/trash" className="trash-toggle">
          Trash
          {(trashCount.data ?? 0) > 0 && <span className="tag-count">{trashCount.data}</span>}
        </Link>

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
                  search: { notebook: e.target.value || undefined, tag: undefined, q: q || undefined },
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

        {results === null && (tags.data?.length ?? 0) > 0 && (
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

      {children}
    </div>
  );
}
