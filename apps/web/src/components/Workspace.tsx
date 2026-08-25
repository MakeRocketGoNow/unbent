import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import * as api from '../notes-api.js';
import { isStatus } from '../notes-api.js';
import { useAutosave } from '../useAutosave.js';
import { noteQuery, notebooksQuery, tagsQuery, keys } from '../queries.js';
import { Editor } from './Editor.js';
import { Preview } from './Preview.js';
import { TagInput } from './TagInput.js';
import { EditorToolbar } from './EditorToolbar.js';
import { Attachments } from './Attachments.js';

const SAVE_LABEL: Record<string, string> = {
  idle: '',
  dirty: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
};

interface WorkspaceProps {
  noteId: string;
  /** Trashed notes are readable but never written to. */
  readOnly?: boolean;
}

export function Workspace({ noteId, readOnly = false }: WorkspaceProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: note, error, refetch } = useQuery(noteQuery(noteId));
  const notebooks = useQuery(notebooksQuery());
  const tags = useQuery(tagsQuery());

  const [draft, setDraft] = useState<{
    title: string;
    body: string;
    tags: string[];
    notebook: string | null;
  }>({ title: '', body: '', tags: [], notebook: null });
  /** Which note `draft` was seeded from; guards autosave against a not-yet-seeded draft. */
  const [draftFor, setDraftFor] = useState<string | null>(null);
  /**
   * Editor is uncontrolled. After deleting a still-linked attachment we rewrite the
   * draft and remount with that text; otherwise the open note's saved body is the seed.
   */
  const [editorRevision, setEditorRevision] = useState(0);
  const [editorOverride, setEditorOverride] = useState<string | null>(null);

  const [showPreview, setShowPreview] = useState(true);
  // Persisted: which editing mode you prefer should survive a reload.
  const [richEditor, setRichEditor] = useState(
    () => localStorage.getItem('unbent.richEditor') !== 'false',
  );
  const [editorView, setEditorView] = useState<EditorView | null>(null);

  // Seed the draft when a different note loads. Keyed on id, not on the note object,
  // so a background refetch never discards what is being typed.
  useEffect(() => {
    if (!note) return;
    setDraft({ title: note.title, body: note.body, tags: note.tags, notebook: note.notebook ?? null });
    setDraftFor(note.id);
    setEditorOverride(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, note !== undefined]);

  async function save(value: typeof draft) {
    const updated = await api.updateNote(noteId, value);
    queryClient.setQueryData(keys.note(noteId), updated);
    // A tag or notebook edit changes the sidebar counts, and the title and ordering
    // change the list, so both are refetched rather than patched by hand.
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    void queryClient.invalidateQueries({ queryKey: keys.tags() });
    void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
  }

  const { state: saveState } = useAutosave(draft, save, {
    // Never autosave while viewing the trash: a note in the bin is a record of what was
    // deleted, and writing to it would be editing something the user believes is gone.
    // `draftFor === noteId` keeps a draft still holding the previous note's text from
    // being written over this one during the render between navigation and reseeding.
    enabled: note !== undefined && !readOnly && draftFor === noteId,
    resetKey: noteId,
  });

  async function removeNote() {
    await api.deleteNote(noteId);
    await queryClient.invalidateQueries({ queryKey: ['notes'] });
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
    void navigate({ to: '/notes', search: (p) => p });
  }

  function rewriteBody(nextBody: string) {
    setDraft((d) => ({ ...d, body: nextBody }));
    setEditorOverride(nextBody);
    setEditorRevision((n) => n + 1);
  }

  /**
   * A note id can arrive from a shared link or a reload long after the note was deleted,
   * so a failure here is expected rather than exceptional. The id deliberately stays in
   * the URL so the link remains copyable and retryable; this explains what happened
   * instead. A 404 and a transport failure need different words and different recovery.
   */
  if (error) {
    const missing = isStatus(error, 404);
    return (
      <section className="workspace">
        <div className="workspace-error">
          <p className={missing ? 'muted' : 'bad'}>
            {missing
              ? "That note doesn't exist, or was deleted."
              : `Couldn't load that note. ${(error as Error).message}`}
          </p>
          {missing ? (
            <button
              type="button"
              className="link"
              onClick={() => void navigate({ to: '/notes', search: (p) => p })}
            >
              Clear
            </button>
          ) : (
            <button type="button" className="link" onClick={() => void refetch()}>
              Retry
            </button>
          )}
        </div>
      </section>
    );
  }

  if (!note) {
    return (
      <section className="workspace">
        <p className="muted placeholder">Loading…</p>
      </section>
    );
  }

  return (
    <section className="workspace">
      <div className="workspace-head">
        <input
          className="title-input"
          value={draft.title}
          placeholder="Untitled"
          readOnly={readOnly}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
        <div className="workspace-actions">
          <span className={saveState === 'error' ? 'bad small' : 'muted small'}>
            {readOnly ? 'In trash' : SAVE_LABEL[saveState]}
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
          {!readOnly && (
            <button type="button" className="link danger" onClick={() => void removeNote()}>
              Delete
            </button>
          )}
        </div>
      </div>

      <div className="tag-row">
        {/* Filing a note by picking from the notebooks that exist, rather than
            retyping a name — which is how case-variant duplicates used to appear. */}
        <select
          className="note-notebook"
          value={draft.notebook ?? ''}
          aria-label="Notebook"
          disabled={readOnly}
          onChange={(e) => setDraft((d) => ({ ...d, notebook: e.target.value || null }))}
        >
          <option value="">Unfiled</option>
          {notebooks.data?.map((nb) => (
            <option key={nb.id} value={nb.name}>
              {nb.name}
            </option>
          ))}
        </select>

        <TagInput
          tags={draft.tags}
          suggestions={tags.data?.map((t) => t.name) ?? []}
          onChange={(next) => setDraft((d) => ({ ...d, tags: next }))}
        />
      </div>

      {!readOnly && (
        <Attachments
          noteId={note.id}
          body={draft.body}
          editorView={editorView}
          onBodyRewrite={rewriteBody}
        />
      )}

      <EditorToolbar view={editorView} />

      <div className={showPreview ? 'panes split' : 'panes'}>
        <div className="pane">
          <Editor
            key={`${note.id}-${editorRevision}`}
            noteId={note.id}
            initialValue={editorOverride ?? note.body}
            onChange={(body) => setDraft((d) => ({ ...d, body }))}
            onUpload={async (file) => {
              const uploaded = await api.uploadFile(note.id, file);
              void queryClient.invalidateQueries({ queryKey: keys.attachments(note.id) });
              return uploaded.path;
            }}
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
    </section>
  );
}
