import { useCallback, useEffect, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { UNFILED, type Note, type NoteSummary, type SearchResult } from '@unbent/shared';
import * as api from '../notes-api.js';
import { useUrlState } from '../use-url-state.js';
import { useAutosave } from '../useAutosave.js';
import { Editor } from './Editor.js';
import { Preview } from './Preview.js';
import { TagInput } from './TagInput.js';
import { SearchResults } from './SearchResults.js';
import { EditorToolbar } from './EditorToolbar.js';

function formatWhen(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ms).toLocaleDateString();
}

const SAVE_LABEL: Record<string, string> = {
  idle: '',
  dirty: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
};

interface NotesProps {
  /**
   * Bumped by the parent after an import to trigger a refetch.
   *
   * A prop rather than a `key` remount: selection and filters now live in the URL, so a
   * remount would no longer clear them and a pre-import note id would survive and re-fail.
   */
  refreshSignal?: number;
}

export function Notes({ refreshSignal = 0 }: NotesProps) {
  /**
   * Notebook, tag, open note, and search query live in the URL so a reload restores the
   * exact view, and a note can be linked to. See use-url-state.ts.
   */
  const {
    notebook: activeNotebook,
    tag: activeTag,
    note: selectedId,
    q: query,
    trash: viewingTrash,
    set,
  } = useUrlState();

  const [list, setList] = useState<NoteSummary[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  /** Set when the note named in the URL cannot be loaded; see the load effect below. */
  const [noteError, setNoteError] = useState<{ kind: 'missing' | 'failed'; message: string } | null>(
    null,
  );
  const [draft, setDraft] = useState<{
    title: string;
    body: string;
    tags: string[];
    notebook: string | null;
  }>({
    title: '',
    body: '',
    tags: [],
    notebook: null,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  // Persisted: which editing mode you prefer should survive a reload.
  const [richEditor, setRichEditor] = useState(
    () => localStorage.getItem('unbent.richEditor') !== 'false',
  );
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [allTags, setAllTags] = useState<Array<{ name: string; count: number }>>([]);
  const [allNotebooks, setAllNotebooks] = useState<api.Notebook[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  /** Bumped by the Retry button to re-run the load effect for the same note id. */
  const [retryCount, setRetryCount] = useState(0);
  /** Notes in the trash. Drives the toggle's badge, so it is fetched even when not viewing it. */
  const [trashCount, setTrashCount] = useState(0);

  const listFilter = useCallback(
    () =>
      viewingTrash
        ? // Trash ignores notebook and tag filters: it is a flat view of what was deleted,
          // and a filter that hid a note the user is looking for would defeat the point.
          { trashed: true }
        : {
            ...(activeNotebook ? { notebook: activeNotebook } : {}),
            ...(activeTag ? { tag: activeTag } : {}),
          },
    [activeNotebook, activeTag, viewingTrash],
  );

  const refreshList = useCallback(async () => {
    try {
      const [page, tags, notebooks, trashPage] = await Promise.all([
        api.listNotes(listFilter()),
        api.listTags(),
        api.listNotebooks(),
        // Fetched even when not viewing the trash, so the toggle can show a count and the
        // trash is discoverable rather than hidden behind a guess.
        api.listNotes({ trashed: true, limit: 1 }),
      ]);
      setList(page.items);
      setCursor(page.cursor);
      setTotal(page.total);
      setAllTags(tags);
      setAllNotebooks(notebooks);
      setTrashCount(trashPage.total ?? 0);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [listFilter]);

  /** Appends the next page. Without this the list stops at the server's page size. */
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.listNotes({
        ...listFilter(),
        cursor,
      });
      // Guard against a note arriving twice if it was edited between pages.
      setList((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...page.items.filter((n) => !seen.has(n.id))];
      });
      setCursor(page.cursor);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [listFilter, cursor, loadingMore]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // An import changes note and notebook counts; refetch without disturbing the URL so the
  // user keeps their place.
  useEffect(() => {
    if (refreshSignal > 0) void refreshList();
    // refreshList is intentionally excluded: this fires on the signal, not on filter
    // changes, which the effect above already covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  /**
   * Loads the note named in the URL.
   *
   * A note id can arrive from a shared link or a reload long after the note was deleted,
   * so a failure here is expected rather than exceptional. The id deliberately stays in
   * the URL so the link remains copyable and retryable; the workspace explains what
   * happened instead. A 404 and a transport failure need different words and different
   * recovery, so they are distinguished.
   */
  useEffect(() => {
    setNoteError(null);
    if (!selectedId) {
      setNote(null);
      return;
    }
    let cancelled = false;
    api
      .getNote(selectedId)
      .then((n) => {
        if (cancelled) return;
        setNote(n);
        setDraft({ title: n.title, body: n.body, tags: n.tags, notebook: n.notebook ?? null });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setNote(null);
        setNoteError(
          err.message.startsWith('404')
            ? { kind: 'missing', message: "That note doesn't exist, or was deleted." }
            : { kind: 'failed', message: `Couldn't load that note. ${err.message}` },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, retryCount]);

  // Debounced search. A null result set means "not searching", which is distinct from an
  // empty array meaning "searched and found nothing".
  useEffect(() => {
    const q = query.trim();
    if (q === '') {
      setResults(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .searchNotes(q)
        .then((r) => !cancelled && setResults(r))
        .catch((err: Error) => !cancelled && setLoadError(err.message));
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const save = useCallback(
    async (value: { title: string; body: string; tags: string[]; notebook: string | null }) => {
      if (!selectedId) return;
      const updated = await api.updateNote(selectedId, value);
      // A tag or notebook edit changes the sidebar counts, so both are refetched.
      void api.listTags().then(setAllTags).catch(() => undefined);
      void api.listNotebooks().then(setAllNotebooks).catch(() => undefined);
      // Reflect the new updated_at and ordering without refetching the body.
      setList((prev) =>
        [
          {
            id: updated.id,
            title: updated.title,
            updatedAt: updated.updatedAt,
            createdAt: updated.createdAt,
            tags: updated.tags,
            excerpt: value.body.split('\n').find((l) => l.trim())?.slice(0, 140) ?? '',
          },
          ...prev.filter((n) => n.id !== updated.id),
        ].sort((a, b) => b.updatedAt - a.updatedAt),
      );
    },
    [selectedId],
  );

  const { state: saveState, flush } = useAutosave(draft, save, {
    // Never autosave while viewing the trash: a note in the bin is a record of what was
    // deleted, and writing to it would be editing something the user believes is gone.
    enabled: note !== null && !viewingTrash,
  });

  async function newNote() {
    await flush();
    try {
      // Carry the active filter onto the new note, otherwise it is created and then
      // immediately filtered out of the list the user is looking at.
      const created = await api.createNote({
        title: 'Untitled',
        body: '',
        tags: activeTag ? [activeTag] : [],
        notebook: activeNotebook,
      });
      await refreshList();
      set({ note: created.id });
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  async function removeNote(id: string) {
    try {
      await api.deleteNote(id);
      if (selectedId === id) set({ note: null });
      await refreshList();
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  /** Puts a trashed note back. The list refreshes, so it leaves the trash view. */
  async function restore(id: string) {
    try {
      await api.restoreNote(id);
      if (selectedId === id) set({ note: null });
      await refreshList();
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  /**
   * Destroys one trashed note for good.
   *
   * Confirmed because it is the only irreversible action reachable from the note list —
   * the ordinary Delete is a move to trash, which this view exists to undo.
   */
  async function destroy(id: string, title: string) {
    if (!confirm(`Permanently delete "${title || 'Untitled'}" and its attachments?`)) return;
    try {
      await api.deleteNotePermanently(id);
      if (selectedId === id) set({ note: null });
      await refreshList();
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  async function select(id: string) {
    // Flush before switching so the last edit is never dropped.
    await flush();
    set({ note: id });
  }

  return (
    <div className="notes">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="count">
            {viewingTrash
              ? `${total ?? list.length} in trash`
              : results !== null
                ? `${results.length} matches`
                : total !== null && total > list.length
                  ? `${list.length} of ${total} notes`
                  : `${list.length} notes`}
          </span>
          {!viewingTrash && (
            <button type="button" className="primary" onClick={() => void newNote()}>
              New
            </button>
          )}
        </div>

        {loadError && <p className="bad small">{loadError}</p>}

        {!viewingTrash && (
        <input
          className="search-field"
          type="search"
          value={query}
          placeholder="Search notes…"
          // replace, not push: the query updates per keystroke, and pushing would make
          // Back crawl out of a search one character at a time.
          onChange={(e) => set({ q: e.target.value }, { replace: true })}
        />
        )}

        {/* The trash is only offered once something is in it: an always-visible empty
            bin is noise, and its absence is itself information. */}
        {(trashCount > 0 || viewingTrash) && (
          <button
            type="button"
            className={viewingTrash ? 'trash-toggle active' : 'trash-toggle'}
            onClick={() => set({ trash: !viewingTrash, note: null, q: '' })}
          >
            {viewingTrash ? '← Back to notes' : 'Trash'}
            {!viewingTrash && <span className="tag-count">{trashCount}</span>}
          </button>
        )}

        {!viewingTrash && results === null && allNotebooks.length > 0 && (
          <div className={`notebook-scope-wrap${allTags.length === 0 ? ' filters-end' : ''}`}>
            <select
              className="notebook-scope"
              value={activeNotebook ?? ''}
              // Clearing the tag matters: tags cross notebook boundaries, so keeping one
              // selected here routinely yields an empty list with no visible cause.
              onChange={(e) => set({ notebook: e.target.value || null, tag: null })}
              aria-label="Notebook"
            >
              <option value="">All notebooks</option>
              {allNotebooks.map((nb) => (
                <option key={nb.id} value={nb.name}>
                  {nb.name} ({nb.count})
                </option>
              ))}
              {/* Reachable only once a notebook is deleted, which unfiles its notes. */}
              <option value={UNFILED}>Unfiled</option>
            </select>
          </div>
        )}

        {!viewingTrash && results === null && allTags.length > 0 && (
          <div className="tag-filter">
            {allTags.map((t) => (
              <button
                key={t.name}
                type="button"
                className={activeTag === t.name ? 'tag-filter-item active' : 'tag-filter-item'}
                onClick={() => set({ tag: activeTag === t.name ? null : t.name })}
              >
                {t.name}
                <span className="tag-count">{t.count}</span>
              </button>
            ))}
          </div>
        )}

        <ul className="note-list">
          {results !== null && (
            <SearchResults
              results={results}
              selectedId={selectedId}
              onSelect={(id) => void select(id)}
            />
          )}

          {results === null &&
            list.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={n.id === selectedId ? 'note-item active' : 'note-item'}
                  onClick={() => void select(n.id)}
                >
                  <span className="note-title">{n.title || 'Untitled'}</span>
                  <span className="note-meta">
                    {viewingTrash && n.deletedAt
                      ? `Deleted ${formatWhen(n.deletedAt)}`
                      : formatWhen(n.updatedAt)}
                  </span>
                  {n.excerpt && <span className="note-excerpt">{n.excerpt}</span>}
                  {n.tags.length > 0 && (
                    <span className="note-tags">{n.tags.map((t) => `#${t}`).join(' ')}</span>
                  )}
                </button>
                {viewingTrash && (
                  <div className="trash-actions">
                    <button type="button" className="link" onClick={() => void restore(n.id)}>
                      Restore
                    </button>
                    <button
                      type="button"
                      className="link danger"
                      onClick={() => void destroy(n.id, n.title)}
                    >
                      Delete forever
                    </button>
                  </div>
                )}
              </li>
            ))}
          {results === null && cursor !== null && (
            <li>
              <button
                type="button"
                className="load-more"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </li>
          )}

          {results === null && list.length === 0 && !loadError && (
            <li className="muted small empty">
              {viewingTrash
                ? 'Trash is empty.'
                : activeTag
                  ? `No notes tagged ${activeTag}.`
                  : activeNotebook === UNFILED
                    ? 'No unfiled notes.'
                    : activeNotebook
                      ? `No notes in ${activeNotebook}.`
                      : 'No notes yet.'}
            </li>
          )}
        </ul>
      </aside>

      <section className="workspace">
        {!note && noteError && (
          <div className="workspace-error">
            <p className={noteError.kind === 'missing' ? 'muted' : 'bad'}>{noteError.message}</p>
            {noteError.kind === 'missing' ? (
              <button type="button" className="link" onClick={() => set({ note: null })}>
                Clear
              </button>
            ) : (
              <button type="button" className="link" onClick={() => setRetryCount((n) => n + 1)}>
                Retry
              </button>
            )}
          </div>
        )}

        {!note && !noteError && <p className="muted placeholder">Select a note, or create one.</p>}

        {note && (
          <>
            <div className="workspace-head">
              <input
                className="title-input"
                value={draft.title}
                placeholder="Untitled"
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
              <div className="workspace-actions">
                <span className={saveState === 'error' ? 'bad small' : 'muted small'}>
                  {SAVE_LABEL[saveState]}
                </span>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    setRichEditor((r) => {
                      localStorage.setItem('unbent.richEditor', String(!r));
                      return !r;
                    })
                  }
                >
                  {richEditor ? 'Plain source' : 'Rich text'}
                </button>
                <button type="button" className="link" onClick={() => setShowPreview((p) => !p)}>
                  {showPreview ? 'Hide preview' : 'Show preview'}
                </button>
                <button type="button" className="link danger" onClick={() => void removeNote(note.id)}>
                  Delete
                </button>
              </div>
            </div>

            <div className="tag-row">
              {/* Filing a note by picking from the notebooks that exist, rather than
                  retyping a name — which is how case-variant duplicates used to appear. */}
              <select
                className="note-notebook"
                value={draft.notebook ?? ''}
                aria-label="Notebook"
                onChange={(e) => setDraft((d) => ({ ...d, notebook: e.target.value || null }))}
              >
                <option value="">Unfiled</option>
                {allNotebooks.map((nb) => (
                  <option key={nb.id} value={nb.name}>
                    {nb.name}
                  </option>
                ))}
              </select>

              <TagInput
                tags={draft.tags}
                suggestions={allTags.map((t) => t.name)}
                onChange={(tags) => setDraft((d) => ({ ...d, tags }))}
              />
            </div>

            <EditorToolbar view={editorView} />

            <div className={showPreview ? 'panes split' : 'panes'}>
              <div className="pane">
                <Editor
                  noteId={note.id}
                  initialValue={note.body}
                  onChange={(body) => setDraft((d) => ({ ...d, body }))}
                  onUpload={async (file) => (await api.uploadFile(note.id, file)).path}
                  rich={richEditor}
                  onViewReady={setEditorView}
                />
              </div>
              {showPreview && (
                <div className="pane preview-pane">
                  <Preview markdown={draft.body} noteId={note.id} />
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
