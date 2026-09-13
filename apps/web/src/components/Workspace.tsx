import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import type { FieldDef, FieldType, FieldValue } from '@unbent/shared';
import * as api from '../notes-api.js';
import { isStatus } from '../notes-api.js';
import { buildNotePatch, rememberFieldDefs, unstoreableFieldIds } from '../note-patch.js';
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
import { EditorToolbar, type NoteView } from './EditorToolbar.js';
import { Attachments } from './Attachments.js';
import { ResizeHandle } from './ResizeHandle.js';
import { OverflowMenu } from './OverflowMenu.js';
import { Button } from './Button';
import { BackArrow } from './BackArrow.js';
import { FilingRows } from './FilingRows.js';
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
  /*
     Every definition this session has loaded, not only the current notebook's.

     A newly typed value has no stored row yet, so the patch can encode it only from a
     definition. Changing the notebook swaps `fieldDefs` for the new notebook's — or
     undefined while they load — and used to drop that value: Amount typed, note filed,
     Amount gone. The editor still renders `fieldDefs.data`; this list is for the save.
  */
  const seenFieldDefs = useRef(new Map<string, FieldDef>());
  const knownFieldDefs = rememberFieldDefs(seenFieldDefs.current, fieldDefs.data);
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
    const patch = buildNotePatch(value, note, knownFieldDefs);
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
  const holdingField = editing && unstoreableFieldIds(draft, note, knownFieldDefs).length > 0;
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
   * The notebook and the tags as the first two rows of the property list, at every width.
   *
   * They used to be a row that opened a sheet holding them — a full-height modal surface
   * for a select and a chip, once the fields had left it, and a tap that bought nothing the
   * row had not already said. `FilingRows` is the shared drawing; the Android app's embed
   * draws the same rows.
   */
  const filingRows = !note ? null : (
    <FilingRows
      notebook={draft.notebook}
      notebooks={notebooks.data?.notebooks}
      tags={draft.tags}
      suggestions={tags.data?.map((t) => t.name) ?? []}
      readOnly={readOnly}
      onNotebook={(next) => setDraft((d) => ({ ...d, notebook: next }))}
      onTags={(next) => setDraft((d) => ({ ...d, tags: next }))}
    />
  );

  /**
   * The note's fields, as a property list, above the body at every width.
   *
   * The fields are a list that is as much the note as its body is — a coupon's code, a
   * game's rating — and with the notebook and the tags as its first two rows (`lead`) it
   * is the whole of how the note is filed, the way Notion's page states its properties
   * before its text. They used to take a column of their own beside the note on a desktop,
   * so a long list never pushed the body down; the column scrolls as one document now, so
   * the list is simply the top of the note, and a desktop too narrow to spare the height
   * starts it folded. A deliberate trade, chosen over the sheet the fields used to share
   * with the notebook picker: what the sheet hid was the note's own data.
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
          One column at every width: the note, with its property list above the body.

          The fields used to have a column of their own beside the note on a desktop, so a
          long list never pushed the body down — and that put the notebook and tags in one
          place, the fields in another, and the two drawn differently from the phone. The
          column scrolls as one document now, under a title that stays, so the list is
          simply the top of the note the way Notion pins a page's properties, and one
          layout serves every width.
      */}
      <div
        className="workspace-main"
        /*
            How much of the screen the keyboard is covering, for the stylesheet.

            On a phone this column is the note's one scroll region, and a keyboard covers
            the bottom of it: without room past the last line, the end of a note can never
            be scrolled up above the keys. The phone rules pad the column's bottom by this
            much, so the whole note stays reachable while typing. `useKeyboardInset`
            reads 0 wherever there is no keyboard, so the padding costs nothing then.
        */
        style={{ '--keyboard-inset': `${keyboardInset}px` } as React.CSSProperties}
      >
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
          The note's filing: the notebook, its tags, and the notebook's own fields, as one
          property list above the body.

          The same list at every width — the notebook and the tags as its first two rows,
          the fields after them — because it is one record, and a desktop that drew the
          first two as a row of pickers and the rest in a column beside the note was the
          same record in two hands. The column scrolls as a document (see `.workspace-main`),
          so the list is the top of the note and takes the height it needs — open at every
          width. It was briefly folded closed between the phone and the full desktop, a
          habit left over from when the fields had a column of their own that a 960px
          screen could not spare; above the body the list costs only height, which the
          phone spends without complaint, and a fold at one width alone read as a glitch.

          There used to be a sheet here on a phone, opened from a row that stated the
          filing. It earned its place holding six controls; once the fields moved onto the
          page it held two, and a modal surface for two controls the row already showed
          was ceremony. Not the overflow menu, at any width: this is what the note *is*,
          and in an archive this size tags are how anything gets found again.
      */}
      <div className="fields-inline">{fieldsBlock(filingRows)}</div>

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
    </section>
  );
}
