import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import * as api from '../notes-api.js';
import { isStatus } from '../notes-api.js';
import { useAutosave } from '../useAutosave.js';
import { usePersistentState, clamp } from '../usePersistentState.js';
import { useMediaQuery, MOBILE_QUERY } from '../useMediaQuery.js';
import { noteQuery, notebooksQuery, tagsQuery, keys } from '../queries.js';
import { Editor } from './Editor.js';
import { Preview } from './Preview.js';
import { TagInput } from './TagInput.js';
import { EditorToolbar } from './EditorToolbar.js';
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
   * Both of these are preferences rather than per-note state, so they survive a reload.
   *
   * `richEditor` was already persisted, by hand, writing the bare string "false". That
   * happens to be valid JSON and still parses, so the existing key is read rather than
   * migrated — see the test that pins it.
   */
  const [showPreview, setShowPreview] = usePersistentState('showPreview', true);
  const [richEditor, setRichEditor] = usePersistentState('richEditor', true);
  const [editorView, setEditorView] = useState<EditorView | null>(null);

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
   * Which pane a phone is looking at.
   *
   * Deliberately separate from `showPreview`, and deliberately not persisted. The two
   * mean different things: on a desktop `showPreview` means "show both panes", so reusing
   * it below the breakpoint made a stored `true` open every note in the preview — the
   * opposite of the intent, which is that tapping a note is ready to type. This resets to
   * the editor on every note, which is the right default for a device you write on
   * briefly and read on often.
   */
  const [mobilePreview, setMobilePreview] = useState(false);
  /**
   * Only for labelling the preview toggle, never for choosing what to render.
   *
   * The two widths give the same button different jobs, so the icon and its accessible
   * name have to describe the right one. Layout stays entirely in CSS.
   */
  const isMobile = useMediaQuery(MOBILE_QUERY);
  // A different note starts on its text again, not on whatever the last one was showing.
  useEffect(() => setMobilePreview(false), [noteId]);

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
      {/*
          Two rows on a phone, one on a desktop.

          The single flex row squeezed the title to a few characters — "2026-03-25 - P" —
          because three actions sat beside it with `white-space: nowrap`. A note's title is
          the thing you need to confirm you opened the right note, so below the breakpoint
          it gets the full width and the controls drop underneath it.
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

          {/* Editing mode is a desktop-frequent, mobile-rare control: on a phone it moves
              into the overflow rather than taking room in the head. */}
          <button
            type="button"
            className="link desktop-only"
            onClick={() => setRichEditor((r) => !r)}
          >
            {richEditor ? 'Plain source' : 'Rich text'}
          </button>

          {/* Delete is one tap from the title on a phone and reads as destructive at a
              glance; behind the overflow it takes a deliberate second tap. */}
          {!readOnly && (
            <button type="button" className="link danger desktop-only" onClick={() => void removeNote()}>
              Delete
            </button>
          )}

          <span className="mobile-only overflow-slot">
            <OverflowMenu
              label="More actions"
              items={[
                {
                  label: richEditor ? 'Plain source' : 'Rich text',
                  onSelect: () => setRichEditor((r) => !r),
                },
                ...(readOnly
                  ? []
                  : [
                      {
                        label: 'Delete',
                        tone: 'danger' as const,
                        onSelect: () => void removeNote(),
                      },
                    ]),
              ]}
            />
          </span>
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

      {/*
          One handler for both widths. `showPreview` is the persisted desktop preference —
          does the second pane exist — and `mobilePreview` is which single pane a phone is
          looking at. Below the breakpoint the button has to move both: turning the preview
          on from a hidden state should land on it rather than toggling an invisible pane.
      */}
      <EditorToolbar
        view={editorView}
        preview={{
          // What is actually on screen, which is not the same question at each width: a
          // phone shows one pane at a time, so a persisted showPreview=true still leaves
          // it on the editor until the toggle says otherwise.
          shown: isMobile ? showPreview && mobilePreview : showPreview,
          label: isMobile ? 'pane' : 'split',
          onToggle: () => {
            if (isMobile) {
              // Swap panes. The pane has to exist to be swapped to, so a preview turned
              // off on a desktop is turned back on here rather than doing nothing.
              if (!showPreview) setShowPreview(true);
              setMobilePreview((p) => !p);
            } else {
              setShowPreview((p) => !p);
            }
          },
        }}
      />

      {/* `mobile-preview` is inert above the breakpoint, where `split` already shows both
          panes; below it, it is what swaps the editor out for the preview. */}
      <div
        className={
          showPreview ? `panes split${mobilePreview ? ' mobile-preview' : ''}` : 'panes'
        }
        style={{ '--editor-fraction': fraction } as React.CSSProperties}
        ref={panesRef}
      >
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
          <ResizeHandle
            label="Resize preview"
            containerRef={panesRef}
            toValue={(clientX, rect) => (clientX - rect.left) / rect.width}
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
        {showPreview && (
          <div className="pane preview-pane">
            <Preview markdown={draft.body} noteId={note.id} />
          </div>
        )}
      </div>
    </section>
  );
}
