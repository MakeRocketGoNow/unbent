import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '@unbent/shared';
import * as actions from './store/actions.js';
import { indexUploadedFile } from './index-files.js';
import { resetConnectivity, setReachableForTests } from './connectivity.js';
import { pageBusy } from './busy.js';
import { claimFileNotesFor, getFileNotes, isNoteFile, notesFromFiles, resetFileNotesForTests, titleFor, undoFileNotes } from './file-notes.js';

vi.mock('./store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store/actions.js')>()),
  // `uploadRefusal` is the real one: the rule under test is the store's.
  createNote: vi.fn(),
  synced: vi.fn(async () => true),
  uploadFile: vi.fn(),
  saveNote: vi.fn(),
  trashNote: vi.fn(),
  trashNotes: vi.fn(),
}));
vi.mock('./index-files.js', () => ({ indexUploadedFile: vi.fn() }));

/**
 * One note per file, through the store's actions and in order: the create, with the link
 * already in the body, then the upload to it — so a batch that goes offline halfway
 * replays each note's writes in the order they were made.
 */

const made: Note[] = [];
let failOn: string | null = null;

beforeEach(() => {
  made.length = 0;
  failOn = null;
  resetFileNotesForTests();
  vi.mocked(actions.createNote).mockImplementation(async (input) => {
    const note: Note = { id: `n${made.length + 1}`, ...input, createdAt: 1, updatedAt: 1, fields: [] };
    made.push(note);
    return note;
  });
  vi.mocked(actions.uploadFile).mockImplementation(async (_noteId, file) => {
    if (file.name === failOn) throw new Error('Attachment exceeds 100MB limit');
    return { filename: file.name, contentType: file.type, size: file.size, path: `files/${file.name}`, indexing: 'client' as const };
  });
  vi.mocked(actions.saveNote).mockResolvedValue('queued');
  vi.mocked(actions.trashNote).mockResolvedValue(undefined);
  vi.mocked(actions.trashNotes).mockResolvedValue(2);
});

afterEach(() => vi.clearAllMocks());

const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
const png = (name: string) => new File(['png'], name, { type: 'image/png' });

describe('notesFromFiles', () => {
  it('makes one note per file, named after it, filed where asked, with the file linked from the body', async () => {
    const ids = await notesFromFiles([pdf('Water bill.pdf'), png('page 2.png')], { notebook: 'Receipts', tags: ['2026'] }, 'Receipts', 'list');
    expect(ids).toEqual(['n1', 'n2']);
    expect(vi.mocked(actions.createNote).mock.calls.map((c) => c[0])).toEqual([
      { title: 'Water bill', body: '[Water bill.pdf](<files/Water bill.pdf>)\n', tags: ['2026'], notebook: 'Receipts' },
      { title: 'page 2', body: '![page 2.png](<files/page 2.png>)\n', tags: ['2026'], notebook: 'Receipts' },
    ]);
    expect(vi.mocked(actions.uploadFile).mock.calls.map((c) => [c[0], c[1].name])).toEqual([
      ['n1', 'Water bill.pdf'],
      ['n2', 'page 2.png'],
    ]);
    // Nothing to write after the upload: the body already links the file.
    expect(actions.saveNote).not.toHaveBeenCalled();
    // Indexed from here when the server is not doing it, as a drop on the note is.
    expect(indexUploadedFile).toHaveBeenCalledTimes(2);
    expect(getFileNotes()).toMatchObject({ status: 'done', total: 2, done: 2, ids: ['n1', 'n2'], place: 'Receipts' });
  });

  /* Online, the upload waits for the create to land so it is sent rather than shelved. */
  it('writes each note in full before starting the next, letting the create land before the upload', async () => {
    const order: string[] = [];
    vi.mocked(actions.createNote).mockImplementation(async (input) => {
      order.push(`create ${input.title}`);
      const note: Note = { id: input.title, ...input, createdAt: 1, updatedAt: 1, fields: [] };
      return note;
    });
    vi.mocked(actions.synced).mockImplementation(async (noteId) => {
      order.push(`landed ${noteId}`);
      return true;
    });
    vi.mocked(actions.uploadFile).mockImplementation(async (noteId, file) => {
      order.push(`upload ${noteId}`);
      return { filename: file.name, contentType: file.type, size: 1, path: `files/${file.name}`, indexing: 'server' as const };
    });
    await notesFromFiles([pdf('a.pdf'), pdf('b.pdf')], { notebook: null, tags: [] }, null, 'list');
    expect(order).toEqual(['create a', 'landed a', 'upload a', 'create b', 'landed b', 'upload b']);
  });

  it('does not wait for the create offline, where the upload is queued behind it anyway', async () => {
    setReachableForTests(false);
    try {
      await notesFromFiles([pdf('a.pdf')], { notebook: null, tags: [] }, null, 'list');
    } finally {
      resetConnectivity();
    }
    expect(actions.synced).not.toHaveBeenCalled();
    expect(actions.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('keeps what landed when a file fails, trashes the note its upload left, and says so', async () => {
    failOn = 'b.pdf';
    const ids = await notesFromFiles([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], { notebook: null, tags: [] }, null, 'list');
    expect(ids).toEqual(['n1']);
    expect(getFileNotes()).toMatchObject({ status: 'error', done: 1, total: 3, ids: ['n1'], error: '1 of 3 added; the rest failed: Attachment exceeds 100MB limit' });
    expect(actions.createNote).toHaveBeenCalledTimes(2);
    // The note whose file never arrived does not stay, linking to nothing.
    expect(actions.trashNote).toHaveBeenCalledWith('n2');
  });

  /* Judged over the whole batch first: one bad file of twelve makes no notes, and says which. */
  it('refuses the batch before making any note when a file cannot become one, naming it', async () => {
    await notesFromFiles([pdf('a.pdf'), new File(['x'], '.hidden.pdf', { type: 'application/pdf' }), pdf('c.pdf')], { notebook: null, tags: [] }, null, 'list');
    expect(getFileNotes()).toMatchObject({ status: 'error', ids: [], error: 'Nothing was added. One file cannot become a note: .hidden.pdf (Filename may not start with a dot).' });
    expect(actions.createNote).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a PDF or an image', async () => {
    await notesFromFiles([new File(['x'], 'notes.enex', { type: 'application/xml' }), new File([''], 'folder')], { notebook: null, tags: [] }, null, 'list');
    expect(getFileNotes().error).toBe('Nothing was added. 2 files cannot become a note: notes.enex (not a PDF or an image), folder (not a PDF or an image).');
    expect(actions.createNote).not.toHaveBeenCalled();
  });

  /* A scanner's second job, or a second drop, arrives while the first is landing. */
  it('runs a second batch after the first, not refusing it and not interleaving them', async () => {
    let release!: () => void;
    vi.mocked(actions.uploadFile).mockReturnValueOnce(new Promise((r) => (release = () => r({ filename: 'a.pdf', contentType: 'application/pdf', size: 1, path: 'files/a.pdf', indexing: 'server' as const }))));
    const first = notesFromFiles([pdf('a.pdf')], { notebook: null, tags: [] }, null, 'list');
    await vi.waitFor(() => expect(getFileNotes().status).toBe('running'));
    const second = notesFromFiles([pdf('b.pdf')], { notebook: null, tags: [] }, null, 'list');
    await new Promise((r) => setTimeout(r, 10));
    expect(actions.createNote).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual(['n1']);
    expect(await second).toEqual(['n2']);
    expect(getFileNotes()).toMatchObject({ status: 'done', ids: ['n2'], run: 2 });
  });

  it('runs the batch after one that failed', async () => {
    failOn = 'a.pdf';
    await notesFromFiles([pdf('a.pdf')], { notebook: null, tags: [] }, null, 'list');
    expect(await notesFromFiles([pdf('b.pdf')], { notebook: null, tags: [] }, null, 'list')).toEqual(['n2']);
  });
});

describe('claimFileNotesFor', () => {
  /* A sign-out mid-batch: the rest would be made as whoever signs in next. */
  it('stops a running batch and clears its report when the account changes hands', async () => {
    claimFileNotesFor('u1');
    let release!: () => void;
    vi.mocked(actions.uploadFile).mockReturnValueOnce(new Promise((r) => (release = () => r({ filename: 'a.pdf', contentType: 'application/pdf', size: 1, path: 'files/a.pdf', indexing: 'server' as const }))));
    const batch = notesFromFiles([pdf('a.pdf'), pdf('b.pdf')], { notebook: 'Receipts', tags: [] }, 'Receipts', 'list');
    await vi.waitFor(() => expect(getFileNotes().status).toBe('running'));
    claimFileNotesFor(undefined);
    expect(getFileNotes()).toMatchObject({ status: 'idle', ids: [], place: null });
    release();
    await batch;
    expect(actions.createNote).toHaveBeenCalledTimes(1);
    expect(getFileNotes().status).toBe('idle');
  });

  it('does not run a batch that waited its turn across a sign-out', async () => {
    claimFileNotesFor('u1');
    let release!: () => void;
    vi.mocked(actions.uploadFile).mockReturnValueOnce(new Promise((r) => (release = () => r({ filename: 'a.pdf', contentType: 'application/pdf', size: 1, path: 'files/a.pdf', indexing: 'server' as const }))));
    const first = notesFromFiles([pdf('a.pdf')], { notebook: null, tags: [] }, null, 'list');
    const second = notesFromFiles([pdf('b.pdf')], { notebook: null, tags: [] }, null, 'list');
    await vi.waitFor(() => expect(getFileNotes().status).toBe('running'));
    claimFileNotesFor('u2');
    release();
    // Cut short: the one note made is the earlier account's, so nothing is handed back.
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(actions.createNote).toHaveBeenCalledTimes(1);
  });

  /* A cold launch reaches the batch before the guard has claimed anyone. */
  it('lets the first person claimed adopt a batch begun before anyone was, and a sign-out then stops it', async () => {
    // The first two uploads are held until released; `held` fills as they are made.
    const held: (() => void)[] = [];
    const answer = { filename: 'x', contentType: 'application/pdf', size: 1, path: 'files/x', indexing: 'server' as const };
    vi.mocked(actions.uploadFile).mockImplementation(() =>
      held.length < 2 ? new Promise((r) => held.push(() => r(answer))) : Promise.resolve(answer),
    );
    const batch = notesFromFiles([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], { notebook: null, tags: [] }, null, 'launch');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    claimFileNotesFor('u1');
    expect(getFileNotes().status).toBe('running');
    expect(pageBusy()).toBe(true);
    held[0]!();
    await vi.waitFor(() => expect(held).toHaveLength(2));
    claimFileNotesFor(undefined);
    held[1]!();
    await batch;
    expect(actions.createNote).toHaveBeenCalledTimes(2);
    expect(getFileNotes().status).toBe('idle');
  });

  /*
   * The installed app does not reload on sign-out (`focus-existing`), so a scanner sending
   * files to a window sitting on the login screen reaches `notesFromFiles` with nobody
   * claimed — the same shape as a cold launch. The previous occupancy's `firstOwner` used
   * to fail that batch's `theirs` check, and the files vanished with no report.
   */
  it('lets a launch after a sign-out be adopted by the next person, rather than dropping the files', async () => {
    claimFileNotesFor('u1');
    claimFileNotesFor(undefined);
    const held: (() => void)[] = [];
    const answer = { filename: 'x', contentType: 'application/pdf', size: 1, path: 'files/x', indexing: 'server' as const };
    vi.mocked(actions.uploadFile).mockImplementation(() =>
      held.length < 1 ? new Promise((r) => held.push(() => r(answer))) : Promise.resolve(answer),
    );
    const batch = notesFromFiles([pdf('a.pdf'), pdf('b.pdf')], { notebook: null, tags: [] }, null, 'launch');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(getFileNotes().status).toBe('running');
    claimFileNotesFor('u2');
    held[0]!();
    expect(await batch).toEqual(['n1', 'n2']);
    expect(getFileNotes()).toMatchObject({ status: 'done', ids: ['n1', 'n2'] });
  });

  it('keeps a finished report for the same person, and drops it for the next', async () => {
    claimFileNotesFor('u1');
    await notesFromFiles([pdf('a.pdf')], { notebook: null, tags: [] }, null, 'list');
    claimFileNotesFor('u1');
    expect(getFileNotes().status).toBe('done');
    claimFileNotesFor('u2');
    expect(getFileNotes().status).toBe('idle');
  });
});

describe('undoFileNotes', () => {
  it('trashes the batch, once, and ends its report', async () => {
    await notesFromFiles([pdf('a.pdf'), pdf('b.pdf')], { notebook: null, tags: [] }, null, 'list');
    await undoFileNotes();
    await undoFileNotes();
    expect(actions.trashNotes).toHaveBeenCalledTimes(1);
    expect(actions.trashNotes).toHaveBeenCalledWith(['n1', 'n2']);
    expect(getFileNotes()).toMatchObject({ status: 'idle', ids: [] });
  });

  it('leaves a batch that started while the trash was on its way alone', async () => {
    await notesFromFiles([pdf('a.pdf')], { notebook: null, tags: [] }, null, 'list');
    let release!: () => void;
    vi.mocked(actions.trashNotes).mockReturnValueOnce(new Promise((r) => (release = () => r(1))));
    const undo = undoFileNotes();
    await notesFromFiles([pdf('b.pdf')], { notebook: null, tags: [] }, null, 'list');
    release();
    await undo;
    expect(getFileNotes()).toMatchObject({ status: 'done', ids: ['n2'] });
  });

  /* Pressed, then a sign-out while the trash is on its way: the refusal is not the next person's. */
  it('writes nothing once the account has changed hands', async () => {
    claimFileNotesFor('u1');
    await notesFromFiles([pdf('a.pdf')], { notebook: null, tags: [] }, null, 'list');
    let refuse!: () => void;
    vi.mocked(actions.trashNotes).mockReturnValueOnce(new Promise((_, reject) => (refuse = () => reject(new Error('Unauthorized')))));
    const undo = undoFileNotes();
    claimFileNotesFor(undefined);
    refuse();
    await undo;
    claimFileNotesFor('u2');
    expect(getFileNotes().status).toBe('idle');
  });

  it('says so, and keeps the notes, when the trash is refused', async () => {
    await notesFromFiles([pdf('a.pdf')], { notebook: null, tags: [] }, null, 'list');
    vi.mocked(actions.trashNotes).mockRejectedValueOnce(new Error('Not found'));
    await undoFileNotes();
    expect(getFileNotes()).toMatchObject({ status: 'error', ids: ['n1'], error: 'Could not undo: Not found' });
  });
});

describe('isNoteFile', () => {
  it('takes PDFs and images, by type or by name', () => {
    expect(isNoteFile(pdf('a.pdf'))).toBe(true);
    expect(isNoteFile(png('a.png'))).toBe(true);
    expect(isNoteFile(new File([''], 'scan.PDF'))).toBe(true);
    expect(isNoteFile(new File([''], 'notes.enex'))).toBe(false);
    expect(isNoteFile(new File([''], 'export.zip', { type: 'application/zip' }))).toBe(false);
  });
});

describe('titleFor', () => {
  it('drops the extension and nothing else', () => {
    expect(titleFor('2026-09-18 Water bill.pdf')).toBe('2026-09-18 Water bill');
    expect(titleFor('scan')).toBe('scan');
  });
});
