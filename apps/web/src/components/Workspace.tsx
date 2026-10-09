import { useEffect, useMemo, useRef, useState } from 'react';
import { noteOpened } from '../store/library.js';
import { openSitePath, sitePathOpener } from '../useHostApp.js';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import type { FieldDef, FieldType, FieldValue, Note, NoteRevisionSummary } from '@unbent/shared';
import { localizeImageLinks, remoteImageUrls, unreadFiles } from '@unbent/shared';
import * as api from '../notes-api.js';
import { isOfflineError, isStatus } from '../notes-api.js';
import * as actions from '../store/actions.js';
import { useOutbox, useSyncStatus } from '../store/use-outbox.js';
import { useFeedState } from '../store/use-feed-state.js';
import { isWhole } from '../store/feed.js';
import { NotSyncedMark } from './NotSyncedMark.js';
import { useOffline } from '../connectivity.js';
import {
  buildNotePatch,
  holdsTheirChanges,
  rememberFieldDefs,
  seedFrom,
  unstoreableFieldIds,
  type NoteDraft,
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
import { HistorySheet, skippedPhrase } from './HistorySheet.js';
import type { HistoryCurrent } from './HistoryChanges.js';
import type { PropValue } from '../note-diff.js';
import { formatRevisionWhen } from './format-when.js';
import { Button } from './Button';
import { BackArrow } from './BackArrow.js';
import { FilingRows } from './FilingRows.js';
import { NoteFields } from './NoteFields.js';
import { Confirm } from './Confirm.js';
import { Snackbar } from './Snackbar.js';
import { AutofillIcon } from './icons.js';
import { formatFieldValue } from './format-field.js';
import { applySaveToLists } from '../list-cache.js';
import { onBackArrowClick } from '../note-nav.js';
import { FILLED_MS, FILLED_STAGGER_MS, filledMarks, filledStyle } from './filled.js';
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

/** What the History sheet is handed before it has ever been opened. */
const CLOSED_HISTORY: HistoryCurrent = { title: '', body: '', notebook: null, tags: [], fields: [] };

export function Workspace({ noteId, readOnly: inTrashView = false, backTo = '/notes' }: WorkspaceProps) {
  const navigate = useNavigate();
  const router = useRouter();
  /** A link in the note written from the root of the site, followed in place; see `sitePathOpener`. */
  const openPath = (path: string) => openSitePath(router, path);
  const pathOpener = (path: string) => sitePathOpener(router, path);
  const queryClient = useQueryClient();
  const { data: note, error, refetch } = useQuery(noteQuery(noteId));
  /*
     A trashed note is read-only wherever it is opened, not only from the trash. The
     server serves one by id so the trash can show it, which means a link saved before the
     note was deleted, or a note trashed on another device while it is open here, now
     loads instead of failing — and would load editable, with every save refused, if this
     followed the route alone.
  */
  const readOnly = inTrashView || note?.deletedAt !== undefined;
  /*
     Opening a note is how its files become searchable offline without keeping its whole
     notebook: the device holds the text of the files of the last few hundred notes opened
     on it (`noteOpened`). Not a trashed note's — it is on its way out.
  */
  const openedId = note && !readOnly ? note.id : undefined;
  useEffect(() => {
    if (openedId) noteOpened(openedId);
  }, [openedId]);
  /*
     Offline, the note is as editable as ever: it is read from the local copy of the
     library and a save goes to the outbox, which replays when the connection returns.
     What offline does stop is what needs the server now — Auto-fill, the ⋯ menu's
     actions, a file upload — and those fade in place rather than the whole note locking.

     Except in a tab that does not hold the outbox: only one tab of an account queues
     writes, and in any other a save is a request made now, which offline fails and rolls
     back. Typing there would be lost on the next keystroke's save, so that tab locks the
     note while offline and the banner says which tab to use (`stranded`, below).
  */
  const offline = useOffline();
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
   * Editor is uncontrolled: the open note's saved body is its seed, and a remount (the
   * revision) is how it is given another text. The override is that other text when it
   * is not the saved body — a draft put back on screen after a refused save (see
   * `showDraft`) — and it names its note, since the editor mounts for a new note in the
   * render before the effects that seed the draft run: an override left over from the
   * previous note would otherwise seed this one. Showing a conflict's draft once cleared
   * the override instead, so the editor showed the server's body under a draft that held
   * the typing, and the next keystroke would have saved the body without it (found on
   * the preview, 2026-10-02).
   */
  const [editorRevision, setEditorRevision] = useState(0);
  const [editorOverride, setEditorOverride] = useState<{ noteId: string; body: string } | null>(null);

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
   * The notes whose base may be newer than the truth. The feed engine empties and
   * refills the collections on a `reset` — an operator's wind-back or load, which make
   * every row older, not newer — and the rule below that takes only a newer copy would
   * leave the open note showing what the wind-back removed: the list dropped the edit
   * and the note did not (MAK-196, found in the restore rehearsal). After a reset every
   * base is suspect until the next copy of its note has been taken, whatever its date.
   */
  const staleBases = useRef(new Set<string>());
  /** A base taken from a copy the server gave is current, whatever a reset said of the one before it. */
  const setBase = (id: string, copy: Note) => {
    bases.current.set(id, copy);
    staleBases.current.delete(id);
  };
  const feedState = useFeedState();
  const resets = feedState?.resets ?? null;
  const whole = feedState !== null && isWhole(feedState);
  const seenResets = useRef(resets);
  useEffect(() => {
    // No library — closed by a refused session, or changing hands — is not a reset of one;
    // the count the reopened library then reports is a first state, heard as below.
    if (resets === null) {
      seenResets.current = null;
      return;
    }
    if (resets === seenResets.current) return;
    const first = seenResets.current === null;
    seenResets.current = resets;
    // The first state a mounted workspace hears, or the first from a library opened again,
    // is a count, not a reset it lived through.
    if (first) return;
    for (const id of bases.current.keys()) staleBases.current.add(id);
  }, [resets]);

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
   * Whether the note's inputs take edits: not while a conflict waits on a choice. Typing
   * on during one would only be refused again, and the choice is between two versions
   * the person can see — a third, still moving, would make it a guess.
   */
  const outbox = useOutbox();
  const sync = useSyncStatus();
  /** Offline in a tab whose writes would be requests: nothing typed here could be saved. */
  const stranded = offline && outbox !== null && !sync.durable;
  const frozen = conflicted || stranded;

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
    outbox?.resolveConflict(conflict.id);
    setConflict(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  /*
     A conflict can arrive long after the save that caused it: the save was taken by the
     local copy at once and went to the server later, from the outbox, and the refusal
     comes back from there. By id, so one for another note waits for that note.

     The refusal brings the draft the save carried and the copy it was made from. When
     the note is open and that draft is what is on screen, nothing moves. When it is not
     — the note was closed when the refusal came, and reopened from the row, which the
     ended entry had rolled back to the server's copy — the draft is put back on screen
     and its base taken, so the choice is between the two versions that exist and "Keep
     mine" has something to keep. Typing since the refused save is left alone: the draft
     on screen already holds everything the refused one did.
  */
  useEffect(() => {
    if (!outbox) return;
    return outbox.subscribe((status) => {
      const c = status.conflicts.get(noteId);
      if (!c) return;
      const clean = isClean();
      if (clean && JSON.stringify(c.draft) !== JSON.stringify(draftRef.current)) showDraft(c.draft);
      setBase(noteId, c.base);
      setConflict((prev) => (prev?.id === noteId && prev.current === c.current ? prev : { id: noteId, current: c.current }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbox, noteId]);

  /*
     The server's copy after a save of this note went through: the base the next save is
     made against. Reseeded only when nothing has been typed since and the copy differs
     from the draft — the server normalised something — so typing is never disturbed.
  */
  useEffect(() => {
    if (!outbox) return;
    return outbox.onAcknowledged((id, updated) => {
      setBase(id, updated);
      if (id !== noteId) return;
      const clean = isClean();
      if (clean && JSON.stringify(seedFrom(updated)) !== JSON.stringify(draftRef.current)) reseed(updated);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbox, noteId]);

  /**
   * Re-seeds the open note from a copy of it the server just gave, rebuilding the editor
   * only when the body is what changed — a title or a tag from elsewhere has no reason to
   * throw away the caret and the undo history. The bump to `seedGeneration` makes the
   * autosave take the new copy as its baseline rather than as an edit to save.
   */
  function reseed(from: Note) {
    setBase(from.id, from);
    queryClient.setQueryData(keys.note(from.id), from);
    showDraft(seedFrom(from));
  }

  /**
   * Puts a draft on screen as the autosave's baseline, rebuilding the editor only if
   * the body differs from what it shows — with that body as the seed, since the saved
   * body in the row is not it.
   */
  function showDraft(next: NoteDraft) {
    const showing = draftRef.current.body;
    setDraft(next);
    if (next.body !== showing) {
      setEditorOverride({ noteId, body: next.body });
      setEditorRevision((n) => n + 1);
    }
    setSeedGeneration((n) => n + 1);
  }

  // Seed the draft when a different note loads. Keyed on id, not on the note object,
  // so a background refetch never discards what is being typed. A note with a conflict
  // waiting on it is seeded from the refused draft and its base, not from the row, which
  // is the server's copy (see the conflict subscription above); the outbox may also
  // arrive after the note, and then that subscription does the same.
  useEffect(() => {
    if (!note) return;
    const waiting = outbox?.status().conflicts.get(note.id);
    setBase(note.id, waiting?.base ?? note);
    setDraft(waiting?.draft ?? seedFrom(note));
    setDraftFor(note.id);
    // The editor mounted with the saved body in the render before this; a waiting
    // draft's body is seeded by a remount with it.
    if (waiting && waiting.draft.body !== note.body) {
      setEditorOverride({ noteId: note.id, body: waiting.draft.body });
      setEditorRevision((n) => n + 1);
    } else {
      setEditorOverride(null);
    }
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
    const base = bases.current.get(noteId);
    if (!note || !base) return 'unchanged';
    /*
       The draft against the copy it came from: the save lands on the local copy at once
       and goes to the server from the outbox, with the base's date as its precondition,
       so a save made after another device saved this note is refused rather than
       written over it (MAK-113). The refusal, when there is one, comes back through the
       outbox's conflicts and the effect above; "Keep mine" sends the draft again against
       the copy the refusal brought. 'unchanged' when nothing the server can hold differs
       from the base — a space typed and deleted — so the head does not flash "Saved".
    */
    let outcome: Awaited<ReturnType<typeof actions.saveNote>>;
    try {
      outcome = await actions.saveNote({ noteId, value, base });
    } catch (err) {
      // No local copy on this device, so the server answered the save itself, and refused
      // it: the same choice, put the same way, now.
      if (!api.isNoteChanged(err)) throw err;
      if (noteIdRef.current !== noteId) {
        queryClient.setQueryData(keys.note(noteId), err.current);
        return 'unchanged';
      }
      setConflict({ id: noteId, current: err.current });
      throw err;
    }
    if (outcome === 'unchanged') return 'unchanged';
    if (typeof outcome === 'object') {
      setBase(noteId, outcome);
      queryClient.setQueryData(keys.note(noteId), outcome);
    }
    return undefined;
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
    outbox?.resolveConflict(conflict.id);
    setBase(conflict.id, conflict.current);
    setConflict(null);
    reseed(conflict.current);
  }

  /**
   * Keep mine: this draft saved over the version the refusal brought back — against that
   * version, which is still a precondition: a third save landing meanwhile is refused in
   * turn, and the notice comes back. The draft keeps whatever of theirs it never touched.
   */
  function keepOurs() {
    if (!conflict) return;
    const theirs = conflict.current;
    const id = conflict.id;
    const base = bases.current.get(id);
    if (!base) return;
    outbox?.resolveConflict(id);
    setConflict(null);
    // Diffed against the copy the draft came from — only what was typed here — and
    // preconditioned on theirs, so it lands on top of their version rather than over it.
    void actions.saveNote({ noteId: id, value: draftRef.current, base, against: theirs.updatedAt }).then(
      (outcome) => {
        if (typeof outcome !== 'object') return;
        setBase(id, outcome);
        queryClient.setQueryData(keys.note(id), outcome);
        if (noteIdRef.current === id) reseed(outcome);
      },
      (err: unknown) => {
        if (api.isNoteChanged(err) && noteIdRef.current === id) setConflict({ id, current: err.current });
      },
    );
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
  /** Nothing typed is waiting or failed: what every "is it safe to replace the draft" asks. */
  const isClean = () => saveStateRef.current === 'idle' || saveStateRef.current === 'saved';
  /*
     Coming back to the tab is the usual moment another device has saved this note: the
     phone was in use while the tab sat in the background. The library pulls the feed on
     the same event, and the queries follow the library, but a read of the copy is cheap
     and this is the one moment it should not wait for anything.
  */
  useEffect(() => {
    if (!editing) return;
    const onShow = () => {
      const clean = isClean();
      if (document.visibilityState === 'visible' && clean) void refetch();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, noteId]);
  useEffect(() => {
    if (!editing || !note || conflicted) return;
    const clean = isClean();
    const base = bases.current.get(noteId);
    /*
       Only ever forward, unless the library has started over since the base was taken. A
       copy older than the base is otherwise not another device's save: it is the row
       between a replayed write of our own ending and the feed delivering the server's
       copy, and taking it would reseed the editor with text already replaced. After a
       reset the older copy is the truth — the store was wound back — and the base is what
       is stale (`staleBases`). The reset is heard before the walk delivers that row,
       while the query still holds the copy the base was taken from, so a copy with the
       base's own date says nothing and leaves the flag standing; a different copy clears
       it when taken, and a library whole again clears it for a note the wind-back did not
       touch, which would otherwise stay suspect for good.
    */
    if (!base) return;
    const stale = staleBases.current.has(noteId);
    if (stale && note.updatedAt === base.updatedAt) {
      if (whole) staleBases.current.delete(noteId);
      return;
    }
    if (!stale && note.updatedAt <= base.updatedAt) return;
    /*
       Another device saved this note and the feed has brought its copy. With nothing
       typed here since the last save the copy simply replaces the draft, and the first
       keystroke is made on top of it rather than refused for having been made against
       the old one. Typing in progress is left alone: the precondition settles it at its
       save, and the notice if need be.
    */
    if (!clean) return;
    setBase(noteId, note);
    if (JSON.stringify(seedFrom(note)) !== JSON.stringify(draftRef.current)) reseed(note);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, noteId, note?.updatedAt, conflicted, whole]);

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
  /*
     "Saved" is the local copy's word now, and it stays one word: the head has room for
     about that beside a title on a phone, and a sentence here shrank the title (a lesson
     learned twice). What the server has not heard of yet is said by a glyph beside the
     word while this note has an entry waiting in the outbox — the blink of a replay
     online, the whole stretch offline — with "Not synced yet" on hover or tap. The
     device's state is the banner's to say, and a sync that is stuck is the strip's
     (`SyncingLine`).
  */
  const saveLabel = unsavedOffline
    ? 'Not saved — offline'
    : holdingField && saveState === 'saved'
      ? SAVE_LABEL.dirty
      : SAVE_LABEL[saveState];
  const notSynced = !readOnly && sync.waiting.has(noteId);

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
   * What the last Auto-fill press wrote, marked where it landed for a moment: the title,
   * the notebook, the tags it added and each field, lit in turn down the record and faded
   * back (`.filled` in the stylesheet). The snackbar names the changes in a sentence; this
   * shows where they are, so the eye goes to them and Undo has something visible to undo.
   * Cleared once the last mark has faded, so a later press starts its own.
   */
  const [filled, setFilled] = useState<AutofillChanges | null>(null);
  const marks = useMemo(() => filled && filledMarks(filled), [filled]);
  useEffect(() => {
    if (!marks) return;
    const timer = window.setTimeout(() => setFilled(null), FILLED_MS + marks.count * FILLED_STAGGER_MS);
    return () => window.clearTimeout(timer);
  }, [marks]);

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
      filled={marks ? { notebook: marks.notebook, tags: marks.tags } : undefined}
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
        filled={marks ? { ids: marks.fields, start: marks.fieldsAt } : undefined}
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
    await actions.trashNote(noteId);
    // The lists and counts follow the local copy; a search is the server's, so it is
    // asked again for a note that is no longer in it.
    void queryClient.invalidateQueries({ queryKey: ['search'] });
    void navigate({ to: '/notes', search: (p) => p });
  }

  /**
   * Saves what is on screen first: the copy is made from the stored note, and the last
   * edit may still be inside the autosave's delay.
   */
  async function duplicateNote() {
    await flush();
    const copy = await actions.duplicateNote(noteId);
    void queryClient.invalidateQueries({ queryKey: ['search'] });
    void navigate({ to: '/notes/$noteId', params: { noteId: copy.id }, search: (p) => p });
  }

  /** The History sheet, and the ⋯ menu it opens from, which its desktop panel sits under. */
  /*
     Open for a note, not open: Workspace is reused across notes, and an effect that closed
     the sheet when the note changed ran after the sheet's own, so for one commit the sheet
     was open on the new note and asked the server for its history, and for the old note's
     version by id. Compared here, it is shut in the very render the note changes.
  */
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const historyOpen = historyFor === noteId;
  /*
     The sheet is not in the page until History has been chosen once. It is opened on few
     notes and its dialog would otherwise sit, closed, in every one; kept mounted after
     that, so closing it is the sheet's own exit and not an unmount.
  */
  const [historyMounted, setHistoryMounted] = useState(false);
  /** The flush begun as the sheet opened, which its list waits on; see `HistorySheet`. */
  const historyFlush = useRef<Promise<unknown>>(Promise.resolve());
  const overflowSlot = useRef<HTMLSpanElement>(null);
  // And forgotten, so coming back to that note does not open it again.
  useEffect(() => setHistoryFor(null), [noteId]);

  /**
   * The note on screen as the History sheet compares a version against it: the draft,
   * with each field value given the name and type that draw it. A definition this
   * session has loaded says those; a value carried from a notebook the note has left
   * says its own, as the property list draws it. An emptied value is no value, which is
   * how the save reads it. Called only while the sheet is open, since the sheet stays
   * mounted after its first opening and this would otherwise run on every keystroke;
   * the comparison it feeds is memoised by value, so a new object each render is fine.
   */
  function historyCurrent(): HistoryCurrent {
    const defs = new Map(knownFieldDefs.map((def) => [def.id, def]));
    const carried = new Map((note?.fields ?? []).map((v) => [v.fieldId, v]));
    return {
      title: draft.title,
      body: draft.body,
      notebook: draft.notebook === null ? null : { id: currentNotebook?.id, name: currentNotebook?.name ?? draft.notebook },
      tags: draft.tags,
      fields: Object.entries(draft.fields).flatMap(([fieldId, value]): PropValue[] => {
        if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return [];
        const def = defs.get(fieldId);
        if (def) {
          return [{ fieldId, name: def.name, type: def.type, value, scale: def.scale, currency: def.currency, notebookId: def.notebookId }];
        }
        const was = carried.get(fieldId);
        return was ? [{ ...was, value }] : [];
      }),
    };
  }

  /*
     What the sheet is handed: the note while it is open, and afterwards the last note it
     was open on, not an empty one. The dialog fades out over a fifth of a second with
     the version still on its page, and compared against nothing it drew every tag as
     removed and the whole text as added for those frames.

     The ref is written during render on purpose. Moving the write into an effect would
     hand the sheet the previous render's note for one frame on every change, and the
     closing frame would be the empty one again. The write only repeats what this render
     computed, so a render React throws away leaves nothing wrong behind.
  */
  const historyLast = useRef<HistoryCurrent>(CLOSED_HISTORY);
  if (historyOpen) historyLast.current = historyCurrent();
  const historyShown = historyLast.current;

  /**
   * Saves what is on screen and says whether the server can be asked to replace it.
   *
   * The server keeps what a restore replaces, and it can only keep what it has: typing
   * that never left this tab would be replaced by the reseed that follows and exist
   * nowhere. So the draft is flushed, and the save has to have worked. `flush` reports
   * through the save state, which is a render behind it, hence the turn of the event
   * loop before it is read. A conflict waiting on a choice counts as unsaved even when
   * the state reads clean — the refusal comes from the outbox, after the save was taken
   * locally, and can arrive while the History sheet is already open.
   */
  async function savedFirst(id: string): Promise<boolean> {
    await flush();
    await new Promise((r) => setTimeout(r, 0));
    if (outbox?.status().conflicts.has(id)) return false;
    return isClean();
  }

  /**
   * Puts a copy from the note's history back (MAK-119), then says so with an Undo.
   * Thrown errors are the sheet's to show: it stays open on them, with the copy still
   * in front of the person.
   */
  async function restoreFromHistory(revision: NoteRevisionSummary) {
    const id = noteId;
    if (!(await savedFirst(id))) {
      throw new Error('This note has changes that could not be saved, so nothing was restored.');
    }
    const flushed = draftRef.current;
    const { note: restored, kept, skipped } = await actions.restoreRevision(id, revision.id);
    // What the version held that no longer fits, said with the result either way.
    const except = skippedPhrase(skipped ?? []);
    /*
       The version was already what the note says — the one just restored, picked again,
       or the "Before a restore" copy of the text now on screen. Nothing was written and
       nothing kept, so there is nothing to undo, and "Restored" with an Undo would be
       an offer to reverse something else.
    */
    if (kept === null) {
      if (noteIdRef.current !== id) return;
      setHistoryFor(null);
      setSnackbar({
        // Names, no reasons: Changes gave each reason beside the thing itself. And not
        // "could not be put back": a value under a deleted field is in this list for
        // being left on the note, and the version never had it.
        message: except
          ? `Nothing to restore: the rest already matches, and ${except} ${skipped!.length === 1 ? 'stays' : 'stay'} as the note has it.`
          : 'That version is what the note already says.',
        tone: 'info',
        duration: except ? 8000 : 5000,
      });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['search'] });
    if (noteIdRef.current !== id) return;
    /*
       Only over the draft that was saved. Nothing holds the sheet open while the request
       is out — the platform's back gesture closes the dialog without asking — so the
       person can be typing again by the time it lands, and a reseed would drop what is
       still waiting for the autosave. That typing then saves against the note the restore
       replaced, and comes back as a conflict, the way `undoRestore` leaves it.
    */
    if (JSON.stringify(draftRef.current) === JSON.stringify(flushed)) reseed(restored);
    setHistoryFor(null);
    setSnackbar({
      message: `Restored the version from ${formatRevisionWhen(revision.createdAt, Date.now(), { inSentence: true })}${
        except ? `, except ${except}` : ''
      }`,
      tone: 'info',
      // Longer when there is an exception to read as well as an Undo to reach.
      duration: except ? 10_000 : 8000,
      action: { label: 'Undo', onClick: () => void undoRestore(id, kept, restored.updatedAt) },
    });
  }

  /**
   * Undo, on the snackbar a restore leaves: the copy the restore itself kept, put back,
   * and only if the note is still exactly as the restore left it.
   *
   * `keptId` is that copy, named by the server in the restore's own answer. It was
   * found before by reading the list back and matching a date, which cost a request and
   * rested on the copy's date equalling the note's — true, but nothing here should have
   * to know it. The server is asked to put it back only over a note still carrying the
   * date the restore gave it (`ifUpdatedAt`): the editor is live while the snackbar is
   * up, typing saved since leaves no copy of its own inside the window, and an Undo that
   * replaced it would be taking away text the person had just written. Typing not yet
   * saved is flushed first, which moves the date, so it is refused the same way rather
   * than overwritten by the reseed.
   *
   * And typing that starts after the flush, while the request below is out, is left
   * on screen: the draft is noted once flushed, and the note that comes back replaces it
   * only if it is still that draft. The undo has happened on the server by then, so the
   * typing's own save is made against the copy from before it and is refused, and the
   * conflict notice puts the two versions to the person. Locking the editor for the
   * second this takes was the alternative, and a note that stops taking keys with no
   * reason on screen is what the offline work moved away from.
   */
  async function undoRestore(id: string, keptId: number, restoredAt: number) {
    const changed = 'The note has changed since; open History to choose a version.';
    try {
      if (!(await savedFirst(id))) throw new Error('This note has changes that could not be saved, so nothing was undone.');
      const flushed = draftRef.current;
      const { note: back } = await actions.restoreRevision(id, keptId, { ifUpdatedAt: restoredAt });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      // By content, as the other reseeds compare: a letter typed and taken back is not typing.
      if (noteIdRef.current === id && JSON.stringify(draftRef.current) === JSON.stringify(flushed)) reseed(back);
    } catch (err) {
      if (noteIdRef.current !== id) return;
      // A 404 is the copy itself gone: the history was cleared while the snackbar was up.
      const message = api.isNoteChanged(err)
        ? changed
        : api.isStatus(err, 404)
          ? 'That version is no longer in the note’s history.'
          : api.errorText(err);
      setSnackbar({ message, tone: 'error' });
    }
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
    setEditorOverride({ noteId, body: nextBody });
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
    setFilled(null);
  }, [noteId]);

  /**
   * A success snackbar that clears itself after a few seconds, with an optional Undo.
   *
   * Always on the timer, even when the line names a file Auto-fill couldn't read, which
   * would otherwise deserve to stay up the way the same news does as an error. The Undo is
   * why: it puts back the whole draft as it stood before the fill, so an Undo left on
   * screen would also take back everything typed since. Keeping the line and dropping the
   * Undo at the five seconds would need a second timer; not worth it for one line.
   */
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
    setFilled(null);
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
      /*
         A file this press had no text for, named so the person knows which. It said "a
         file is still being read", which promised a read in progress where there was
         none — a deployed server reads the note's files before it answers, so a file
         still pending is usually one whose read failed — and gave no file to look at.
         See `NothingToRead` for the cases where "couldn't read" means something milder.
      */
      const { pending } = suggestion.read;
      const unread = pending.length === 0 ? '' : ` — couldn't read ${unreadFiles(pending)}`;
      if (isEmptyChanges(plan.fill)) {
        showFillResult(`Nothing empty to fill in${unread}`);
      } else {
        // The draft as it stood, captured before the fill lands, so Undo is one assignment
        // back to it — `applyAutofill` returns a new object and never touches this one.
        const before = draftRef.current;
        setDraft((d) => applyAutofill(d, plan.fill));
        setFilled(plan.fill);
        showFillResult(`Filled in ${describeChanges(plan.fill)}${unread}`, {
          label: 'Undo',
          onClick: () => {
            setFilled(null);
            setDraft(before);
          },
        });
      }
      if (!isEmptyChanges(plan.replace)) setAutofillReplace(plan.replace);
    } catch (err) {
      if (noteIdRef.current !== startedFor) return;
      // The server's own sentence, without the status it arrives prefixed with: "422:
      // Nothing to read yet…" is not what a person wants to read. A failure stays until
      // dismissed rather than fading — no `duration`.
      setSnackbar({ message: api.errorText(err), tone: 'error' });
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
      <section className="workspace workspace-failed">
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
              replace
              onClick={onBackArrowClick(router, backTo)}
              className="view-back"
              aria-label="Back to notes"
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
                ? "This note isn't on this device yet. It will be once your notes have finished copying here."
                : `Couldn't load that note. ${(error as Error).message}`}
          </p>
          {unavailable ? null : missing ? (
            // Where the back arrow goes, not always the note list: a note deleted forever
            // from another tab, then picked here, should leave the trash open behind it.
            <Button
              variant="secondary"
              onClick={() => void navigate({ to: backTo, search: (p) => p })}
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

              Back through the history when the list is the page behind the note, which
              it is whenever the note was opened from it (`goBackToList`). It used to open
              the list as a new page on top, so a swipe back or Android's Back right after
              it reopened the note the arrow had just left. Where something else is behind
              — a link from another note, a notification — the link replaces the note with
              the list instead, so Back from there still never lands on the note.
          */}
          <Link
            to={backTo}
            search={(p) => p}
            replace
            onClick={onBackArrowClick(router, backTo)}
            className="view-back"
            aria-label="Back to notes"
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
            className={marks?.title === undefined ? 'title-input' : 'title-input filled-title'}
            style={filledStyle(marks?.title)}
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
            <span className="workspace-status-text">{readOnly ? 'In trash' : (webImagesStatus ?? saveLabel)}</span>
            {notSynced && <NotSyncedMark />}
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
              disabled={autofilling || frozen || offline}
              aria-label={autofilling ? 'Reading…' : 'Auto-fill'}
              title={
                offline
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
            <span className="overflow-slot" ref={overflowSlot}>
              <OverflowMenu
                label="More actions"
                // Every item here needs the server. Faded, not withdrawn, for the reason
                // Auto-fill is.
                disabled={offline}
                title={offline ? 'Not available offline' : undefined}
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
                  /*
                     Earlier versions of the note's text, and a way back to one. Beside
                     Delete on purpose: the two are how a note is lost and how it is got
                     back. Not while a conflict waits on a choice — a restore would be a
                     third version arriving in the middle of choosing between two. The
                     draft is flushed as the sheet opens, so by the time a version is
                     picked the server already has what is on screen.
                  */
                  {
                    label: 'History',
                    disabled: frozen,
                    onSelect: () => {
                      historyFlush.current = flush();
                      setHistoryMounted(true);
                      setHistoryFor(noteId);
                    },
                  },
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

      {!readOnly && historyMounted && (
        <HistorySheet
          open={historyOpen}
          onClose={() => setHistoryFor(null)}
          noteId={noteId}
          anchor={overflowSlot}
          saved={() => historyFlush.current}
          onRestore={restoreFromHistory}
          current={historyShown}
        />
      )}

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
                setFilled(changes);
                showFillResult(`Replaced ${describeChanges(changes)}`, {
                  label: 'Undo',
                  onClick: () => {
                    setFilled(null);
                    setDraft(before);
                  },
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
          /*
             The saved body until the draft is this note's. The draft is seeded in an
             effect, so the first render of a note hands down the previous note's text —
             or the empty initial draft — and every file looks unlinked for a frame. The
             panel latches open on unlinked files (`hadUnlinked`), so that one frame left
             every note with files opening expanded (MAK-149).
          */
          body={draftFor === note.id ? draft.body : note.body}
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
            initialValue={editorOverride?.noteId === note.id ? editorOverride.body : note.body}
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
                    // Through the actions: with no connection the file is kept on the
                    // device and uploaded from the outbox, and the path is good at once.
                    const uploaded = await actions.uploadFile(note.id, file, { signal });
                    void queryClient.invalidateQueries({ queryKey: keys.attachments(note.id) });
                    // Searchable now, from the bytes in hand, not on some later pass. A
                    // file that was queued says `server` and is read when it uploads.
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
                    // The same rule as the panel's Delete: a picture added offline has not
                    // reached the server, so deleting it there would fail.
                    await actions.deleteOrCancelAttachment(note.id, filename);
                    void queryClient.invalidateQueries({ queryKey: keys.attachments(note.id) });
                  }
            }
            pathOpener={pathOpener}
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
            <Preview markdown={draft.body} noteId={note.id} onOpenPath={openPath} />
          </div>
        )}
      </div>
      </div>
    </section>
  );
}
