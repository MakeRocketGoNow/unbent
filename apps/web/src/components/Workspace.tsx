import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import type { FieldType, FieldValue } from '@unbent/shared';
import * as api from '../notes-api.js';
import { isStatus } from '../notes-api.js';
import { buildNotePatch, unstoreableFieldIds } from '../note-patch.js';
import { useAutosave } from '../useAutosave.js';
import { usePersistentState, clamp } from '../usePersistentState.js';
import {
  useCameFromList,
  registerEditorFocus,
  focusActiveListItem,
  focusEditor,
} from '../useListKeys.js';
import { useIsNewNote } from '../useNewNote.js';
import { useMediaQuery, MOBILE_QUERY, TOUCH_QUERY } from '../useMediaQuery.js';
import { useKeyboardInset } from '../useKeyboardInset.js';
import {
  noteQuery,
  notebooksQuery,
  notebookFieldsQuery,
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
import { Button } from './Button';
import { Disclosure } from './Disclosure.js';
import { BackArrow } from './BackArrow.js';
import { NotebookRowIcon, TagIcon } from './icons.js';
import { NoteFields } from './NoteFields.js';

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
    /** Custom field values by field id. Replaced, never mutated: autosave compares by reference. */
    fields: Record<string, FieldValue | null>;
  }>({ title: '', body: '', tags: [], notebook: null, fields: {} });

  /**
   * The notebook the draft names, as the list knows it, for its id. By name because that
   * is what the draft and the picker hold — ids never leave the database's world except
   * to address a notebook's own settings, which is what this one is for.
   */
  const currentNotebook = notebooks.data?.notebooks.find(
    (nb) => nb.name.toLowerCase() === draft.notebook?.toLowerCase(),
  );
  const fieldDefs = useQuery(notebookFieldsQuery(currentNotebook?.id));
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
   * Whether the New note button made this note a moment ago.
   *
   * The one case where the caret belongs in the title rather than in the body: a new note
   * starts with its name, and every other way of opening one means adding to something
   * already named. See the effect below and the editor's `autoFocus`.
   */
  const isNewNote = useIsNewNote(noteId);
  const titleRef = useRef<HTMLInputElement>(null);

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
   * Whether opening this note would raise a keyboard.
   *
   * Deliberately not `isMobile`. The question here is whether focus costs half the screen,
   * which is about the keyboard rather than the layout, and the two disagree at both ends —
   * see `TOUCH_QUERY`.
   */
  const touch = useMediaQuery(TOUCH_QUERY);

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
    setDraft({
      title: note.title,
      body: note.body,
      tags: note.tags,
      notebook: note.notebook ?? null,
      fields: Object.fromEntries((note.fields ?? []).map((v) => [v.fieldId, v.value])),
    });
    setDraftFor(note.id);
    setEditorOverride(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, note !== undefined]);

  /*
     A new note opens with the caret in its title.

     Only a note that was just created. Opening one that already has a name means adding to
     it — you clicked it to write in it — so every other way in still lands in the editor,
     which is what its `autoFocus` below does. `cameFromList` outranks both: while the
     arrow keys are driving, the next press belongs to the list, not to either field.

     The field is empty, with the placeholder showing, rather than holding a selected
     "Untitled" to type over. A selection is lost to any stray click or arrow press — and
     on a phone, to the tap that puts the caret in the field at all — and the next
     keystroke then appends to the word instead of replacing it: "UntitledMeeting notes".
     Nothing can go wrong with an empty field, and nothing has to be typed over.

     Both flags are read as they stand when the note loads and are deliberately not
     dependencies, the same way the editor reads its own `autoFocus` at mount. Either can
     change while the note is open — a click clears one, Escape and Enter move the other —
     and re-running on that would drag the caret out of whatever it had reached and put it
     back in the title.
  */
  useEffect(() => {
    if (!note || !isNewNote || cameFromList) return;
    titleRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, note !== undefined]);

  async function save(value: typeof draft) {
    if (!note) return;
    /*
       Only the keys that actually changed, and only field values the type can store.
       Sending the whole draft used to 400 a body save on a half-typed number, and to
       write the stale title back over a rename the phone had already saved — see
       `buildNotePatch`. Nothing storeable is a successful no-op: the debounce fired
       because the draft moved, but the movement was not yet a value the server can hold.
    */
    const patch = buildNotePatch(value, note, fieldDefs.data);
    if (!patch) return;
    const updated = await api.updateNote(noteId, patch);
    queryClient.setQueryData(keys.note(noteId), updated);
    // A tag or notebook edit changes the sidebar counts, and the title and ordering
    // change the list, so both are refetched rather than patched by hand.
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    invalidateNoteMembership(queryClient);
  }

  const editing = note !== undefined && !readOnly && draftFor === noteId;

  const { state: saveState } = useAutosave(draft, save, {
    // Never autosave while viewing the trash: a note in the bin is a record of what was
    // deleted, and writing to it would be editing something the user believes is gone.
    // `draftFor === noteId` keeps a draft still holding the previous note's text from
    // being written over this one during the render between navigation and reseeding.
    enabled: editing,
    resetKey: noteId,
  });

  /*
     A field value the type cannot read yet — a number at "12.", a URL at "http://" — is
     left out of the patch so the title and body typed beside it still save. The save then
     succeeds with that value held nowhere but the draft, and "Saved" over it is a word the
     user can act on: switch notes or close the tab and the half-typed value is gone.

     So the head keeps saying "Unsaved" until the value is one the field can hold. The
     state machine is left alone — the save did succeed, and failing it would put back the
     400 that took the body down with it.
  */
  const holdingField = editing && unstoreableFieldIds(draft, note, fieldDefs.data).length > 0;
  const saveLabel =
    holdingField && saveState === 'saved' ? SAVE_LABEL.dirty : SAVE_LABEL[saveState];

  /**
   * Adds a definition to the note's notebook from the note itself. The definitions
   * refetch before this resolves so the new row is on screen when the form closes.
   */
  async function addField(input: { name: string; type: FieldType; options: string[] }) {
    if (!currentNotebook) return;
    await api.createNotebookField(currentNotebook.id, input);
    await queryClient.invalidateQueries({ queryKey: keys.notebookFields(currentNotebook.id) });
    void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
  }

  /**
   * The notebook picker: filing a note by picking from the notebooks that exist, rather
   * than retyping a name — which is how case-variant duplicates used to appear. One
   * element, drawn two ways: the desktop's own select in its row, and the phone's chip in
   * the property list, where `.note-field-input` is what a chosen value looks like.
   */
  const notebookSelect = (className: string, id?: string) => (
    <select
      id={id}
      className={className}
      value={draft.notebook ?? ''}
      aria-label="Notebook"
      disabled={readOnly}
      // A chosen notebook is a chip; the Inbox is the absence of one, drawn like "Empty".
      data-filled={draft.notebook ? true : undefined}
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
  );

  const tagInput = (
    <TagInput
      tags={draft.tags}
      suggestions={tags.data?.map((t) => t.name) ?? []}
      onChange={(next) => setDraft((d) => ({ ...d, tags: next }))}
    />
  );

  /**
   * The desktop's filing row: the notebook and the tags on a line above the body.
   *
   * Null until the note has loaded, which is what the render below tests: `note` is read
   * for the carried values.
   */
  const filingControls = !note ? null : (
    <div className="tag-row">
      {notebookSelect('note-notebook')}
      {tagInput}
    </div>
  );

  /**
   * The phone's: the same two controls as the first two rows of the property list.
   *
   * They used to be a row that opened a sheet holding them — a full-height modal surface
   * for a select and a chip, once the fields had left it, and a tap that bought nothing the
   * row had not already said. As properties they read the way Notion reads a page's
   * location and tags: two facts about the record, at the top, edited where they are read.
   * Rows in the list's own grid, so their labels share the fields' column.
   */
  const filingRows = !note ? null : (
    <>
      <div className="note-field filing-prop">
        <span className="note-field-glyph" aria-hidden="true">
          <NotebookRowIcon />
        </span>
        <label className="note-field-label" htmlFor="filing-notebook">
          Notebook
        </label>
        {notebookSelect('note-field-input', 'filing-notebook')}
        <span className="note-field-side" />
      </div>
      <div className="note-field filing-prop">
        <span className="note-field-glyph" aria-hidden="true">
          <TagIcon />
        </span>
        <span className="note-field-label">Tags</span>
        {tagInput}
        <span className="note-field-side" />
      </div>
    </>
  );

  /**
   * The note's fields, as a property list, for whichever place this width gives them.
   *
   * Out of the filing block: the notebook and the tags are a line, and the fields are a
   * list that is as much the note as its body is — a coupon's code, a game's rating. On a
   * desktop they take a column of their own beside the note, so a long list never pushes
   * the body down; on a phone they sit above the body, in flow, and the body follows, the
   * way Notion's page does. That is a deliberate trade, chosen over the sheet the fields
   * used to share with the notebook picker: what the sheet hid was the note's own data.
   */
  const fieldsBlock = (lead?: React.ReactNode) =>
    !note ? null : (
      <NoteFields
        lead={lead}
        definitions={fieldDefs.data}
        values={draft.fields}
        carried={note.fields ?? []}
        notebookId={currentNotebook?.id ?? null}
        readOnly={readOnly}
        onChange={(fieldId, value) =>
          setDraft((d) => ({ ...d, fields: { ...d.fields, [fieldId]: value } }))
        }
        onAddField={addField}
        manage={
          currentNotebook && (
            <Link
              to="/settings/notebooks/$notebookId"
              params={{ notebookId: currentNotebook.id }}
              className="link small note-fields-manage"
            >
              Manage fields
            </Link>
          )
        }
      />
  );

  async function removeNote() {
    await api.deleteNote(noteId);
    await queryClient.invalidateQueries({ queryKey: ['notes'] });
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
    // Invalidate search results so a deleted note disappears from any active search.
    void queryClient.invalidateQueries({ queryKey: ['search'] });
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
        {/*
            The way back, which this branch used to leave out.

            It returned an error card and nothing else, on the reasoning that the topbar
            above it already offered a way out. Below the breakpoint that topbar is hidden
            now, so on a phone this state had no route anywhere except the "Clear" link in
            the card — and "Clear" reads as dismissing a message, not as leaving the view.

            The same row the loaded note draws, minus the controls that need a note to act
            on. `backTo` is carried so a trashed note that fails to load returns to the
            trash rather than the note list.
        */}
        <div className="workspace-head workspace-error-head">
          <div className="workspace-title-row">
            <Link
              to={backTo}
              search={(p) => p}
              className="view-back"
              aria-label="Back to notes"
              viewTransition={{ types: ['note-close'] }}
            >
              <BackArrow />
            </Link>
          </div>
        </div>

        <div className="workspace-error">
          <p className={missing ? 'muted' : 'bad'}>
            {missing
              ? "That note doesn't exist, or was deleted."
              : `Couldn't load that note. ${(error as Error).message}`}
          </p>
          {missing ? (
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: '/notes', search: (p) => p })}
            >
              Clear
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void refetch()}>
              Retry
            </Button>
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
          Two columns on a desktop: the note, and its fields beside it.

          The fields used to sit above the body with the notebook and tags, which put a
          long list between the title and the text. A column of their own means the body
          starts at the same height whatever the notebook defines, and the list scrolls in
          its own space rather than the note's. Notion pins its properties above; this is
          the wider screen's better answer to the same wish. The panel is always drawn, so
          the note's width does not change between a filed note and an unfiled one — an
          unfiled note's panel says how to get fields instead.
      */}
      <div className="workspace-main">
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
            className="view-back"
            aria-label="Back to notes"
            // The reverse of the entry's `note-open`; the arrow is only ever shown on a
            // phone, where the note shrinks back into the row it grew from.
            viewTransition={{ types: ['note-close'] }}
          >
            <BackArrow />
          </Link>
          {/*
              Enter hands the note over to the body, and is the only way there from this
              field without reaching for the mouse.

              Tab cannot be it. The save state, the ⋯ menu and the toolbar's twelve
              controls all sit between this field and the editor in the DOM, so Tab is
              several presses from the text — and it is also how those controls are reached
              on purpose, which taking it would cost.

              The same move the sidebar's Enter makes, through the same registration, so
              the caret lands at the end of the document in both cases rather than at the
              end from the list and the start from here.
          */}
          <input
            ref={titleRef}
            className="title-input"
            value={draft.title}
            placeholder="Untitled"
            readOnly={readOnly}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              focusEditor();
            }}
          />
        </div>

        <div className="workspace-actions">
          <span className={saveState === 'error' ? 'bad small' : 'muted small'}>
            {readOnly ? 'In trash' : saveLabel}
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
          The note's filing: a notebook, its tags, and the notebook's own fields.

          On a desktop the notebook and the tags sit in flow on a row above the body, where
          a pair of pickers costs nothing, and the fields have a column of their own beside
          the note. On a phone all of it is the property list, pinned above the body: the
          notebook and the tags as its first two rows, the fields after them. That block is
          capped and scrolls within, since `.workspace` itself does not — see
          `.fields-inline` — so a long notebook cannot push the body off the screen.

          There used to be a sheet here on a phone, opened from a row that stated the
          filing. It earned its place holding six controls; once the fields moved onto the
          page it held two, and a modal surface for two controls the row already showed
          was ceremony. Not the overflow menu, at either width: this is what the note *is*,
          and in an archive this size tags are how anything gets found again.
      */}
      {filingControls &&
        (isMobile ? (
          <div className="fields-inline">{fieldsBlock(filingRows)}</div>
        ) : (
          <Disclosure className="tag-row-wrap" defaultOpen="wide" summary={<>Details</>}>
            {filingControls}
          </Disclosure>
        ))}

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
            /*
               Stands down for a note that was just created: the title has the caret, and
               an editor grabbing it on mount would take it straight back.

               And on a touch device, for every note. Taking focus there raises the keyboard
               over half the screen before anything has been tapped — so opening a note to
               read one costs a dismissal first, and the note is half hidden while you do
               it. Every notes app worth copying opens an existing note reading; the
               keyboard is the reader's decision, and the body is one tap away. A new note
               is the exception that is already handled above: it was created to be typed
               into, and its caret goes to the title.
            */
            autoFocus={!cameFromList && !isNewNote && !touch}
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
      </div>

      {!isMobile && (
        <aside className="fields-panel" aria-label="Fields">
          <h3 className="fields-panel-head">Fields</h3>
          {fieldsBlock() ?? (
            <p className="muted small">File this note in a notebook to give it fields.</p>
          )}
        </aside>
      )}
    </section>
  );
}
