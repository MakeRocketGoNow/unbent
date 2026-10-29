import { useSyncExternalStore } from 'react';
import { formatAttachmentMarkdown } from '@unbent/shared';
import type { QueryClient } from '@tanstack/react-query';
import * as actions from './store/actions.js';
import { offlineNow } from './connectivity.js';
import { indexUploadedFile } from './index-files.js';
import { invalidateNoteMembership } from './queries.js';

/**
 * Files that each become a note: one note per file, named after it, with the file
 * attached and linked from the body the way the editor links a dropped file.
 *
 * Three ways in, one routine. Files let go on the note list (`list-drop-zone.ts`), filed
 * where the list is scoped; files picked on the Import page, filed in the notebook named
 * there; and files the operating system launched the installed app with
 * (`launch-files.ts`). The drop target is what decides what a file becomes (a file let
 * go on the open note attaches there, one let go on the list is a note of its own), so
 * there is deliberately no "combine into one note" choice anywhere: the one-note case is
 * "open a note and drop there".
 *
 * Every write goes through `store/actions.ts`, never the API: each note lands in the
 * local copy at once, and with no connection its upload queues behind its own create,
 * so a batch that loses its connection halfway finishes from the outbox rather than
 * leaving notes whose files never came. With one, the upload is sent directly (see
 * `noteFromFile` for the wait that makes it so). One file at a time, in the order given,
 * because the uploads are the cost and twelve PDFs in flight at once is twelve times the
 * memory on a phone for no shorter wait.
 *
 * The batch's state is the module's, not a component's, for the reason the import run's
 * is (`import-run.ts`): the snackbar that reports it is drawn by the root layout, and the
 * person may well have left the list, or the Import page, before the last upload
 * lands. Batches run one after another: a second drop, a pick on the Import page or a
 * launch that arrives while one runs waits its turn rather than being refused. Refusing
 * was tried first, and the launch had no way to say so: a scanner's second job went to
 * the console and nowhere else. The report shows the batch now running.
 */

/** Where the notes go: the list's notebook and tags, by name, as `useCreateNote` takes them. */
export interface Filing {
  notebook: string | null;
  tags: string[];
}

export type FileNotesStatus = 'idle' | 'running' | 'done' | 'error';

/** Where a batch was started: the report is drawn differently for each. */
export type FileNotesSource = 'list' | 'import' | 'launch';

export interface FileNotesState {
  status: FileNotesStatus;
  /** Where the batch was started; `null` while nothing has been. */
  source: FileNotesSource | null;
  /** Where the notes were filed, for the way to them; the sentence is `place`. */
  filing: Filing;
  /** How many files the batch was given, and how many have become notes so far. */
  total: number;
  done: number;
  /** The notes made, in order; what Undo trashes and what the list selects. */
  ids: string[];
  /** Where they were filed, in a word, for the report: "Receipts", or null for nowhere. */
  place: string | null;
  /** What went wrong, as the sentence the report shows: the batch cut short, or an Undo refused. */
  error: string | null;
  /** Counts batches, so a snackbar dismissed for one does not hide the next. */
  run: number;
}

const initial: FileNotesState = { status: 'idle', source: null, filing: { notebook: null, tags: [] }, total: 0, done: 0, ids: [], place: null, error: null, run: 0 };

let state: FileNotesState = initial;
const listeners = new Set<() => void>();
/** Whose batch this is; see `claimFileNotesFor`. */
let owner: string | null = null;
/** Who adopted the batches begun before anyone was claimed; see `claimFileNotesFor`. */
let firstOwner: string | null = null;
/**
 * Occupancy of this tab: counts up each time the account goes to nobody. A batch begun
 * before anyone was claimed is adopted by the first person (`firstOwner`), and a
 * sign-out must stop that batch, but it must not also poison the *next* unowned
 * launch. The installed app is `focus-existing`, so a scanner sending files to a
 * window sitting on `/login` after a sign-out or an expired session does not reload;
 * those files reach `notesFromFiles` with `owner === null`, the shape of a cold launch.
 * Before this, they were compared against the previous `firstOwner` and dropped with no
 * report, which is how a scan sent at the login screen vanished. Each batch takes the
 * era it was enqueued in (`born` in `runBatch`), so one that waited its turn across a
 * sign-out is still not the next person's.
 */
let era = 0;
/**
 * Resolved by each claim that adopts the unowned batches; `runBatch` waits on it while
 * nobody is signed in. Starting at once was tried and does not land the files: on
 * `/login` the library is closed and the session is gone, so every create goes out as a
 * request with no cookie and fails, and the next person signs in to the report of a
 * batch that failed before they arrived. A cold launch only got away with it because its
 * cookie already existed. Replaced after each resolve, so the batches of the next
 * occupancy wait on a promise of their own.
 *
 * The files of a waiting batch live in this page's memory and nowhere else, so the wait
 * counts as busy (`fileNotesWaiting`, read by `pageBusy`) and the update notice's Reload
 * does not land on them. A sign-in that leaves the page (Google's redirect) still
 * loses them; only a sign-in that stays on the page, by code or passkey, reaches the
 * claim. Keeping them on the device's `pending` shelf across the redirect would be the
 * fix for that, and is not attempted here.
 */
let claimed = resolver();
/** Batches begun with nobody signed in, waiting on `claimed`; see `fileNotesWaiting`. */
let waiting = 0;

function resolver(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function set(patch: Partial<FileNotesState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function getFileNotes(): FileNotesState {
  return state;
}

/**
 * Whether files handed over with nobody signed in are waiting for a sign-in. They are
 * held here and nowhere else, so a reload under them loses them; `pageBusy` reads this
 * beside the running status, which a waiting batch has not reached.
 */
export function fileNotesWaiting(): boolean {
  return waiting > 0;
}

export function useFileNotes(): FileNotesState {
  return useSyncExternalStore(subscribe, getFileNotes, getFileNotes);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * Ties the batch to whoever is signed in, and drops it if that changes or if nobody is:
 * `ImportRun.claim`'s rule, for the same reason. A batch keeps calling the actions after
 * a sign-out, and once the library has closed each is a plain request with whatever
 * cookie the page holds: a long batch would finish as the next person to sign in here.
 * The report is theirs too ("12 notes added to Receipts", with an Undo over ids that
 * are not theirs), so it goes with the owner. Called from `useSignOut`, from the shell
 * when the session goes under it, and from the route guard's hand-over.
 */
export function claimFileNotesFor(userId: string | undefined): void {
  const next = userId ?? null;
  if (next === owner) return;
  /*
   * The first person claimed adopts whatever began before anyone was: the launch queue's
   * consumer is set before the first render, so a cold launch from the Dock or a scanner
   * reaches `notesFromFiles` ahead of the guard, and a scan sent to the login screen
   * reaches it with nobody signed in. Those batches wait for this claim (`claimed`), so
   * a sign-in made on this page adds the files it was made for. Adopted, the batch is
   * theirs from here on, and a later sign-out stops it as it stops any other.
   */
  if (owner === null && next !== null && firstOwner === null) {
    firstOwner = next;
    owner = next;
    claimed.resolve();
    claimed = resolver();
    return;
  }
  // Whatever report there is goes with the change of hands: one written while nobody
  // was signed in included, since it is about the files of whoever was before.
  if (state.status !== 'idle') set({ ...initial, run: state.run });
  owner = next;
  // Nobody is signed in: this occupancy is over, and the next claim adopts whatever
  // arrives meanwhile. See `era`.
  if (next === null) {
    firstOwner = null;
    era += 1;
  }
}

/** Forgets a finished batch; the Import page's "Add more files". Ignored while one runs. */
export function resetFileNotes(): void {
  if (state.status === 'running') return;
  set({ ...initial, run: state.run });
}

/**
 * What becomes a note: the kinds the manifest's `file_handlers` name. The Import page's
 * picker offers only these, and the list's drop refuses a batch holding anything else
 * (`refusals`): someone who drags an .enex onto the list wants it imported, not attached,
 * and a dragged folder arrives as a file with no type that fails when read.
 */
export function isNoteFile(file: File): boolean {
  if (file.type === 'application/pdf' || file.type.startsWith('image/')) return true;
  // A file arriving with no type (a drag from some file managers, a picker on an older
  // phone) is judged by its name, so a scan is not refused for how it was handed over.
  return /\.(pdf|png|jpe?g|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i.test(file.name);
}

/** `2026-09-18 Water bill.pdf` becomes `2026-09-18 Water bill`. */
export function titleFor(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim();
}

/**
 * Makes one note from one file: created where it is filed, with its body already linking
 * the file, and the file then uploaded to it.
 *
 * The link is written before the upload rather than after it, on purpose. The upload
 * moves the note's date on the server, so a body written afterwards against the copy the
 * create answered was refused as a conflict on every note and went again: one wasted
 * round trip per file, and a queue entry that lands as a conflict offline. A fresh note
 * has no file for the name to collide with, so the path the upload will answer is known
 * before it is made: `files/<name>`, on the server (`availableFilename`) and in the
 * outbox alike. What the upload would refuse is refused before the batch starts
 * (`refusals`); a note whose upload fails all the same goes to the trash, so the batch
 * leaves no note linking to nothing.
 */
export async function noteFromFile(file: File, filing: Filing): Promise<string> {
  const body = formatAttachmentMarkdown(file.name, `files/${file.name}`, { image: file.type.startsWith('image/') }) + '\n';
  const created = await actions.createNote({ title: titleFor(file.name), body, tags: filing.tags, notebook: filing.notebook });
  /*
   * The create is queued, and `uploadFile` queues an upload behind any write of its
   * note still waiting: without this wait every file of an online batch went to the
   * device's pending shelf: two hundred megabytes of scans written to the file system
   * before the first byte was sent, a phone short of room refusing a drop it could have
   * uploaded, and "12 notes added" meaning queued rather than landed. So, with a
   * connection, the upload waits for the create to reach the server first, bounded: a
   * server that takes longer than this leaves the upload to the queue, which is what
   * the queue is for.
   */
  if (!offlineNow()) await actions.synced(created.id, CREATE_LANDED_MS);
  let uploaded;
  try {
    uploaded = await actions.uploadFile(created.id, file);
  } catch (err) {
    await actions.trashNote(created.id).catch(() => undefined);
    throw err;
  }
  // The upload's text goes into the search index from here when the server is not doing
  // it; a queued upload says `server` and is indexed when it goes through (`onUploaded`).
  indexUploadedFile(created.id, uploaded, file);
  return created.id;
}

/** How long an online upload waits for its note's create to land before queueing instead. */
const CREATE_LANDED_MS = 10_000;

/** The batches in order; each starts once the one before it has ended, however it ended. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Makes a note per file and reports as it goes, after any batch already running.
 * Resolves with the ids made: all of them, or the ones made before a file failed, which
 * the state then says.
 */
export function notesFromFiles(files: File[], filing: Filing, place: string | null, source: FileNotesSource, queryClient?: QueryClient): Promise<string[]> {
  if (files.length === 0) return Promise.resolve([]);
  // Whose files these are, taken now: a batch waiting its turn across a sign-out must
  // not run as the next person. `era` is taken now for the same reason (see its comment).
  const by = owner;
  const born = era;
  const run = () => runBatch(files, filing, place, source, by, born, queryClient);
  const next = chain.then(run, run);
  chain = next;
  return next;
}

/**
 * What keeps a batch from starting, as a sentence naming the files, or null. Judged over
 * every file before the first note is made, so a batch of twelve with one bad file makes
 * no notes and says which file, rather than making two, stopping at the third and
 * saying the other nine failed. Both checks need no I/O.
 */
export function refusals(files: File[]): string | null {
  const bad = files.flatMap((file) => {
    const why = isNoteFile(file) ? actions.uploadRefusal(file) : 'not a PDF or an image';
    return why ? [`${file.name} (${why})`] : [];
  });
  if (bad.length === 0) return null;
  return `Nothing was added. ${bad.length === 1 ? 'One file' : `${bad.length} files`} cannot become a note: ${bad.join(', ')}.`;
}

async function runBatch(
  files: File[],
  filing: Filing,
  place: string | null,
  source: FileNotesSource,
  by: string | null,
  born: number,
  queryClient?: QueryClient,
): Promise<string[]> {
  // Still theirs: not once the account changed hands, or nobody is signed in now. A
  // batch begun before anyone was claimed belongs to whoever is claimed first in the
  // occupancy it was begun in; see `era`.
  const theirs = () => born === era && (by ?? firstOwner) === owner;
  if (!theirs()) return [];
  // Begun while nobody is signed in: wait to be adopted before writing anything, since
  // there is no session to write with (`claimed`). `theirs` held, so `by` is null here
  // and the claim that resolves this is the one that adopts the batch. Checked again
  // after, for a sign-out that lands between the adopting claim and this continuation.
  if (owner === null) {
    waiting += 1;
    try {
      await claimed.promise;
    } finally {
      waiting -= 1;
    }
  }
  if (!theirs()) return [];
  const refused = refusals(files);
  if (refused) {
    set({ status: 'error', source, filing, total: files.length, done: 0, ids: [], place, error: refused, run: state.run + 1 });
    return [];
  }
  set({ status: 'running', source, filing, total: files.length, done: 0, ids: [], place, error: null, run: state.run + 1 });
  const ids: string[] = [];
  try {
    for (const file of files) {
      ids.push(await noteFromFile(file, filing));
      // Cut short by a hand-over: the ids are the earlier account's, and a caller that
      // opened or selected them would be showing the next person notes not theirs.
      if (!theirs()) return [];
      set({ done: ids.length, ids: [...ids] });
    }
    set({ status: 'done' });
  } catch (err) {
    if (!theirs()) return [];
    const made = ids.length === 0 ? 'No notes added' : `${ids.length} of ${files.length} added`;
    set({ status: 'error', error: `${made}; the rest failed: ${(err as Error).message}` });
  } finally {
    // A device with no local copy reads the lists from the server, so they are asked
    // again; with one, the collections already re-ran them.
    if (queryClient) {
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      invalidateNoteMembership(queryClient);
    }
  }
  return ids;
}

/**
 * Takes the batch back: every note it made goes to the trash, where it can be restored,
 * and the report is over. A trash the server refused (a device with no local copy, a
 * 4xx) is said in the report's place rather than lost, since the card that offered Undo
 * has already gone with the press and the notes are still there. Resolves whether the
 * notes went to the trash, which the report cannot say once another batch has begun.
 */
export async function undoFileNotes(queryClient?: QueryClient): Promise<boolean> {
  const { ids, run } = state;
  if (ids.length === 0) return false;
  // Only the report of the batch Undo was pressed for is written, and only for the person
  // who pressed it: a drop made while the trash was on its way has a batch of its own
  // running by now, and a sign-out meanwhile has wiped the report for whoever is next.
  const who = owner;
  const current = () => state.run === run && owner === who;
  try {
    await actions.trashNotes(ids);
  } catch (err) {
    if (current()) set({ status: 'error', error: `Could not undo: ${(err as Error).message}`, run: state.run + 1 });
    return false;
  }
  if (current()) set({ ...initial, run: state.run });
  if (queryClient) {
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
    invalidateNoteMembership(queryClient);
  }
  return true;
}

/** For tests: back to nothing, whatever was running; a batch still waiting is not. */
export function resetFileNotesForTests(): void {
  state = initial;
  owner = null;
  firstOwner = null;
  era = 0;
  claimed = resolver();
  waiting = 0;
  chain = Promise.resolve();
  for (const fn of listeners) fn();
}
