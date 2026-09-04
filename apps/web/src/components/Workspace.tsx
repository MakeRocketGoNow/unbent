import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import * as api from '../notes-api.js';
import { isStatus } from '../notes-api.js';
import { useAutosave } from '../useAutosave.js';
import { usePersistentState, clamp } from '../usePersistentState.js';
import {
  useCameFromList,
  registerEditorFocus,
  focusActiveListItem,
} from '../useListKeys.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { useKeyboardInset } from '../useKeyboardInset.js';
import {
  noteQuery,
  notebooksQuery,
  tagsQuery,
  keys,
  invalidateNoteMembership,
} from '../queries.js';
import { Editor } from './Editor.js';
import { indexUploadedFile } from '../index-files.js';
import { Preview } from './Preview.js';
import { usePdfAttachments } from '../usePdfAttachments.js';
import { TagInput } from './TagInput.js';
import { EditorToolbar, type NoteView } from './EditorToolbar.js';
import { Attachments } from './Attachments.js';
import { ResizeHandle } from './ResizeHandle.js';
import { OverflowMenu } from './OverflowMenu.js';

/** The editor's share of the pane row when split evenly, and the limits a drag respects. */
const EDITOR_DEFAULT = 0.5;
const EDITOR_MIN = 0.2;
const EDITOR_MAX = 0.8;

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
  /** Where the mobile back arrow returns to. The trash renders this same component. */
  backTo?: '/notes' | '/trash';
}

export function Workspace({ noteId, readOnly = false, backTo = '/notes' }: WorkspaceProps) {
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

  /**
   * Which of the three views the note is showing.
   *
   * One value rather than the two booleans this used to be. `showPreview` ("is there a
   * second pane") and `richEditor` ("which editor") were independent, so they could
   * express states that had no meaning — a rich editor beside a preview is the same
   * document rendered twice — and a phone needed a third variable to say which of the two
   * panes it was actually looking at. Three exclusive views need none of that.
   *
   * `preview` is deliberately not restored. It is somewhere you go to read what you just
   * wrote, never the state you want a note to open in, and persisting it meant every note
   * you opened landed on a pane you cannot type into. The editing views persist, so the
   * choice that is a real preference — which editor you write in — survives a reload.
   */
  const [noteView, setNoteView] = usePersistentState<NoteView>('noteView', 'rich', (raw) =>
    raw === 'rich' || raw === 'source' ? raw : undefined,
  );

  /**
   * Show the rendered note beside the source rather than instead of it.
   *
   * A modifier on the source view, not a fourth view — see `NoteView`. Persisted because
   * it is a genuine working preference, and device-local because it is really a statement
   * about how much screen this machine has: a stored `true` from a wide monitor should not
   * follow the user to a laptop. Off by default; the split is the specialist's layout, and
   * defaulting it on is what made the preview feel like half the app.
   */
  const [splitPreview, setSplitPreview] = usePersistentState('splitPreview', false);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  // Which files are PDFs regardless of what they are named; both panes render from it.
  const pdfFilenames = usePdfAttachments(noteId);

  /**
   * Whether this note was reached with the sidebar's arrow keys.
   *
   * If it was, the editor must not take focus on mount: the next arrow press belongs to
   * the list. Every other way of opening a note — a click, a fresh load, a shared link —
   * still lands in the editor ready to type.
   */
  const cameFromList = useCameFromList();

  /**
   * How much of the pane row the editor gets, 0–1.
   *
   * A fraction rather than two pixel widths so the split stays proportional when the
   * window resizes. Same split as the sidebar between a live drag value and the stored
   * one: a pointermove writing to localStorage sixty times a second would hit disk on
   * every frame.
   */
  const [storedFraction, setStoredFraction] = usePersistentState(
    'editorFraction',
    EDITOR_DEFAULT,
    (raw) =>
      typeof raw === 'number' && raw >= EDITOR_MIN && raw <= EDITOR_MAX ? raw : undefined,
  );
  const [fraction, setFraction] = useState(storedFraction);
  useEffect(() => setFraction(storedFraction), [storedFraction]);
  const panesRef = useRef<HTMLDivElement>(null);

  /**
   * Whether this is a one-pane width.
   *
   * Used for two things only: docking the toolbar, and withholding the split-preview
   * control where there is no room for a second pane. Which view is showing is the same
   * question at every width now, so this no longer decides what renders.
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);

  /**
   * How much of the viewport the on-screen keyboard covers.
   *
   * This is what lets the formatting bar sit above the keyboard on a phone rather than
   * underneath it. The bar is docked for the whole note view: twelve 44px controls cannot
   * fit one row at 375px, so left in flow it wrapped to two rows and cost 106px of every
   * screen whether or not anything was being typed.
   */
  const keyboardInset = useKeyboardInset();

  /*
     Lets the sidebar's Enter put the cursor in this note.

     At the end of the document rather than the start: Enter here means "add to this",
     which is where you would have clicked anyway. Registered while a view exists and
     withdrawn with it, so an Enter pressed between notes does nothing rather than
     reaching into a destroyed view.
  */
  useEffect(() => {
    if (!editorView) return;
    registerEditorFocus(() => {
      editorView.dispatch({ selection: { anchor: editorView.state.doc.length } });
      editorView.focus();
    });
    return () => registerEditorFocus(null);
  }, [editorView]);
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
    invalidateNoteMembership(queryClient);
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
    invalidateNoteMembership(queryClient);
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

  /*
     What the chosen view means for the panes.

     Two derived booleans rather than three branches at each use: the rendered pane is on
     in `preview` and in a split `source`, and the second track only exists in the latter.
     `isMobile` gates the split because the pane row has no room for two below the
     breakpoint — the preference stays set, it simply does not apply here.
  */
  const showSplit = noteView === 'source' && splitPreview && !isMobile;
  const showPreviewPane = noteView === 'preview' || showSplit;

  return (
    <section className="workspace">
      {/*
          Two rows on a phone, one on a desktop.

          The single flex row squeezed the title to a few characters — "2026-03-25 - P" —
          because the actions sat beside it with `white-space: nowrap`. A note's title is
          the thing you need to confirm you opened the right note, so below the breakpoint
          it gets the full width and what is left of the controls sits at its right end.
      */}
      <div className="workspace-head">
        <div className="workspace-title-row">
          {/*
              The way back to the list on a phone, where the sidebar is off screen rather
              than merely narrow. Rendered at every width and hidden by CSS above the
              breakpoint: making it conditional would change the tree on resize, and the
              editor below is an uncontrolled CodeMirror view that must not be rebuilt.

              `search` is carried rather than dropped — going back to an unfiltered list
              from a note you reached through a tag is the same trap `newNote` guards.
          */}
          <Link
            to={backTo}
            search={(p) => p}
            className="workspace-back"
            aria-label="Back to notes"
          >
            ←
          </Link>
          <input
            className="title-input"
            value={draft.title}
            placeholder="Untitled"
            readOnly={readOnly}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
        </div>

        <div className="workspace-actions">
          <span className={saveState === 'error' ? 'bad small' : 'muted small'}>
            {readOnly ? 'In trash' : SAVE_LABEL[saveState]}
          </span>

          {/*
              Everything that acts on the note as an object, at every width.

              These used to be promoted to buttons here on a desktop and duplicated into
              the menu on a phone, which meant declaring each one twice and letting the
              head's contents change at the breakpoint. Grouping by what an action acts on
              rather than by how often it is used settles it without a width: the views
              moved to the toolbar, over the panes they change, and what is left is the
              note itself — so the head needs no buttons at all.

              Delete sits behind the ⋯ rather than beside the title on purpose. It is one
              of two irreversible things in the app, and a destructive control a single
              click from the title, a few pixels from the menu it now shares, is a misclick
              waiting to happen. Opening a menu to reach it is the deliberate second step
              that a confirmation dialog alone was carrying.
          */}
          {/* A trashed note has neither action, and a ⋯ that opens an empty box is worse
              than no ⋯ — so the trigger goes with its contents. */}
          {!readOnly && (
            <span className="overflow-slot">
              <OverflowMenu
                label="More actions"
                items={[
                  { label: 'Download', href: api.noteDownloadUrl(noteId) },
                  {
                    label: 'Delete',
                    tone: 'danger' as const,
                    onSelect: () => void removeNote(),
                  },
                ]}
              />
            </span>
          )}
        </div>
      </div>

      {/*
          The note's filing, collapsed to one line on a phone.

          A notebook picker and a tag field are two full rows of controls — 69px — sitting
          permanently between the title and the first line of the note. They are read far
          more often than they are changed, so the summary states them and a tap opens the
          controls. Not moved into the overflow menu: this is what the note *is*, and in an
          archive this size tags are how anything gets found again.

          Open above the breakpoint, where the row costs nothing. See the sidebar's tag
          filter for the same pattern and the reason `key` is needed.
      */}
      <details className="tag-row-wrap" key={String(isMobile)} open={!isMobile}>
        <summary>
          <span className="tag-row-summary">
            <span className="tag-row-summary-book">{draft.notebook ?? 'Inbox'}</span>
            {draft.tags.length > 0 && (
              <span className="tag-row-summary-tags">
                {draft.tags.map((t) => `#${t}`).join(' ')}
              </span>
            )}
          </span>
        </summary>
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
          {/* No notebook. Shown as "Inbox" everywhere in the UI; see NotesLayout. */}
          <option value="">Inbox</option>
          {notebooks.data?.notebooks.map((nb) => (
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
      </details>

      {!readOnly && (
        <Attachments
          noteId={note.id}
          body={draft.body}
          editorView={editorView}
          onBodyRewrite={rewriteBody}
        />
      )}

      <EditorToolbar
        view={editorView}
        /*
            Docked for the whole of a phone's note view, not only while the editor holds
            the caret.

            Keying this on focus made the bar jump: tapping the filing disclosure — or
            anything else that takes focus off the editor — undocked it mid-interaction,
            so it dropped out of the bottom of the screen and reappeared underneath a
            block that had just grown taller. The keyboard inset already handles the only
            thing focus was standing in for, which is where the bar sits when a keyboard
            is open, so the bar can simply stay put.
        */
        docked={isMobile}
        keyboardInset={keyboardInset}
        noteView={{
          current: noteView,
          onChange: setNoteView,
          // Withheld on a phone, where there is no room for a second pane. The preference
          // itself is left alone rather than forced off: a phone should not silently
          // rewrite what the same account chose on a desktop.
          split: isMobile
            ? undefined
            : { on: splitPreview, onToggle: () => setSplitPreview((v) => !v) },
        }}
      />

      {/*
          One pane, or two when the source view has its preview beside it.

          `split` is the only modifier left here. What used to also need a `mobile-preview`
          class — a phone showing the second pane instead of the first — is now just
          `noteView === 'preview'`, which renders one pane at every width and needs no CSS
          to swap anything.
      */}
      <div
        className={[
          'panes',
          showSplit ? 'split' : '',
          // Hides the editor box without unmounting it; see the pane comment below.
          noteView === 'preview' ? 'reading' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ '--editor-fraction': fraction } as React.CSSProperties}
        ref={panesRef}
      >
        {/*
            Mounted in every view, including preview.

            Not conditional, because this is an uncontrolled CodeMirror view: unmounting it
            to show the preview and remounting it on the way back would throw away the undo
            history and the cursor, so switching views twice would cost you your place. The
            preview view hides the box in CSS instead — see `.panes.reading`.
        */}
        <div className="pane editor-pane">
          <Editor
            key={`${note.id}-${editorRevision}`}
            noteId={note.id}
            initialValue={editorOverride ?? note.body}
            // So rich mode draws a viewer for an imported PDF whose name lacks the
            // extension, the same as the preview pane does.
            pdfFilenames={pdfFilenames}
            onChange={(body) => setDraft((d) => ({ ...d, body }))}
            // No uploader on a read-only note: its autosave is off, so a dropped file
            // would be stored with a link that is never saved — a blob nobody can see.
            onUpload={
              readOnly
                ? undefined
                : async (file, signal) => {
                    const uploaded = await api.uploadFile(note.id, file, { signal });
                    void queryClient.invalidateQueries({ queryKey: keys.attachments(note.id) });
                    // Searchable now, from the bytes in hand, not on some later pass.
                    indexUploadedFile(note.id, uploaded, file);
                    return uploaded.path;
                  }
            }
            rich={noteView === 'rich'}
            autoFocus={!cameFromList}
            // The way out of the editor, and the counterpart to the list's Enter.
            onEscape={focusActiveListItem}
            onViewReady={setEditorView}
          />
        </div>
        {showSplit && (
          <ResizeHandle
            label="Resize preview"
            containerRef={panesRef}
            /**
             * Same channel correction as the sidebar, expressed as a fraction.
             *
             * The editor track ends a gap before the handle renders, so the pointer's
             * position is a gap further right than the fraction it should produce.
             * Dividing by the row width turns the pixel correction into the 0–1 unit the
             * split is stored in.
             */
            toValue={(clientX, rect, gap) => (clientX - rect.left - gap) / rect.width}
            value={fraction}
            min={EDITOR_MIN}
            max={EDITOR_MAX}
            step={0.02}
            defaultValue={EDITOR_DEFAULT}
            // A 0–1 value rounds to 0 or 1 and announces uselessly, so the percentage is
            // what reaches assistive tech.
            toAriaValue={(v) => Math.round(v * 100)}
            valueText={`${Math.round(fraction * 100)}% editor`}
            onResize={(next) => setFraction(clamp(next, EDITOR_MIN, EDITOR_MAX))}
            onCommit={(next) => setStoredFraction(clamp(next, EDITOR_MIN, EDITOR_MAX))}
          />
        )}
        {showPreviewPane && (
          <div className="pane preview-pane">
            <Preview markdown={draft.body} noteId={note.id} />
          </div>
        )}
      </div>
    </section>
  );
}
