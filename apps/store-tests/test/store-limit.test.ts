import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { feedSeq, freshStore } from './helpers.js';

/**
 * The bound on the store's own bytes (MAK-234): a note write given a limit the store is
 * already past is refused with the upload's own code and `of: 'notes'`, and writes
 * nothing; under the limit, or given none, every write goes through; and the deletes,
 * which take no limit, bring the size back under it.
 */
describe('the store limit', () => {
  const MB = 1024 * 1024;
  const note = (over: Partial<{ id: string; title: string; body: string }> = {}) => ({
    id: over.id ?? crypto.randomUUID(),
    title: over.title ?? 'A note',
    body: over.body ?? '',
    tags: [],
  });
  const size = (stub: ReturnType<typeof freshStore>['stub']) => runInDurableObject(stub, (_i, state) => state.storage.sql.databaseSize);

  it('refuses every note write past the limit, writes nothing, and lets the same writes through under it or without one', async () => {
    const { stub } = freshStore('limit');
    const first = await stub.create(note({ body: 'x'.repeat(MB) }));
    await stub.create(note({ body: 'y'.repeat(MB) }));
    // A copy in the history, for the restore below.
    await stub.update(first.id, { title: 'Renamed' });
    const revision = (await stub.listRevisions(first.id))![0]!;
    const held = await size(stub);
    expect(held).toBeGreaterThan(2 * MB);
    const limit = MB;
    const seq = await feedSeq(stub);

    const refused = { code: 'STORAGE_FULL', of: 'notes', quotaBytes: limit };
    const writes: Array<[string, (limit: number | null | undefined) => Promise<unknown>]> = [
      ['create', (l) => stub.create(note(), l)],
      ['createOrFind', (l) => stub.createOrFind(note(), l)],
      ['createMany', (l) => stub.createMany([note()], undefined, l)],
      ['duplicate', (l) => stub.duplicate(first.id, crypto.randomUUID(), l)],
      ['duplicateOrFind', (l) => stub.duplicateOrFind(first.id, crypto.randomUUID(), l)],
      ['update', (l) => stub.update(first.id, { title: 'Again' }, l)],
      ['appendToBody', (l) => stub.appendToBody(first.id, 'more', l)],
      ['restoreRevision', (l) => stub.restoreRevision(first.id, revision.id, undefined, l)],
      ['updateMany', (l) => stub.updateMany([first.id], { addTags: ['t'] }, l)],
      ['importNote', (l) => stub.importNote({ ...note(), createdAt: 1, updatedAt: 1, contentHash: crypto.randomUUID() }, l)],
      ['setBody', (l) => stub.setBody(first.id, 'replaced', l)],
    ];
    for (const [name, write] of writes) {
      await expect(write(limit), name).rejects.toMatchObject({ ...refused, usedBytes: held });
    }
    // Nothing of any of them landed: the feed did not move and the note is as it was.
    expect(await feedSeq(stub)).toBe(seq);
    expect((await stub.get(first.id))!.title).toBe('Renamed');
    expect(await stub.count()).toBe(2);

    // A file's row is not held up (the quota on files bounds it), but its text is: a
    // text layer is as long as its sender makes it, whatever the file's size. An empty
    // row, which only stops the next pass retrying, goes through.
    await stub.recordAttachment({ id: 'a1', noteId: first.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k1' });
    await stub.recordAttachment({ id: 'a2', noteId: first.id, filename: 'copy.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k2' });
    const text = { attachmentId: 'a1', noteId: first.id, filename: 'scan.pdf' };
    await expect(stub.recordText({ ...text, text: 'scanned page' }, undefined, limit)).rejects.toMatchObject(refused);
    await stub.recordText({ ...text, text: '' }, undefined, limit);
    await stub.recordText({ ...text, text: 'scanned page' }, undefined, null);
    await expect(stub.copyText('a1', { attachmentId: 'a2', noteId: first.id, filename: 'copy.pdf' }, limit)).rejects.toMatchObject(refused);
    await expect(stub.writeAssistantText(first.id, 'copy.pdf', 'what the assistant read', limit)).rejects.toMatchObject(refused);
    expect(await stub.textFor(first.id, 'copy.pdf')).toBe('');

    // Under the limit, and with none, every one of them goes through.
    for (const l of [100 * MB, null, undefined]) {
      for (const [name, write] of writes) {
        await write(l).catch((err: Error) => {
          throw new Error(`${name} at ${String(l)} was refused: ${err.message}`);
        });
      }
    }
  });

  it('lets trashing, purging and emptying the trash through past the limit, and they bring the size back under it', async () => {
    const { stub } = freshStore('limit-out');
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await stub.create(note({ body: 'z'.repeat(MB) }))).id);
    const limit = 2 * MB;
    expect(await size(stub)).toBeGreaterThan(limit);
    await expect(stub.create(note(), limit)).rejects.toMatchObject({ code: 'STORAGE_FULL', of: 'notes' });

    // The way out takes no limit. Trashing alone frees nothing: the notes are still held.
    expect(await stub.remove(ids[0]!)).toBe(true);
    expect(await stub.removeMany(ids.slice(1, 4))).toHaveLength(3);
    expect(await size(stub)).toBeGreaterThan(limit);
    // Purging does, by name and by emptying the trash.
    expect((await stub.purgeOne(ids[0]!)).deleted).toBe(true);
    expect((await stub.purgeMany(ids.slice(1, 3))).deleted).toBe(2);
    expect((await stub.purge('trashed')).notes).toBe(1);
    await stub.removeMany(ids.slice(4));
    await stub.purge('trashed');
    expect(await size(stub)).toBeLessThan(limit);
    expect((await stub.create(note(), limit)).title).toBe('A note');
  });
});
