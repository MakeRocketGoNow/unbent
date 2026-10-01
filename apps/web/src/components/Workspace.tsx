import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import type { FieldDef, FieldType, FieldValue, Note } from '@unbent/shared';
import { localizeImageLinks, remoteImageUrls } from '@unbent/shared';
import * as api from '../notes-api.js';
import { isOfflineError, isStatus, servedFromCache } from '../notes-api.js';
import { useOffline } from '../connectivity.js';
import {
  buildNotePatch,
  holdsTheirChanges,
  rememberFieldDefs,
  seedFrom,
  unstoreableFieldIds,
} from '../note-patch.js';
import { useAutosave, SAVE_LABEL } from '../useAutosave.js';
import { usePersistentState, clamp } from '../usePersistentState.js';
import {
  useCameFromList,
  registerEditorFocus,
  focusActiveListItem,
  focusEditor,
} from '../useListKeys.js';
import { registerOpenNoteFieldEdit, registerOpenNoteFilingEdit } from '../open-note-fields.js';
import { useIsNewNote } from '../useNewNote.js';
import { holdPage } from '../busy.js';
import { useMediaQuery, MOBILE_QUERY, TOUCH_QUERY } from '../useMediaQuery.js';
import { useKeyboardInset } from '../useKeyboardInset.js';
import {
  attachmentsQuery,
  configQuery,
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
import { Confirm } from './Confirm.js';
import { Snackbar } from './Snackbar.js';
import { AutofillIcon } from './icons.js';
import { formatFieldValue } from './format-field.js';
import { applySaveToLists } from '../list-cache.js';
import {
  applyAutofill,
  describeChanges,
  isEmptyChanges,
  planAutofill,
  type AutofillChanges,
} from '../autofill.js';

/** The editor's share of the pane row when split evenly, and the limits a drag respects. */
const EDITOR_DEFAULT = 0.5;
const EDITOR_MIN = 0.2;
const EDITOR_MAX = 0.8;


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
  /*
     Offline, or showing a copy that came from the service worker's cache: the note reads
     as usual and nothing about it can change. A copy from the cache stays locked after
     the connection returns, until the server has answered for this note — see
     `servedFromCache` for why unlocking the old text would be a lost edit.

     Kept apart from `readOnly`, which is the trash's and turns the autosave off. This
     leaves the autosave running, so typing the lock arrived a second too late for is
     held and saved when the connection comes back rather than dropped.
  */
  const offline = useOffline();
  const readFromCache = servedFromCache(note);
  /*
     The cached copy the draft was seeded from, until the server's copy replaces it. State,
     not a ref, so the note stays locked through the render in which the server's copy
     arrives and the effect below has not yet re-seeded the draft from it.
  */
  const [seededFromCache, setSeededFromCache] = useState<typeof note>(undefined);
  const locked = offline || readFromCache || seededFromCache !== undefined;
  const notebooks = useQuery(notebooksQuery());
  const tags = useQuery(tagsQuery());
  const config = useQuery(configQuery());

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
  /**
   * Bumped when the draft is seeded again for the same note, so the autosave takes the new
   * seed as its baseline instead of as an edit to save.
   */
  const [seedGeneration, setSeedGeneration] = useState(0);

  /**
   * The copy of each note the draft is measured against: what it was seeded from, then
   * what each save came back as. A save sends only what differs from it, and names its
   * `updatedAt` so the server can refuse the save if the note has moved on since.
   *
   * Kept apart from the query cache's copy on purpose. That one is replaced by any
   * refetch, and a draft diffed against a copy it was never seeded from sends its stale
   * keys as edits: the phone's new title arrives in the cache, the draft still holds the
   * old one, and the next keystroke in the body writes the old title back — with a
   * precondition that passes, because it was taken from the same fresh copy.
   *
   * By note id rather than one ref, because a save can outlive the note being open:
   * switching notes flushes the outgoing draft after the incoming note has been seeded,
   * and that flush must still be measured against the note it belongs to.
   */
  const bases = useRef(new Map<string, Note>());

  /**
   * A save refused because the note changed on another device, with the note as it now
   * stands. The note head offers both ways out; the editor is locked until one is taken,
   * so the typing stays exactly as it was on screen. By id, so it never shows on another
   * note opened meanwhile.
   */
  const [conflict, setConflict] = useState<{ id: string; current: Note } | null>(null);
  const conflicted = conflict !== null && conflict.id === noteId;
  const conflictNotice = useRef<HTMLDivElement>(null);
  /*
     The notice sits under the head but scrolls with the note, and the refusal comes while
     someone is typing — on a long note, far below it. The inputs lock at the same moment,
     so without this the editor simply stops taking keys, with the two ways out off-screen
     above. Guarded because jsdom has no scrollIntoView, as `Confirm` guards it.
  */
  useEffect(() => {
    if (conflicted) conflictNotice.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [conflicted]);
  /**
   * Whether the note's inputs take edits: not offline, and not while a conflict waits on a
   * choice. Typing on during one would only be refused again, and the choice is between
   * two versions the person can see — a third, still moving, would make it a guess.
   */
  const frozen = locked || conflicted;

  /** Set by "Keep mine": the next save of this note goes against this copy instead. */
  const keepMine = useRef<{ id: string; updatedAt: number } | null>(null);

  /*
     Leaving a note with the question unanswered drops what was typed there, as Reload
     would. The refused save is still held for a retry, and the switch would flush it: refused
     again, it set the save state the incoming note shows to "Not saved" with no notice to
     say why, kept the page held against a deploy, and went out again on every tab hide.

     Declared before the autosave so this runs ahead of its own reset, which is where the
     flush happens.
  */
  useEffect(() => {
    if (!conflict || conflict.id === noteId) return;
    discard();
    keepMine.current = null;
    setConflict(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  /**
   * Re-seeds the open note from a copy of it the server just gave, rebuilding the editor
   * only when the body is what changed — a title or a tag from elsewhere has no reason to
   * throw away the caret and the undo history. The bump to `seedGeneration` makes the
   * autosave take the new copy as its baseline rather than as an edit to save.
   */
  function reseed(from: Note, showing: string) {
    bases.current.set(from.id, from);
    queryClient.setQueryData(keys.note(from.id), from);
    setDraft(seedFrom(from));
    setEditorOverride(null);
    if (from.body !== showing) setEditorRevision((n) => n + 1);
    setSeedGeneration((n) => n + 1);
  }

  // Seed the draft when a different note loads. Keyed on id, not on the note object,
  // so a background refetch never discards what is being typed.
  useEffect(() => {
    if (!note) return;
    bases.current.set(note.id, note);
    setDraft(seedFrom(note));
    setDraftFor(note.id);
    setEditorOverride(null);
    setSeededFromCache(readFromCache ? note : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, note !== undefined]);

  /*
     The one refetch that does replace the draft: the server's copy arriving for a note
     that was seeded from the cache. Nothing typed is lost — the note was locked the whole
     time — and the old text must not survive into the unlocked editor, where the first
     keystroke would save it over whatever another device saved meanwhile. The editor is
     rebuilt on the new text for the same reason; with nothing typed, there is no history
     worth keeping.

     The first copy on screen that did not come from the cache is the server's answer.
     Another copy from the cache — the first refetch after the connection returns can be
     answered from it, on a radio not yet carrying anything — is not, and keeps waiting.
     A copy from the server that says the same as the cached one leaves the draft alone.
  */
  useEffect(() => {
    if (!seededFromCache || !note || servedFromCache(note)) return;
    setSeededFromCache(undefined);
    bases.current.set(note.id, note);
    if (JSON.stringify(seedFrom(note)) === JSON.stringify(seedFrom(seededFromCache))) return;
    setDraft(seedFrom(note));
    setEditorOverride(null);
    setEditorRevision((n) => n + 1);
    setSeedGeneration((n) => n + 1);
  }, [note, seededFromCache]);

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
    const base = bases.current.get(noteId);
    if (!note || !base) return 'unchanged';
    /*
       Only the keys that actually changed, and only field values the type can store.
       Sending the whole draft used to 400 a body save on a half-typed number, and to
       write the stale title back over a rename the phone had already saved — see
       `buildNotePatch`. Nothing storeable is a successful no-op: the debounce fired
       because the draft moved, but the movement was not yet a value the server can hold.

       Reported as 'unchanged' rather than returning bare, so the head does not flash
       "Saved" for a save that never left the browser — a space typed and deleted is the
       ordinary way to get here.
    */
    const patch = buildNotePatch(value, base, knownFieldDefs);
    if (!patch) return 'unchanged';

    /*
       Against the copy the draft came from, so a save made after another device saved
       this note is refused rather than written over it (MAK-113). "Keep mine" sends it
       again against the copy the refusal brought back, which is still a precondition:
       a third save landing while the choice was on screen is refused in turn.
    */
    const choosing = keepMine.current?.id === noteId ? keepMine.current : null;
    let updated: Note;
    try {
      updated = await api.updateNote(noteId, { ...patch, ifUpdatedAt: choosing?.updatedAt ?? base.updatedAt });
    } catch (err) {
      if (!api.isNoteChanged(err)) throw err;
      // Nothing of theirs would be lost — see `holdsTheirChanges` — so this is a date that
      // moved, not a choice to put to anyone.
      if (!choosing && holdsTheirChanges(value, base, err.current)) {
        try {
          updated = await api.updateNote(noteId, { ...patch, ifUpdatedAt: err.current.updatedAt });
        } catch (again) {
          // A third save landed between the two. That one is a choice, put the same way as
          // a first refusal: let through bare, it left a red "Not saved" with no notice and
          // the inputs still open.
          if (api.isNoteChanged(again)) setConflict({ id: noteId, current: again.current });
          throw again;
        }
      } else {
        // A "Keep mine" refused in turn asks again, against the newer copy it brought back.
        keepMine.current = null;
        setConflict({ id: noteId, current: err.current });
        throw err;
      }
    }
    bases.current.set(noteId, updated);
    queryClient.setQueryData(keys.note(noteId), updated);
    if (choosing) {
      // Kept: the note is now this draft plus whatever of theirs the draft never touched —
      // a title renamed elsewhere survives a body kept here — so the editor shows that.
      keepMine.current = null;
      setConflict(null);
      reseed(updated, value.body);
    }
    // The lists get the saved row rather than a refetch of every page they hold — see
    // `applySaveToLists`, which refetches only a list the save may have moved it in or out of.
    applySaveToLists(queryClient, updated, {
      title: patch.title !== undefined,
      notebook: patch.notebook !== undefined,
      tags: patch.tags !== undefined,
      fields: patch.fields !== undefined,
    });
    /*
     * The sidebar's counts only when this save could have moved them — the same rule the
     * phone's editor already keeps. Both lists count across the whole archive, and this
     * runs on every pause in typing: refetching them for a body edit cost tens of
     * thousands of rows read per save on a large archive, for numbers that could not
     * have changed.
     */
    if (patch.notebook !== undefined) void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
    if (patch.tags) void queryClient.invalidateQueries({ queryKey: keys.tags() });
  }

  const editing = note !== undefined && !readOnly && draftFor === noteId;

  /*
     Lets the table beside this note change one of its fields. The edit lands in the draft
     and saves like one typed in the property list below — see `open-note-fields.ts` for
     why the table cannot save it directly. Withdrawn when this stops being the note
     being edited.
  */
  useEffect(() => {
    if (!editing) return;
    return registerOpenNoteFieldEdit(noteId, (fieldId, value) =>
      setDraft((d) => ({ ...d, fields: { ...d.fields, [fieldId]: value } })),
    );
  }, [editing, noteId]);

  /*
     And its filing, for a bulk action on the list that includes this note: the notebook
     it was moved to, the tags it gained or lost. Into the draft for the same reason —
     the next autosave would otherwise write the old filing back over the batch.
  */
  useEffect(() => {
    if (!editing) return;
    return registerOpenNoteFilingEdit(noteId, (change) =>
      setDraft((d) => ({
        ...d,
        ...(change.notebook !== undefined ? { notebook: change.notebook } : {}),
        ...(change.tags ? { tags: change.tags(d.tags) } : {}),
      })),
    );
  }, [editing, noteId]);

  const {
    state: saveState,
    flush,
    discard,
  } = useAutosave(draft, save, {
    // Never autosave while viewing the trash: a note in the bin is a record of what was
    // deleted, and writing to it would be editing something the user believes is gone.
    // `draftFor === noteId` keeps a draft still holding the previous note's text from
    // being written over this one during the render between navigation and reseeding.
    enabled: editing,
    resetKey: `${noteId}:${seedGeneration}`,
    isConflict: api.isNoteChanged,
  });

  /** Reload: the other device's version, and the typing here dropped. */
  function takeTheirs() {
    if (!conflict) return;
    discard();
    keepMine.current = null;
    setConflict(null);
    reseed(conflict.current, draftRef.current.body);
    applySaveToLists(queryClient, conflict.current, { title: true, notebook: true, tags: true, fields: true });
  }

  /** Keep mine: this draft saved over the version the refusal brought back. */
  function keepOurs() {
    if (!conflict) return;
    keepMine.current = { id: conflict.id, updatedAt: conflict.current.updatedAt };
    void flush();
  }

  /*
     Coming back to the tab is the usual moment another device has saved this note: the
     phone was in use while the tab sat in the background. With nothing typed here since
     the last save, the server's copy simply replaces the draft, and the first keystroke
     is made on top of it rather than refused for having been made against the old one.

     Only when the draft is clean, and only if it is still clean when the answer arrives:
     typing that started during the fetch is left alone, and the precondition settles it
     at its save. A copy from the offline cache is not the server's answer and changes
     nothing. Refetching through the query keeps the cache in step either way.
  */
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  useEffect(() => {
    if (!editing) return;
    const clean = () => saveStateRef.current === 'idle' || saveStateRef.current === 'saved';
    const onShow = async () => {
      if (document.visibilityState !== 'visible' || !clean()) return;
      const before = draftRef.current;
      const { data: fresh } = await refetch();
      const base = bases.current.get(noteId);
      if (!fresh || !base || servedFromCache(fresh) || fresh.updatedAt === base.updatedAt) return;
      if (draftRef.current !== before || !clean()) return;
      reseed(fresh, before.body);
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, noteId]);

  /*
     The connection back: a save that failed for want of one — typing that landed in the
     moment before the editor locked — goes now rather than waiting for the next keystroke,
     which a locked editor could not have taken anyway.
  */
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) void flush();
    wasOffline.current = offline;
  }, [offline, flush]);

  /*
     Typing the autosave has not sent, a save in flight or one that failed and waits to
     be retried, and files still uploading all live in this page and nowhere else. While
     any of them is true, a waiting deploy does not reload the app on the next navigation
     — see `busy.ts`.
  */
  const [uploadsPending, setUploadsPending] = useState(0);
  const unsent =
    saveState === 'dirty' || saveState === 'saving' || saveState === 'error' || saveState === 'conflict';
  useEffect(() => (unsent || uploadsPending > 0 ? holdPage() : undefined), [unsent, uploadsPending]);

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
  /*
     A save that failed because the connection went is not "Save failed" in red: nothing is
     wrong with the note, the typing is held, and it goes when the connection does. The
     banner has said why; this says what it means for this note.
  */
  const unsavedOffline = saveState === 'error' && offline;
  const saveLabel = unsavedOffline
    ? 'Not saved — offline'
    : holdingField && saveState === 'saved'
      ? SAVE_LABEL.dirty
      : SAVE_LABEL[saveState];

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
      readOnly={readOnly || frozen}
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
        readOnly={readOnly || frozen}
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

  /**
   * Saves what is on screen first: the copy is made from the stored note, and the last
   * edit may still be inside the autosave's delay.
   */
  async function duplicateNote() {
    await flush();
    const copy = await api.duplicateNote(noteId);
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    void queryClient.invalidateQueries({ queryKey: ['search'] });
    invalidateNoteMembership(queryClient);
    void navigate({ to: '/notes/$noteId', params: { noteId: copy.id }, search: (p) => p });
  }

  /** The addresses the draft's images are drawn from; what "Save web images" counts. */
  const remoteImages = useMemo(() => remoteImageUrls(draft.body), [draft.body]);
  const draftBodyRef = useRef(draft.body);
  draftBodyRef.current = draft.body;
  /** What the last "Save web images" is doing or did, in the head where "Saved" goes. */
  const [webImagesStatus, setWebImagesStatus] = useState<string | null>(null);

  /** One web image into the note, for the toolbar on the picture. */
  async function saveRemoteImage(url: string): Promise<string> {
    const saved = await api.fetchWebImage(noteId, url);
    void queryClient.invalidateQueries({ queryKey: keys.attachments(noteId) });
    return saved.filename;
  }

  /**
   * Every web image in the note, in one pass.
   *
   * One request per address, in sequence, so a note with thirty pictures does not open
   * thirty fetches against one site at once. The body is rewritten once at the end from
   * the draft as it stands then, not as it stood when the pass began, so anything typed
   * meanwhile survives; an address the site refused keeps its web link, and the count
   * in the head says how many did.
   *
   * Workspace is reused across notes, and this pass outlives a switch the same way
   * Auto-fill's round trip does. `startedFor` is what keeps it honest: `draftBodyRef` is
   * the incoming note's after a switch, so rewriting from it would write the previous
   * note's localized links onto the one now open — and the status would land on it too.
   * Bail once `noteIdRef` has moved on. The images already fetched stay stored on the note
   * they belong to; coming back to it starts a new press, as with `runAutofill`.
   */
  async function saveWebImages() {
    const startedFor = noteId;
    await flush();
    if (noteIdRef.current !== startedFor) return;
    const urls = remoteImageUrls(draftBodyRef.current);
    const stored = new Map<string, string>();
    let failed = 0;
    for (const [i, url] of urls.entries()) {
      if (noteIdRef.current !== startedFor) return;
      setWebImagesStatus(`Saving ${i + 1} of ${urls.length}…`);
      try {
        stored.set(url, (await api.fetchWebImage(startedFor, url)).filename);
      } catch {
        failed += 1;
      }
    }
    if (noteIdRef.current !== startedFor) return;
    if (stored.size > 0) {
      rewriteBody(localizeImageLinks(draftBodyRef.current, (url) => stored.get(url) ?? null));
      void queryClient.invalidateQueries({ queryKey: keys.attachments(startedFor) });
    }
    // Short, because it sits beside the title, which a phone gives little room. A count
    // short of the total says a fetch failed; the picture that kept its web link is the
    // one still drawn from the web, with its save control still offered.
    const noun = (n: number) => `${n} image${n === 1 ? '' : 's'}`;
    setWebImagesStatus(
      failed === 0 ? `Saved ${noun(stored.size)}` : `Saved ${stored.size} of ${noun(urls.length)}`,
    );
    setTimeout(() => setWebImagesStatus(null), 5000);
  }

  function rewriteBody(nextBody: string) {
    setDraft((d) => ({ ...d, body: nextBody }));
    setEditorOverride(nextBody);
    setEditorRevision((n) => n + 1);
  }

  /**
   * The draft as it stands, for auto-fill to plan against after its round trip: the plan
   * compares the suggestion with what is on screen when the answer arrives, not with
   * what was there when the button was pressed. That is a same-note comparison — the
   * user typing a title while Jev reads — not a licence to file the next note. `noteIdRef`
   * is what makes the distinction: after a switch, this draft is the incoming note's.
   */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  /**
   * The bottom-of-screen result of the last Auto-fill: what it filled, or why it couldn't.
   * A success carries an Undo and clears itself; an error stays until dismissed. Replaces
   * the header status line the result used to fade in beside the title. See `Snackbar`.
   */
  const [snackbar, setSnackbar] = useState<{
    message: string;
    tone: 'info' | 'error';
    action?: { label: string; onClick: () => void };
    duration?: number;
  } | null>(null);
  const [autofilling, setAutofilling] = useState(false);
  /** Changes that would replace something already set, waiting to be confirmed. */
  const [autofillReplace, setAutofillReplace] = useState<AutofillChanges | null>(null);
  /**
   * Set when the last Auto-fill told us — and it tells only an operator — that the title
   * model rejected its key. A standing fault, not a passing one, so it holds as a
   * dismissible notice rather than a status that fades, until the operator dismisses it or
   * leaves the note. See the server's `lib/autofill.ts` and `titleModel`.
   */
  const [titleModelFault, setTitleModelFault] = useState(false);

  /*
     A round trip outlives a note switch — Workspace is reused, the same way autosave is.
     Drop the in-flight head UI here so a "Reading…", a replace confirm, or a "Saving…"
     from the previous note cannot sit on this one. The requests themselves are left to
     finish; wasting one is cheaper than landing it on the wrong note, which `runAutofill`
     and `saveWebImages` both now refuse once `noteIdRef` has moved on.
  */
  useEffect(() => {
    setAutofilling(false);
    setAutofillReplace(null);
    setSnackbar(null);
    setTitleModelFault(false);
    setWebImagesStatus(null);
  }, [noteId]);

  /** A success snackbar that clears itself after a few seconds, with an optional Undo. */
  function showFillResult(message: string, action?: { label: string; onClick: () => void }) {
    setSnackbar({ message, tone: 'info', action, duration: 5000 });
  }

  /**
   * Fills in the note's filing from what it says: see `autofill.ts` for the rule, and the
   * API's `lib/autofill.ts` for what is read. The draft is flushed first so the server
   * reads the note as it is on screen, and the suggestion's definitions are remembered
   * before its values land, so the patch can encode a value for a notebook whose fields
   * this session has not loaded yet — the same gap `rememberFieldDefs` closes for a
   * typed value.
   */
  async function runAutofill() {
    const startedFor = noteId;
    setAutofilling(true);
    setAutofillReplace(null);
    // The press is its own progress now — the button goes busy; the last result, if one is
    // still up, clears so it can't be mistaken for this press's answer.
    setSnackbar(null);
    try {
      await flush();
      // Left this note during the flush: don't spend a Jev round-trip on a note that
      // is no longer open. Coming back to it starts a new press.
      if (noteIdRef.current !== startedFor) return;
      /*
         The note's files, beside the suggestion rather than after it, so a title that is
         only a file's name is filled over instead of offered (`isPlaceholderTitle`). The
         attachments panel has usually loaded them already, so this is the cache; a list
         that fails to load costs only that — the title is offered, as it was before.
      */
      const [suggestion, files] = await Promise.all([
        api.autofillNote(startedFor),
        queryClient.ensureQueryData(attachmentsQuery(startedFor)).catch(() => []),
      ]);
      if (noteIdRef.current !== startedFor) return;
      // Set only for an operator, and only when the title model rejected its key; a
      // standing notice, separate from the snackbar, so it survives the fill's success.
      setTitleModelFault(suggestion.titleModel === 'auth-failed');
      for (const { field } of suggestion.fields) seenFieldDefs.current.set(field.id, field);
      const plan = planAutofill(
        draftRef.current,
        suggestion,
        files.map((f) => f.filename),
      );
      const stillReading = suggestion.read.pending.length > 0 ? ' — a file is still being read' : '';
      if (isEmptyChanges(plan.fill)) {
        showFillResult(`Nothing empty to fill in${stillReading}`);
      } else {
        // The draft as it stood, captured before the fill lands, so Undo is one assignment
        // back to it — `applyAutofill` returns a new object and never touches this one.
        const before = draftRef.current;
        setDraft((d) => applyAutofill(d, plan.fill));
        showFillResult(`Filled in ${describeChanges(plan.fill)}${stillReading}`, {
          label: 'Undo',
          onClick: () => setDraft(before),
        });
      }
      if (!isEmptyChanges(plan.replace)) setAutofillReplace(plan.replace);
    } catch (err) {
      if (noteIdRef.current !== startedFor) return;
      // The server's own sentence, without the status it arrives prefixed with: "422:
      // Nothing to read yet…" is not what a person wants to read. A failure stays until
      // dismissed rather than fading — no `duration`.
      setSnackbar({ message: (err as Error).message.replace(/^\d{3}[^:]*: /, ''), tone: 'error' });
    } finally {
      if (noteIdRef.current === startedFor) setAutofilling(false);
    }
  }

  /**
   * A note id can arrive from a shared link or a reload long after the note was deleted,
   * so a failure here is expected rather than exceptional. The id deliberately stays in
   * the URL so the link remains copyable and retryable; this explains what happened
   * instead. A 404 and a transport failure need different words and different recovery.
   */
  if (error) {
    const missing = isStatus(error, 404);
    /*
       A third case: no connection, and no copy of this note on the device, because it was
       never opened here. Not a failure — muted, like the 404 — and no Retry, since the
       note loads by itself when the connection returns (`connectivity.ts` refetches what
       is on screen).
    */
    const unavailable = isOfflineError(error);
    return (
      <section className="workspace">
        {/*
            The way back, which this branch used to leave out.

            It returned an error card and nothing else, on the reasoning that the topbar
            above it already offered a way out. Below the breakpoint that topbar is hidden
            (and above it the rail has taken its place), so on a phone this state had no
            route anywhere except the "Clear" link in
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
          <p className={missing || unavailable ? 'muted' : 'bad'}>
            {missing
              ? "That note doesn't exist, or was deleted."
              : unavailable
                ? "This note hasn't been opened on this device, so it isn't available offline."
                : `Couldn't load that note. ${(error as Error).message}`}
          </p>
          {unavailable ? null : missing ? (
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
            readOnly={readOnly || frozen}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              focusEditor();
            }}
          />
        </div>

        <div className="workspace-actions">
          {/* Cut with an ellipsis before the title is, and carried whole in the tooltip;
              see `.workspace-status`. */}
          <span
            className={`workspace-status ${(saveState === 'error' && !unsavedOffline) || saveState === 'conflict' ? 'bad' : 'muted'} small`}
            title={webImagesStatus ?? saveLabel}
          >
            {readOnly ? 'In trash' : (webImagesStatus ?? saveLabel)}
          </span>

          {/*
              Auto-fill: the one action promoted out of the ⋯ below, because it is the
              reason a scanned note gets opened at all — the scanner made the note, and
              filing it is the next thing — and a control reached through a menu is one
              nobody learns is there. Quiet, so it does not outrank the title beside it,
              and only where the instance can answer (`config.autofill`); a trashed note
              has no filing to fill. Below the breakpoint the label goes and the sparkle
              stays, a 44px target, so the title keeps its line.
          */}
          {!readOnly && config.data?.autofill && (
            <Button
              variant="quiet"
              size="small"
              className={`autofill-btn${autofilling ? ' busy' : ''}`}
              // Disabled rather than withdrawn offline, so the title beside it does not
              // widen when the connection drops and narrow when it returns.
              disabled={autofilling || frozen}
              aria-label={autofilling ? 'Reading…' : 'Auto-fill'}
              title={
                locked
                  ? 'Auto-fill needs a connection'
                  : 'Fill in the title, notebook, tags and fields from what the note and its files say'
              }
              onClick={() => void runAutofill()}
            >
              <AutofillIcon />
              {/* The press carries its own progress: the sparkle spins and the label says
                  what it is doing, so the result no longer needs a "Reading…" in the head. */}
              <span className="autofill-label">{autofilling ? 'Reading…' : 'Auto-fill'}</span>
            </Button>
          )}

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
                // Every item here needs the server. Faded, not withdrawn, for the reason
                // Auto-fill is.
                disabled={locked}
                title={locked ? 'Not available offline' : undefined}
                items={[
                  // Only when there is something to save; the count says how much.
                  ...(remoteImages.length > 0
                    ? [
                        {
                          label: `Save ${remoteImages.length} web image${remoteImages.length === 1 ? '' : 's'}`,
                          onSelect: () => void saveWebImages(),
                        },
                      ]
                    : []),
                  { label: 'Duplicate', onSelect: () => void duplicateNote() },
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
          A save this note refused because another device saved it first (MAK-113). Under
          the head, where the save state reports, and inline rather than a dialog: the
          typing it is about stays on screen, locked, to be read before choosing, and a
          modal would cover exactly that. No dismiss — the typing exists nowhere but here
          until one of the two is chosen, and closing the question would leave it so.

          Neither action is filled: each throws a version away, and which one is right
          depends on what was typed where, which only the person knows. The sentence names
          what each costs so the buttons can stay two words.
      */}
      {conflicted && (
        <div ref={conflictNotice} className="conflict-notice" role="alert">
          <p>
            <strong>This note changed on another device.</strong>{' '}
            <span className="muted">
              Reload shows that version and drops what you typed here. Keep mine saves yours
              over it.
            </span>
          </p>
          <div className="conflict-notice-actions">
            <Button size="small" disabled={saveState === 'saving'} onClick={takeTheirs}>
              Reload
            </Button>
            <Button size="small" disabled={saveState === 'saving'} onClick={keepOurs}>
              {saveState === 'saving' ? 'Saving…' : 'Keep mine'}
            </Button>
          </div>
        </div>
      )}

      {/*
          Operator-only: the title model rejected its key. Shown only to whoever runs the
          instance (the server gates the signal), because it names a secret only they can
          replace, and left to the status line it would fade as if it were nothing. A note
          filed on a misconfigured instance still fills everything else and reads normally
          for everyone else — this is the one person who can fix it, told plainly.
      */}
      {titleModelFault && (
        <div className="operator-notice" role="status">
          <span>
            Auto-fill couldn’t reach the title model — it rejected the API key. Check{' '}
            <code>ANTHROPIC_API_KEY</code> on this instance. Filing still works; titles fall
            back to a line from the note.
          </span>
          <Button
            variant="quiet"
            size="small"
            aria-label="Dismiss"
            onClick={() => setTitleModelFault(false)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/*
          Auto-fill's offer to replace what is already set — the warning the issue asked
          for, as an inline confirm above the list it would change, so the values it
          would replace are on screen while deciding. Applied as one: the fields that
          come with a move mean nothing without it. `Confirm` is for what cannot be
          undone, and overwriting a title someone typed is exactly that.
      */}
      {autofillReplace && (
        <Confirm
          label="Confirm replacing the note's filing"
          question={<>Also replace {describeChanges(autofillReplace)}?</>}
          detail={[
            ...(autofillReplace.title !== undefined ? [`Title: ${autofillReplace.title}`] : []),
            ...(autofillReplace.notebook !== undefined ? [`Notebook: ${autofillReplace.notebook}`] : []),
            ...autofillReplace.fields.map(
              ({ def, value }) => `${def.name}: ${formatFieldValue(def.type, value, def.scale, def.currency)}`,
            ),
          ].join(' · ')}
          actions={[
            {
              label: 'Replace',
              tone: 'primary',
              onConfirm: () => {
                const changes = autofillReplace;
                const before = draftRef.current;
                setDraft((d) => applyAutofill(d, changes));
                setAutofillReplace(null);
                showFillResult(`Replaced ${describeChanges(changes)}`, {
                  label: 'Undo',
                  onClick: () => setDraft(before),
                });
              },
            },
          ]}
          onCancel={() => setAutofillReplace(null)}
        />
      )}

      {/* Auto-fill's result: fixed to the bottom of the screen, not the header. */}
      {snackbar && (
        <Snackbar
          message={snackbar.message}
          tone={snackbar.tone}
          action={snackbar.action}
          duration={snackbar.duration}
          onDismiss={() => setSnackbar(null)}
        />
      )}

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
          readOnly={frozen}
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
        readOnly={readOnly || frozen}
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
            readOnly={readOnly || frozen}
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
            onCopyAttachments={
              readOnly
                ? undefined
                : async (from, filenames, move) => {
                    const { files } = await api.copyAttachments(note.id, { from, filenames, move });
                    void queryClient.invalidateQueries({ queryKey: keys.attachments(note.id) });
                    // A move changed the source note's list too.
                    if (move) void queryClient.invalidateQueries({ queryKey: keys.attachments(from) });
                    return new Map(files.map((f) => [f.from, f.filename]));
                  }
            }
            onUploadsPending={setUploadsPending}
            onSaveRemoteImage={readOnly ? undefined : saveRemoteImage}
            onDeleteAttachment={
              readOnly
                ? undefined
                : async (filename) => {
                    await api.deleteAttachment(note.id, filename);
                    void queryClient.invalidateQueries({ queryKey: keys.attachments(note.id) });
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
