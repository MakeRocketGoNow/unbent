import { useSyncExternalStore } from 'react';
import { filenameSchema, formatAttachmentMarkdown, MAX_ATTACHMENT_BYTES } from '@unbent/shared';
import type { QueryClient } from '@tanstack/react-query';
import * as actions from './store/actions.js';
import { indexUploadedFile } from './index-files.js';
import { invalidateNoteMembership } from './queries.js';

/**
 * Files that each become a note: one note per file, named after it, with the file
 * attached and linked from the body the way the editor links a dropped file.
 *
 * Three ways in, one routine. Files let go on the note list (`list-drop-zone.ts`), filed
 * where the list is scoped; files picked on the Import page, filed in the notebook named
 * there; and files the operating system launched the installed app with
 * (`launch-files.ts`). The drop target is what decides what a file becomes — a file let
 * go on the open note attaches there, one let go on the list is a note of its own — so
 * there is deliberately no "combine into one note" choice anywhere: the one-note case is
 * "open a note and drop there".
 *
 * Every write goes through `store/actions.ts`, never the API: each note lands in the
 * local copy at once and its upload queues behind its own create, so a batch that loses
 * its connection halfway finishes from the outbox rather than leaving notes whose files
 * never came. One file at a time, in the order given, because the uploads are the cost and
 * twelve PDFs in flight at once is twelve times the memory on a phone for no shorter
 * wait.
 *
 * The batch's state is the module's, not a component's, for the reason the import run's
 * is (`import-run.ts`): the snackbar that reports it is drawn by the root layout, and the
 * person may well have left the list — or the Import page — before the last upload
 * lands. Batches run one after another: a second drop, a pick on the Import page or a
 * launch that arrives while one runs waits its turn rather than being refused. Refusing
 * was tried first, and the launch had no way to say so — a scanner's second job went to
 * the console and nowhere else. The report shows the batch now running.
 */

/** Where the notes go: the list's notebook and tags, by name, as `useCreateNote` takes them. */
export interface Filing {
  notebook: string | null;
  tags: string[];
}

export type FileNotesStatus = 'idle' | 'running' | 'done' | 'error';

export interface FileNotesState {
  status: FileNotesStatus;
  /** How many files the batch was given, and how many have become notes so far. */
  total: number;
  done: number;
  /** The notes made, in order; what Undo trashes and what the list selects. */
  ids: string[];
  /** Where they were filed, in a word, for the report: "Receipts", or null for nowhere. */
  place: string | null;
  error: string | null;
  /** Counts batches, so a snackbar dismissed for one does not hide the next. */
  run: number;
  /** Whether Undo has taken this batch back, so the snackbar says so instead of offering it again. */
  undone: boolean;
}

const initial: FileNotesState = { status: 'idle', total: 0, done: 0, ids: [], place: null, error: null, run: 0, undone: false };

let state: FileNotesState = initial;
const listeners = new Set<() => void>();

function set(patch: Partial<FileNotesState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export function getFileNotes(): FileNotesState {
  return state;
}

export function useFileNotes(): FileNotesState {
  return useSyncExternalStore(subscribe, getFileNotes, getFileNotes);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Forgets a finished batch; the Import page's "Add more files". Ignored while one runs. */
export function resetFileNotes(): void {
  if (state.status === 'running') return;
  set({ ...initial, run: state.run });
}

/** What the picker and the drop take: the kinds the manifest's `file_handlers` name. */
export function isNoteFile(file: File): boolean {
  if (file.type === 'application/pdf' || file.type.startsWith('image/')) return true;
  // A file arriving with no type — a drag from some file managers, a picker on an older
  // phone — is judged by its name, so a scan is not refused for how it was handed over.
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
 * create answered was refused as a conflict on every note and went again — one wasted
 * round trip per file, and a queue entry that lands as a conflict offline. A fresh note
 * has no file for the name to collide with, so the path the upload will answer is known
 * before it is made: `files/<name>`, on the server (`availableFilename`) and in the
 * outbox alike. What the upload would refuse — a name the route does not take, a file
 * over the cap — is refused here first, before any note exists; a note whose upload
 * fails all the same goes to the trash, so the batch leaves no note linking to nothing.
 */
export async function noteFromFile(file: File, filing: Filing): Promise<string> {
  const named = filenameSchema.safeParse(file.name);
  if (!named.success) throw new Error(named.error.issues[0]?.message ?? 'Invalid filename');
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is over the ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit`);
  const body = formatAttachmentMarkdown(file.name, `files/${file.name}`, { image: file.type.startsWith('image/') }) + '\n';
  const created = await actions.createNote({ title: titleFor(file.name), body, tags: filing.tags, notebook: filing.notebook });
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

/** The batches in order; each starts once the one before it has ended, however it ended. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Makes a note per file and reports as it goes, after any batch already running.
 * Resolves with the ids made — all of them, or the ones made before a file failed, which
 * the state then says.
 */
export function notesFromFiles(files: File[], filing: Filing, place: string | null, queryClient?: QueryClient): Promise<string[]> {
  if (files.length === 0) return Promise.resolve([]);
  const run = () => runBatch(files, filing, place, queryClient);
  const next = chain.then(run, run);
  chain = next;
  return next;
}

async function runBatch(files: File[], filing: Filing, place: string | null, queryClient?: QueryClient): Promise<string[]> {
  set({ status: 'running', total: files.length, done: 0, ids: [], place, error: null, run: state.run + 1, undone: false });
  const ids: string[] = [];
  try {
    for (const file of files) {
      ids.push(await noteFromFile(file, filing));
      set({ done: ids.length, ids: [...ids] });
    }
    set({ status: 'done' });
  } catch (err) {
    set({ status: 'error', error: (err as Error).message });
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

/** Takes the batch back: every note it made goes to the trash, where it can be restored. */
export async function undoFileNotes(queryClient?: QueryClient): Promise<void> {
  if (state.ids.length === 0 || state.undone) return;
  await actions.trashNotes(state.ids);
  set({ undone: true });
  if (queryClient) {
    void queryClient.invalidateQueries({ queryKey: ['notes'] });
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
    invalidateNoteMembership(queryClient);
  }
}

/** For tests: back to nothing, whatever was running; a batch still waiting is not. */
export function resetFileNotesForTests(): void {
  state = initial;
  chain = Promise.resolve();
  for (const fn of listeners) fn();
}
