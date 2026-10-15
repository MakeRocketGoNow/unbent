import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '@unbent/shared';
import * as actions from './store/actions.js';
import { indexUploadedFile } from './index-files.js';
import { getFileNotes, isNoteFile, notesFromFiles, resetFileNotesForTests, titleFor, undoFileNotes } from './file-notes.js';

vi.mock('./store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store/actions.js')>()),
  createNote: vi.fn(),
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
    const ids = await notesFromFiles([pdf('Water bill.pdf'), png('page 2.png')], { notebook: 'Receipts', tags: ['2026'] }, 'Receipts');
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

  it('writes each note in full before starting the next', async () => {
    const order: string[] = [];
    vi.mocked(actions.createNote).mockImplementation(async (input) => {
      order.push(`create ${input.title}`);
      const note: Note = { id: input.title, ...input, createdAt: 1, updatedAt: 1, fields: [] };
      return note;
    });
    vi.mocked(actions.uploadFile).mockImplementation(async (noteId, file) => {
      order.push(`upload ${noteId}`);
      return { filename: file.name, contentType: file.type, size: 1, path: `files/${file.name}`, indexing: 'server' as const };
    });
    await notesFromFiles([pdf('a.pdf'), pdf('b.pdf')], { notebook: null, tags: [] }, null);
    expect(order).toEqual(['create a', 'upload a', 'create b', 'upload b']);
  });

  it('keeps what landed when a file fails, trashes the note its upload left, and says so', async () => {
    failOn = 'b.pdf';
    const ids = await notesFromFiles([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')], { notebook: null, tags: [] }, null);
    expect(ids).toEqual(['n1']);
    expect(getFileNotes()).toMatchObject({ status: 'error', done: 1, total: 3, ids: ['n1'], error: 'Attachment exceeds 100MB limit' });
    expect(actions.createNote).toHaveBeenCalledTimes(2);
    // The note whose file never arrived does not stay, linking to nothing.
    expect(actions.trashNote).toHaveBeenCalledWith('n2');
  });

  it('refuses a file the upload would refuse before making a note of it', async () => {
    await notesFromFiles([new File(['x'], '.hidden.pdf', { type: 'application/pdf' })], { notebook: null, tags: [] }, null);
    expect(getFileNotes()).toMatchObject({ status: 'error', error: 'Filename may not start with a dot' });
    expect(actions.createNote).not.toHaveBeenCalled();
  });

  it('refuses a second batch while one runs', async () => {
    let release!: () => void;
    vi.mocked(actions.uploadFile).mockReturnValueOnce(new Promise((r) => (release = () => r({ filename: 'a.pdf', contentType: 'application/pdf', size: 1, path: 'files/a.pdf', indexing: 'server' as const }))));
    const first = notesFromFiles([pdf('a.pdf')], { notebook: null, tags: [] }, null);
    await vi.waitFor(() => expect(getFileNotes().status).toBe('running'));
    await expect(notesFromFiles([pdf('b.pdf')], { notebook: null, tags: [] }, null)).rejects.toThrow('already');
    release();
    await first;
  });
});

describe('undoFileNotes', () => {
  it('trashes the batch, once', async () => {
    await notesFromFiles([pdf('a.pdf'), pdf('b.pdf')], { notebook: null, tags: [] }, null);
    await undoFileNotes();
    await undoFileNotes();
    expect(actions.trashNotes).toHaveBeenCalledTimes(1);
    expect(actions.trashNotes).toHaveBeenCalledWith(['n1', 'n2']);
    expect(getFileNotes().undone).toBe(true);
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
