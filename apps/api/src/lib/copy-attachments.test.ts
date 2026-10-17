import { describe, expect, it, vi } from 'vitest';
import type { AttachmentsRepo } from './attachments-repo.js';
import type { NotesRepo } from './notes-repo.js';
import { copyAttachments } from './copy-attachments.js';
import { StorageFull } from './quota.js';

/**
 * What a copy does with a file's text when the store has no room for it (MAK-234): a
 * move takes the text along unbounded, since the source's row goes next and the store
 * does not grow, and never removes the source when the copy of its text failed; a plain
 * copy keeps the file and leaves it without a text row, for the next pass. The round
 * this guards against deleted a moved file's only copy of its text (found in review).
 */

/** A bucket with one object, and the stand-in repos: `copyText` refuses whenever it is given a limit to keep. */
function setup({ linked = false, room = false }: { linked?: boolean; room?: boolean } = {}) {
  const blobs = {
    get: vi.fn(async () => ({ body: 'bytes' })),
    put: vi.fn(async () => ({ size: 3 })),
    delete: vi.fn(async () => undefined),
  } as unknown as R2Bucket;
  const texts = new Map<string, string>([['src', 'the text']]);
  const copyText = vi.fn(async (from: string, to: { attachmentId: string }, opts: { move?: boolean } = {}) => {
    if (!opts.move && !room) throw new StorageFull(2000, 1000, 0, 'notes');
    texts.set(to.attachmentId, texts.get(from)!);
  });
  const remove = vi.fn(async () => {
    texts.delete('src');
    return 'users/u/notes/from/files/src-scan.pdf';
  });
  const attachments = {
    listForNote: async () => [{ filename: 'scan.pdf', size: 3 }],
    resolve: async () => ({ id: 'src', r2_key: 'k', content_type: 'application/pdf' }),
    availableFilename: async (_note: string, desired: string) => desired,
    buildKey: (noteId: string, id: string, filename: string) => `users/u/notes/${noteId}/files/${id}-${filename}`,
    record: async (row: { filename: string; contentType: string; size: number }) => ({ filename: row.filename, contentType: row.contentType, size: row.size }),
    copyText,
    remove,
  } as unknown as AttachmentsRepo;
  const notes = {
    get: async () => ({ body: linked ? '[scan.pdf](files/scan.pdf)' : 'nothing links it' }),
    appendFileLink: vi.fn(async () => true),
  } as unknown as NotesRepo;
  return { blobs, attachments, notes, texts, copyText, remove };
}

const input = { from: 'from', to: 'to', filenames: ['scan.pdf'], quota: null };

describe('copyAttachments and the store limit', () => {
  it('moves a file with its text, unbounded, and removes the source only then', async () => {
    const { blobs, attachments, notes, texts, copyText, remove } = setup();
    const { files } = await copyAttachments(blobs, { attachments, notes }, { ...input, move: true });
    expect(files[0]!.moved).toBe(true);
    expect(copyText).toHaveBeenCalledWith('src', expect.objectContaining({ noteId: 'to', filename: 'scan.pdf' }), { move: true });
    expect(remove).toHaveBeenCalledTimes(1);
    expect([...texts.values()]).toEqual(['the text']);
  });

  it('copies a file without its text when the store has no room, and keeps the source whole', async () => {
    const { blobs, attachments, notes, texts, copyText, remove } = setup();
    const { files } = await copyAttachments(blobs, { attachments, notes }, input);
    expect(files[0]!.moved).toBe(false);
    expect(copyText).toHaveBeenCalledWith('src', expect.anything(), { move: false });
    expect(remove).not.toHaveBeenCalled();
    expect(texts.get('src')).toBe('the text');
    expect(texts.size).toBe(1);
  });

  it('never removes the source when a move\'s text could not be copied', async () => {
    const { blobs, attachments, notes, copyText, remove, texts } = setup();
    copyText.mockRejectedValueOnce(new Error('the object reset'));
    await expect(copyAttachments(blobs, { attachments, notes }, { ...input, move: true })).rejects.toThrow('the object reset');
    expect(remove).not.toHaveBeenCalled();
    expect(texts.get('src')).toBe('the text');
  });

  it('turns a move of a file the source still links into a copy, held to the limit like one', async () => {
    const { blobs, attachments, notes, copyText, remove } = setup({ linked: true });
    const { files } = await copyAttachments(blobs, { attachments, notes }, { ...input, move: true });
    expect(files[0]!.moved).toBe(false);
    expect(copyText).toHaveBeenCalledWith('src', expect.anything(), { move: false });
    expect(remove).not.toHaveBeenCalled();
  });
});
