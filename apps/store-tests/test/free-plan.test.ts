import { describe, expect, it } from 'vitest';
import { feedSeq, freshStore } from './helpers.js';

/**
 * The free plan as the store holds it (decided 2026-10-24): a write given the free
 * plan's limits is refused when the account is past them, which leaves it read-only,
 * and a write that makes notes is refused once the count would pass the limit, live and
 * trashed together. Deletes, purges, restores from the trash and a file's text take no
 * free limits and go through whatever the account holds; and a write given none checks
 * nothing, which is every account with a plan holding and every instance with billing
 * off.
 */
describe('the free plan', () => {
  const GB = 1024 * 1024 * 1024;
  // The production numbers are a hundred notes and a gigabyte; a smaller count keeps the
  // test quick and says the same thing.
  const free = { notes: 5, attachmentBytes: GB };
  const limits = { store: null, free };
  const note = (over: Partial<{ id: string; title: string }> = {}) => ({
    id: over.id ?? crypto.randomUUID(),
    title: over.title ?? 'A note',
    body: '',
    tags: [],
  });
  const fill = async (stub: ReturnType<typeof freshStore>['stub'], n: number) =>
    (await stub.createMany(Array.from({ length: n }, (_, i) => note({ title: `Note ${i}` })))).map((made) => made.id);

  it('takes a free account up to the count and no further, counting the trash, and keeps every other write open', async () => {
    const { stub } = freshStore('free-count');
    const ids = await fill(stub, 4);
    // Under the count, a note is made as any other.
    const fifth = await stub.create(note(), limits);
    expect(fifth.title).toBe('A note');
    const seq = await feedSeq(stub);

    // At it, each of the writes that make notes is refused with the counts it was
    // decided on, and writes nothing.
    const refused = { code: 'FREE_NOTES_FULL', notes: 5 };
    const creates: Array<[string, () => Promise<unknown>]> = [
      ['create', () => stub.create(note(), limits)],
      ['createOrFind', () => stub.createOrFind(note(), limits)],
      ['createMany', () => stub.createMany([note()], undefined, limits)],
      ['duplicate', () => stub.duplicate(ids[0]!, crypto.randomUUID(), limits)],
      ['duplicateOrFind', () => stub.duplicateOrFind(ids[0]!, crypto.randomUUID(), limits)],
      ['importNote', () => stub.importNote({ ...note(), createdAt: 1, updatedAt: 1, contentHash: crypto.randomUUID() }, limits)],
    ];
    for (const [name, create] of creates) await expect(create(), name).rejects.toMatchObject(refused);
    expect(await feedSeq(stub)).toBe(seq);
    expect(await stub.count()).toBe(5);

    // Every write that makes no note still goes: the account is not read-only.
    expect(await stub.update(ids[0]!, { title: 'Renamed' }, limits)).toMatchObject({ title: 'Renamed' });
    await stub.updateMany([ids[1]!], { addTags: ['kept'] }, limits);
    expect(await stub.appendToBody(ids[1]!, 'more', limits)).toBe(true);
    const notebook = (await stub.createNotebook('Receipts', limits))!;
    expect(await stub.updateNotebook(notebook.id, { name: 'Bills' }, limits)).toBeTruthy();
    await stub.recordAttachment({ id: 'a1', noteId: ids[0]!, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k1' }, undefined, limits);

    // A replay of a create whose note is already here finds it: the count is asked only
    // on the path that would make one.
    expect((await stub.createOrFind({ ...note({ id: fifth.id }), title: 'Replayed' }, limits)).existing).toBe(true);

    // The trash counts. Trashing frees nothing; restoring takes no limit and changes no
    // count; emptying the trash is what makes room.
    expect(await stub.remove(ids[2]!)).toBe(true);
    await expect(stub.create(note(), limits)).rejects.toMatchObject(refused);
    expect(await stub.restore(ids[2]!)).toBe(true);
    expect(await stub.remove(ids[3]!)).toBe(true);
    expect((await stub.purge('trashed')).notes).toBe(1);
    expect((await stub.create(note({ title: 'Made room' }), limits)).title).toBe('Made room');
  });

  it('refuses a batch that would pass the count, and names how much room there was', async () => {
    const { stub } = freshStore('free-batch');
    await fill(stub, 3);
    await expect(stub.createMany([note(), note(), note()], undefined, limits)).rejects.toMatchObject({ code: 'FREE_NOTES_FULL', notes: 3, adding: 3 });
    expect(await stub.count()).toBe(3);
    expect(await stub.createMany([note(), note()], undefined, limits)).toHaveLength(2);
  });

  it('counts only the notes an import or a batch makes, so a resumed import at the count finds what landed', async () => {
    const { stub } = freshStore('free-resume');
    const imported = { id: crypto.randomUUID(), title: 'From the archive', body: 'x', tags: [], createdAt: 1, updatedAt: 1, contentHash: 'hash-1' };
    expect((await stub.importNote(imported, limits)).created).toBe(true);
    await fill(stub, 4);
    // At the count: the same note again is found, not refused; a new one is refused.
    expect(await stub.importNote(imported, limits)).toMatchObject({ id: imported.id, created: false });
    await expect(stub.importNote({ ...imported, id: crypto.randomUUID(), contentHash: 'hash-2' }, limits)).rejects.toMatchObject({ code: 'FREE_NOTES_FULL', notes: 5 });
    // A batch that skips the titles held takes room only for what it makes: one note
    // purged to make room for one, and four titles sent of which three are here.
    const titles = ['Note 0', 'Note 1', 'Note 2', 'Note 3'];
    const ids = (await stub.list({ limit: 10 })).filter((n) => n.title === 'Note 0').map((n) => n.id);
    expect(await stub.remove(ids[0]!)).toBe(true);
    expect((await stub.purgeOne(ids[0]!)).deleted).toBe(true);
    const made = await stub.createMany(titles.map((title) => note({ title })), { skipExisting: true }, limits);
    expect(made.map((m) => m.skipped)).toEqual([false, true, true, true]);
    // And a batch that would pass the count names the account as it stood before it.
    await expect(stub.createMany([note({ title: 'Fresh A' }), note({ title: 'Fresh B' })], { skipExisting: true }, limits)).rejects.toMatchObject({ code: 'FREE_NOTES_FULL', notes: 5, adding: 2 });
  });

  it('makes an account past the limits read-only, lets the way out through, and writes again once it is under', async () => {
    const { stub } = freshStore('free-over');
    const ids = await fill(stub, 7);
    const notebook = (await stub.createNotebook('Receipts'))!;
    const field = await stub.createField(notebook.id, { name: 'Total', type: 'number', options: [] });
    const fieldId = typeof field === 'object' && field && 'id' in field ? (field as { id: string }).id : '';
    const tag = await stub.update(ids[0]!, { tags: ['bills'] });
    const tagId = (await stub.listTags()).find((t) => t.name === 'bills')!.id;
    await stub.update(ids[0]!, { title: 'Earlier' });
    const revision = (await stub.listRevisions(ids[0]!))![0]!;
    const seq = await feedSeq(stub);
    expect(tag).toMatchObject({ tags: ['bills'] });

    const refused = { code: 'PLAN_INACTIVE', notes: 7 };
    const writes: Array<[string, () => Promise<unknown>]> = [
      ['create', () => stub.create(note(), limits)],
      ['createMany', () => stub.createMany([note()], undefined, limits)],
      ['update', () => stub.update(ids[1]!, { title: 'Again' }, limits)],
      ['updateMany', () => stub.updateMany([ids[1]!], { addTags: ['t'] }, limits)],
      ['appendToBody', () => stub.appendToBody(ids[1]!, 'more', limits)],
      ['setBody', () => stub.setBody(ids[1]!, 'replaced', limits)],
      ['restoreRevision', () => stub.restoreRevision(ids[0]!, revision.id, undefined, limits)],
      ['createNotebook', () => stub.createNotebook('Another', limits)],
      ['updateNotebook', () => stub.updateNotebook(notebook.id, { name: 'Renamed' }, limits)],
      ['createField', () => stub.createField(notebook.id, { name: 'Shop', type: 'text', options: [] }, limits)],
      ['updateField', () => stub.updateField(notebook.id, fieldId, { name: 'Amount' }, limits)],
      ['reorderFields', () => stub.reorderFields(notebook.id, [fieldId], limits)],
      ['renameTag', () => stub.renameTag(tagId, 'paid', undefined, limits)],
      ['recolorTag', () => stub.recolorTag(tagId, 3, limits)],
      ['recordAttachment', () => stub.recordAttachment({ id: 'a1', noteId: ids[1]!, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k1' }, undefined, limits)],
      ['autofillPrelude', () => stub.autofillPrelude(ids[1]!, 5, { cap: null, yearlyCents: null }, limits)],
    ];
    for (const [name, write] of writes) await expect(write(), name).rejects.toMatchObject(refused);
    expect(await feedSeq(stub)).toBe(seq);
    expect((await stub.get(ids[1]!))!.title).toBe('Note 1');

    // A save that writes nothing, or of a note that is gone, is answered as it always
    // was: the limits are asked for only by a save that writes.
    expect(await stub.update(ids[0]!, { title: 'Earlier' }, limits)).toMatchObject({ title: 'Earlier' });
    expect(await stub.update('no-such-note', { title: 'x' }, limits)).toBeNull();

    // The way out takes none: trashing, purging, emptying the trash, and a restore.
    expect(await stub.removeMany(ids.slice(4))).toHaveLength(3);
    expect(await stub.restore(ids[6]!)).toBe(true);
    await expect(stub.update(ids[1]!, { title: 'Still over' }, limits)).rejects.toMatchObject(refused);
    expect((await stub.purgeMany(ids.slice(4, 6))).deleted).toBe(2);
    // Five held, which fits: the account writes again, with nothing switched.
    expect(await stub.update(ids[1]!, { title: 'Back' }, limits)).toMatchObject({ title: 'Back' });
    await expect(stub.create(note(), limits)).rejects.toMatchObject({ code: 'FREE_NOTES_FULL', notes: 5 });
  });

  it('holds files past the free plan to the same rule, and leaves their text and every write without limits alone', async () => {
    const { stub } = freshStore('free-bytes');
    const [id] = await fill(stub, 1);
    await stub.recordAttachment({ id: 'big', noteId: id!, filename: 'big.pdf', contentType: 'application/pdf', size: 2 * GB, r2Key: 'kb' });
    await expect(stub.update(id!, { title: 'Over' }, limits)).rejects.toMatchObject({ code: 'PLAN_INACTIVE', notes: 1, attachmentBytes: 2 * GB });
    // A file's text is derived from a file already held, which the read-only rule exempts.
    await stub.recordText({ attachmentId: 'big', noteId: id!, filename: 'big.pdf', text: 'scanned page' }, undefined, limits);
    expect(await stub.textFor(id!, 'big.pdf')).toBe('scanned page');
    // And it is held to the text's own room where the limits name one, not the notes'.
    await expect(stub.recordText({ attachmentId: 'big', noteId: id!, filename: 'big.pdf', text: 'again' }, undefined, { store: 1, free, text: 1 })).rejects.toMatchObject({ code: 'STORAGE_FULL', of: 'notes' });
    await stub.recordText({ attachmentId: 'big', noteId: id!, filename: 'big.pdf', text: 'again' }, undefined, { store: 1, free, text: null });
    expect(await stub.textFor(id!, 'big.pdf')).toBe('again');
    // With no free limits (a plan holding, or billing off) nothing is asked.
    expect(await stub.update(id!, { title: 'With a plan' }, { store: null, free: null })).toMatchObject({ title: 'With a plan' });
    expect(await stub.update(id!, { title: 'No billing' })).toMatchObject({ title: 'No billing' });
    // Deleting the file is the way under.
    expect(await stub.removeAttachment(id!, 'big.pdf')).toBeTruthy();
    expect(await stub.update(id!, { title: 'Under' }, limits)).toMatchObject({ title: 'Under' });
  });
});
