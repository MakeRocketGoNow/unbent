import { useCallback, useEffect, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import type { Note, NoteSummary, SearchResult } from '@unbent/shared';
import * as api from '../notes-api.js';
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

export function Notes() {
  const [list, setList] = useState<NoteSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [draft, setDraft] = useState<{ title: string; body: string; tags: string[] }>({
    title: '',
    body: '',
    tags: [],
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  // Persisted: which editing mode you prefer should survive a reload.
  const [richEditor, setRichEditor] = useState(
    () => localStorage.getItem('unbent.richEditor') !== 'false',
  );
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [allTags, setAllTags] = useState<Array<{ name: string; count: number }>>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const [page, tags] = await Promise.all([
        api.listNotes(activeTag ? { tag: activeTag } : {}),
        api.listTags(),
      ]);
      setList(page.items);
      setCursor(page.cursor);
      setTotal(page.total);
      setAllTags(tags);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [activeTag]);

  /** Appends the next page. Without this the list stops at the server's page size. */
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.listNotes({
        ...(activeTag ? { tag: activeTag } : {}),
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
  }, [activeTag, cursor, loadingMore]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Load the selected note's full body.
  useEffect(() => {
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
        setDraft({ title: n.title, body: n.body, tags: n.tags });
      })
      .catch((err: Error) => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

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
    async (value: { title: string; body: string; tags: string[] }) => {
      if (!selectedId) return;
      const updated = await api.updateNote(selectedId, value);
      // A tag edit can create or empty a tag, so the sidebar counts move with it.
      void api.listTags().then(setAllTags).catch(() => undefined);
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

  const { state: saveState, flush } = useAutosave(draft, save, { enabled: note !== null });

  async function newNote() {
    await flush();
    try {
      // Carry the active filter onto the new note, otherwise it is created and then
      // immediately filtered out of the list the user is looking at.
      const created = await api.createNote({
        title: 'Untitled',
        body: '',
        tags: activeTag ? [activeTag] : [],
      });
      await refreshList();
      setSelectedId(created.id);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  async function removeNote(id: string) {
    try {
      await api.deleteNote(id);
      if (selectedId === id) setSelectedId(null);
      await refreshList();
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  async function select(id: string) {
    // Flush before switching so the last edit is never dropped.
    await flush();
    setSelectedId(id);
  }

  return (
    <div className="notes">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="count">
            {results !== null
              ? `${results.length} matches`
              : total !== null && total > list.length
                ? `${list.length} of ${total} notes`
                : `${list.length} notes`}
          </span>
          <button type="button" className="primary" onClick={() => void newNote()}>
            New
          </button>
        </div>

        {loadError && <p className="bad small">{loadError}</p>}

        <input
          className="search-field"
          type="search"
          value={query}
          placeholder="Search notes…"
          onChange={(e) => setQuery(e.target.value)}
        />

        {results === null && allTags.length > 0 && (
          <div className="tag-filter">
            <button
              type="button"
              className={activeTag === null ? 'tag-filter-item active' : 'tag-filter-item'}
              onClick={() => setActiveTag(null)}
            >
              All
            </button>
            {allTags.map((t) => (
              <button
                key={t.name}
                type="button"
                className={activeTag === t.name ? 'tag-filter-item active' : 'tag-filter-item'}
                onClick={() => setActiveTag(activeTag === t.name ? null : t.name)}
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
                  <span className="note-meta">{formatWhen(n.updatedAt)}</span>
                  {n.excerpt && <span className="note-excerpt">{n.excerpt}</span>}
                  {n.tags.length > 0 && (
                    <span className="note-tags">{n.tags.map((t) => `#${t}`).join(' ')}</span>
                  )}
                </button>
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
              {activeTag ? `No notes tagged ${activeTag}.` : 'No notes yet.'}
            </li>
          )}
        </ul>
      </aside>

      <section className="workspace">
        {!note && <p className="muted placeholder">Select a note, or create one.</p>}

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
