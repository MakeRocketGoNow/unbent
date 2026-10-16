import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Note } from '@unbent/shared';
import * as actions from './store/actions.js';
import { resetFileNotesForTests } from './file-notes.js';
import { launchFiles } from './launch-files.js';

vi.mock('./store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store/actions.js')>()),
  createNote: vi.fn(),
  uploadFile: vi.fn(),
  saveNote: vi.fn(),
  trashNotes: vi.fn(),
}));
vi.mock('./index-files.js', () => ({ indexUploadedFile: vi.fn() }));

/**
 * A launch is a drop on the list with nowhere to file it: one note per file, through the
 * same routine (`file-notes.ts`, tested there), and the first one opened.
 */

let n = 0;
beforeEach(() => {
  n = 0;
  resetFileNotesForTests();
  vi.mocked(actions.createNote).mockImplementation(async (input) => {
    const note: Note = { id: `n${++n}`, ...input, createdAt: 1, updatedAt: 1, fields: [] };
    return note;
  });
  vi.mocked(actions.uploadFile).mockImplementation(async (_id, file) => ({
    filename: file.name,
    contentType: file.type,
    size: file.size,
    path: `files/${file.name}`,
    indexing: 'server' as const,
  }));
  vi.mocked(actions.saveNote).mockResolvedValue('queued');
});
afterEach(() => vi.clearAllMocks());

describe('launchFiles', () => {
  it('makes a note per file, unfiled, and opens the first', async () => {
    const opened: string[] = [];
    const handle = launchFiles(new QueryClient(), (id) => opened.push(id));
    await handle([
      new File(['%PDF'], 'Water bill.pdf', { type: 'application/pdf' }),
      new File(['png'], 'page 2.png', { type: 'image/png' }),
    ]);
    expect(vi.mocked(actions.createNote).mock.calls.map((c) => c[0])).toEqual([
      { title: 'Water bill', body: '[Water bill.pdf](<files/Water bill.pdf>)\n', tags: [], notebook: null },
      { title: 'page 2', body: '![page 2.png](<files/page 2.png>)\n', tags: [], notebook: null },
    ]);
    expect(opened).toEqual(['n1']);
  });

  /* Two jobs from a scanner close together: the second waits for the first, and both land. */
  it('makes the notes of a second launch after the first, opening each', async () => {
    let release!: () => void;
    vi.mocked(actions.uploadFile).mockReturnValueOnce(new Promise((r) => (release = () => r({ filename: 'a.pdf', contentType: 'application/pdf', size: 1, path: 'files/a.pdf', indexing: 'server' as const }))));
    const opened: string[] = [];
    const handle = launchFiles(new QueryClient(), (id) => opened.push(id));
    const first = handle([new File(['x'], 'a.pdf', { type: 'application/pdf' })]);
    const second = handle([new File(['x'], 'b.pdf', { type: 'application/pdf' })]);
    release();
    await Promise.all([first, second]);
    expect(opened).toEqual(['n1', 'n2']);
  });

  it('opens nothing when no note could be made', async () => {
    vi.mocked(actions.createNote).mockRejectedValue(new Error('refused'));
    const opened: string[] = [];
    await launchFiles(new QueryClient(), (id) => opened.push(id))([new File(['x'], 'a.pdf', { type: 'application/pdf' })]);
    expect(opened).toEqual([]);
  });
});
