import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import * as api from '../notes-api.js';
import { isStatus } from '../notes-api.js';
import { indexUploadedFile } from '../index-files.js';
import { useAutosave } from '../useAutosave.js';
import { usePersistentState } from '../usePersistentState.js';
import { noteQuery, notebooksQuery, notebookFieldsQuery, keys } from '../queries.js';
import type { FieldType, FieldValue } from '@unbent/shared';
import { buildNotePatch } from '../note-patch.js';
import { NoteFields } from '../components/NoteFields.js';
import { Editor } from '../components/Editor.js';
import { Preview } from '../components/Preview.js';
import { EditorToolbar, type NoteView } from '../components/EditorToolbar.js';
import { Attachments } from '../components/Attachments.js';
import { abandonUploads } from '../editor/attach.js';
import { exposeToApp, postToApp } from '../app-bridge.js';
import { usePdfAttachments } from '../usePdfAttachments.js';

/**
 * A note's fields and body, for the Android app to host in a WebView.
 *
 * The app draws the title, the notebook and the tags natively above this page and writes
 * them itself; this page owns the fields and the body and writes only those. `PATCH
 * /notes/:id` is a partial update, so the two never overwrite each other's field. No
 * loader: the root layout skips its session gate for `/embed/`, and a fetch that fails is
 * reported to the app through the bridge rather than rendered as a login screen inside
 * its screen.
 *
 * The fields are here rather than native because the repo's rule is that editing
 * behaviour belongs in the web app and reaches both platforms: the property list, its
 * in-place controls and its add-field form are one implementation, and the phone shows
 * the same one the site does, above the body, the way the site's own phone layout does.
 */
export const Route = createFileRoute('/embed/notes/$noteId')({
  component: EmbeddedNoteRoute,
});

function EmbeddedNoteRoute() {
  const { noteId } = Route.useParams();
  return <EmbeddedNote noteId={noteId} />;
}

/**
 * The editing core of `Workspace`, composed from the same primitives.
 *
 * Deliberately not a refactor of `Workspace` into a shared component: what the two have
 * in common is the editor, the toolbar, the attachments panel and autosave, which are
 * already components. What differs is everything around them — the desktop split pane,
 * the resize handle, the list's keyboard focus, the visual-viewport keyboard inset — none
 * of which applies inside a native screen that resizes for the keyboard itself.
 */
function EmbeddedNote({ noteId }: { noteId: string }) {
  const queryClient = useQueryClient();
  const { data: note, error } = useQuery(noteQuery(noteId));

  /** The body being edited. Null until seeded from the loaded note, which gates autosave. */
  const [body, setBody] = useState<string | null>(null);
  /** The field values being edited, by field id; null is a cleared value. Seeded with the body. */
  const [fields, setFields] = useState<Record<string, FieldValue | null>>({});
  /*
   * The notebook the note is filed in, for its field definitions. By name, since that is
   * what the note carries; the id only exists to address the notebook's own settings.
   */
  const notebooks = useQuery(notebooksQuery());
  const currentNotebook = notebooks.data?.notebooks.find(
    (nb) => nb.name.toLowerCase() === note?.notebook?.toLowerCase(),
  );
  const fieldDefs = useQuery(notebookFieldsQuery(currentNotebook?.id));
  const [seededFor, setSeededFor] = useState<string | null>(null);
  /**
   * Editor is uncontrolled. After deleting a still-linked attachment the panel rewrites
   * the body and the editor remounts with that text; otherwise the saved body is the seed.
   */
  const [editorRevision, setEditorRevision] = useState(0);
  const [editorOverride, setEditorOverride] = useState<string | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  // Which files are PDFs regardless of what they are named; both panes render from it.
  const pdfFilenames = usePdfAttachments(noteId);

  // The same preference the web app keeps, so the editor a person writes in follows
  // them between the site and the app on a device where both share storage.
  const [noteView, setNoteView] = usePersistentState<NoteView>('noteView', 'rich', (raw) =>
    raw === 'rich' || raw === 'source' ? raw : undefined,
  );

  useEffect(() => {
    if (!note) return;
    setBody(note.body);
    setFields(Object.fromEntries((note.fields ?? []).map((v) => [v.fieldId, v.value])));
    setSeededFor(note.id);
    setEditorOverride(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, note !== undefined]);

  async function save(value: string) {
    try {
      const updated = await api.updateNote(noteId, { body: value });
      queryClient.setQueryData(keys.note(noteId), updated);
    } catch (err) {
      // A session that died mid-edit is the app's problem to solve, not a retry's.
      if (isStatus(err, 401)) postToApp({ type: 'unauthorized' });
      throw err;
    }
  }

  const { state: bodyState, flush: flushBody } = useAutosave(body ?? '', save, {
    enabled: note !== undefined && body !== null && seededFor === noteId,
    resetKey: noteId,
  });

  /**
   * The fields save on their own clock, through the same patch builder the site uses,
   * so a half-typed number is held rather than sent and a cleared value goes as null.
   * Only the fields differ from the note here: the body is the editor's business, and
   * naming the note's own body, title and tags in the draft is what keeps them out of
   * the patch.
   */
  async function saveFields(value: Record<string, FieldValue | null>) {
    if (!note) return;
    const patch = buildNotePatch(
      { title: note.title, body: note.body, tags: note.tags, notebook: note.notebook ?? null, fields: value },
      note,
      fieldDefs.data,
    );
    if (!patch) return;
    try {
      const updated = await api.updateNote(noteId, patch);
      queryClient.setQueryData(keys.note(noteId), updated);
    } catch (err) {
      if (isStatus(err, 401)) postToApp({ type: 'unauthorized' });
      throw err;
    }
  }

  const { state: fieldsState, flush: flushFields } = useAutosave(fields, saveFields, {
    enabled: note !== undefined && seededFor === noteId,
    resetKey: noteId,
  });

  /**
   * One state for the app, from two autosaves: the worse of the two, since the app only
   * asks whether it is safe to leave. Saving beats dirty beats saved; an error anywhere
   * is an error.
   */
  const RANK = { error: 4, saving: 3, dirty: 2, saved: 1, idle: 0 } as const;
  const saveState = RANK[fieldsState] > RANK[bodyState] ? fieldsState : bodyState;
  const flush = useCallback(async () => {
    await Promise.all([flushBody(), flushFields()]);
  }, [flushBody, flushFields]);

  // Every state the app might want to show — Saving…, Saved, Save failed — and the one
  // it waits for before leaving the screen.
  useEffect(() => {
    postToApp({ type: 'save', state: saveState });
  }, [saveState]);

  /** Adds a definition to the note's notebook from the note itself, as the site does. */
  async function addField(input: { name: string; type: FieldType; options: string[] }) {
    if (!currentNotebook) return;
    await api.createNotebookField(currentNotebook.id, input);
    await queryClient.invalidateQueries({ queryKey: keys.notebookFields(currentNotebook.id) });
    void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
  }

  /*
     Called by the app when the user leaves mid-upload, right before it calls `flush`.

     `flushSync` is what makes that order safe. Removing the placeholders is a CodeMirror
     change that reaches autosave only through `setBody` → render → passive effect, and
     without it the app's `flush` could run first, find nothing pending, and let the
     screen close with the placeholder as the last thing saved — the exact junk this call
     exists to prevent. React flushes the render and its effects synchronously inside
     `flushSync`, so by the time this returns autosave holds the clean body and has told
     the app it is dirty. Should that ever change, the app also waits briefly for a
     dirty/saving report before it trusts a flush; see NoteScreen.leave.
  */
  const abandon = useCallback(() => {
    if (!editorView) return;
    flushSync(() => {
      abandonUploads(editorView);
    });
  }, [editorView]);

  useEffect(() => exposeToApp({ flush, abandonUploads: abandon }), [flush, abandon]);

  useEffect(() => {
    if (note) postToApp({ type: 'ready' });
  }, [note !== undefined]);

  useEffect(() => {
    if (!error) return;
    if (isStatus(error, 401)) postToApp({ type: 'unauthorized' });
    else if (isStatus(error, 404)) postToApp({ type: 'missing' });
  }, [error]);

  function rewriteBody(nextBody: string) {
    setBody(nextBody);
    setEditorOverride(nextBody);
    setEditorRevision((n) => n + 1);
  }

  if (error) {
    const missing = isStatus(error, 404);
    return (
      <section className="embedded">
        <div className="workspace-error">
          <p className={missing ? 'muted' : 'bad'}>
            {missing
              ? "That note doesn't exist, or was deleted."
              : `Couldn't load that note. ${(error as Error).message}`}
          </p>
        </div>
      </section>
    );
  }

  if (!note || body === null) {
    return (
      <section className="embedded">
        <p className="muted placeholder">Loading…</p>
      </section>
    );
  }

  return (
    <section className="embedded">
      {/* Above the body, capped and scrolling within, exactly as the site's phone layout
          draws them — the same `.fields-inline` block. */}
      <div className="fields-inline">
        <NoteFields
          definitions={fieldDefs.data}
          values={fields}
          carried={note.fields ?? []}
          notebookId={currentNotebook?.id ?? null}
          onChange={(fieldId, value) => setFields((f) => ({ ...f, [fieldId]: value }))}
          onAddField={addField}
        />
      </div>

      <Attachments
        noteId={note.id}
        body={body}
        editorView={editorView}
        onBodyRewrite={rewriteBody}
      />

      {/* Always docked: this is a phone, and the app resizes the page above the keyboard,
          so the bar sits on the bottom edge of whatever is left without an inset. */}
      <EditorToolbar
        view={editorView}
        docked
        noteView={{ current: noteView, onChange: setNoteView }}
      />

      <div className={noteView === 'preview' ? 'panes reading' : 'panes'}>
        {/* Mounted in every view, including preview: see the same comment in Workspace.
            Unmounting the uncontrolled editor would discard its undo history. */}
        <div className="pane editor-pane">
          <Editor
            key={`${note.id}-${editorRevision}`}
            noteId={note.id}
            initialValue={editorOverride ?? note.body}
            // See the same prop in Workspace: rich mode needs the content types too.
            pdfFilenames={pdfFilenames}
            onChange={setBody}
            onUpload={async (file, signal) => {
              const uploaded = await api.uploadFile(note.id, file, { signal });
              void queryClient.invalidateQueries({ queryKey: keys.attachments(note.id) });
              // This is the editor the Android app hosts, so a PDF picked from the phone
              // is indexed here too. The app's share sheet uploads without this page and
              // has its own way: see IndexWorker in the app.
              indexUploadedFile(note.id, uploaded, file);
              return uploaded.path;
            }}
            // The app shows "Attaching…" and asks before Back while this is above zero.
            onUploadsPending={(pending) => postToApp({ type: 'upload', pending })}
            rich={noteView === 'rich'}
            // A note opens to be read; the keyboard comes up when the body is tapped. Focus
            // on mount would raise it over a page the user has not chosen to write in yet.
            autoFocus={false}
            onViewReady={setEditorView}
          />
        </div>
        {noteView === 'preview' && (
          <div className="pane preview-pane">
            <Preview markdown={body} noteId={note.id} />
          </div>
        )}
      </div>
    </section>
  );
}
