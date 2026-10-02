import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { feedRows, feedSeq, freshStore } from './helpers.js';

/**
 * What each write records in the change feed — the rows a client will act on. The rule
 * is in AGENTS.md: a note row for every note whose rendered shape changed, a notebook row
 * for a notebook or its fields, a tag row for a tag, an attachment row for a file; a
 * tombstone only for something gone, never for the trash. These pin the rule method by
 * method, and `feed-coverage.test.ts` holds that no write is missing from it.
 */

const note = (over: Partial<Parameters<ReturnType<typeof freshStore>['stub']['create']>[0]> = {}) => ({
  id: crypto.randomUUID(),
  title: 'Alpha invoice',
  body: 'running quickly through the woods',
  tags: [] as string[],
  ...over,
});

describe('the feed records note writes', () => {
  it('create: the note, and the notebook and tags it brought into being, once each', async () => {
    const { stub } = freshStore('feed-create');
    const n1 = await stub.create(note({ notebook: 'Receipts', tags: ['home', 'acme'] }));
    const nb = (await stub.listNotebooks())[0]!;
    const tags = await stub.listTags();
    const rows = await feedRows(stub);
    // The notebook and tags are recorded by the helpers that made them, before the note.
    expect(rows).toEqual([
      { entity: 'notebook', id: nb.id },
      { entity: 'tag', id: tags.find((t) => t.name === 'home')!.id },
      { entity: 'tag', id: tags.find((t) => t.name === 'acme')!.id },
      { entity: 'note', id: n1.id },
    ]);
    // A second note in the same notebook with the same tags records only itself.
    const seq = await feedSeq(stub);
    const n2 = await stub.create(note({ notebook: 'receipts', tags: ['home'] }));
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'note', id: n2.id }]);
    // A duplicate goes through create.
    const seq2 = await feedSeq(stub);
    const copy = await stub.duplicate(n2.id, crypto.randomUUID());
    expect(await feedRows(stub, seq2)).toEqual([{ entity: 'note', id: copy!.id }]);
  });

  it('update: the note when something changed, nothing for a no-op or a stale save', async () => {
    const { stub } = freshStore('feed-update');
    const n = await stub.create(note());
    const seq = await feedSeq(stub);
    await stub.update(n.id, { title: 'Beta' });
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'note', id: n.id }]);
    const seq2 = await feedSeq(stub);
    await stub.update(n.id, { title: 'Beta' });
    expect(await feedRows(stub, seq2)).toEqual([]);
    expect(await stub.update(n.id, { title: 'Gamma', ifUpdatedAt: 1 })).toMatchObject({ stale: expect.anything() });
    expect(await feedRows(stub, seq2)).toEqual([]);
    // Tags only: the note, and the new tag's row.
    await stub.update(n.id, { tags: ['fresh'] });
    const fresh = (await stub.listTags()).find((t) => t.name === 'fresh')!;
    expect(await feedRows(stub, seq2)).toEqual([{ entity: 'tag', id: fresh.id }, { entity: 'note', id: n.id }]);
  });

  it('append, trash, restore: the note; purge: a tombstone', async () => {
    const { stub } = freshStore('feed-lifecycle');
    const n = await stub.create(note());
    const seq = await feedSeq(stub);
    expect(await stub.appendToBody(n.id, 'more')).toBe(true);
    expect(await stub.remove(n.id)).toBe(true);
    expect(await stub.remove(n.id)).toBe(false);
    expect(await stub.restore(n.id)).toBe(true);
    expect(await stub.purgeOne(n.id)).toEqual({ deleted: false, keys: [] });
    expect(await stub.remove(n.id)).toBe(true);
    expect(await stub.purgeOne(n.id)).toEqual({ deleted: true, keys: [] });
    expect(await feedRows(stub, seq)).toEqual([
      { entity: 'note', id: n.id }, // append
      { entity: 'note', id: n.id }, // trash
      { entity: 'note', id: n.id }, // restore
      { entity: 'note', id: n.id }, // trash
      { entity: 'note', id: n.id, deleted: true },
    ]);
    const m = await stub.create(note());
    const seq2 = await feedSeq(stub);
    await stub.setBody(m.id, 'replaced');
    expect(await feedRows(stub, seq2)).toEqual([{ entity: 'note', id: m.id }]);
  });

  it('the bulk verbs: one row per note they touched, none for the ones they skipped', async () => {
    const { stub } = freshStore('feed-bulk');
    const a = await stub.create(note());
    const b = await stub.create(note());
    const c = await stub.create(note({ tags: ['kept'] }));
    const seq = await feedSeq(stub);
    expect(await stub.removeMany([a.id, b.id, 'ghost'])).toEqual([a.id, b.id]);
    expect(await stub.restoreMany([a.id, c.id])).toEqual([a.id]);
    expect(await feedRows(stub, seq)).toEqual([
      { entity: 'note', id: a.id },
      { entity: 'note', id: b.id },
      { entity: 'note', id: a.id },
    ]);
    const seq2 = await feedSeq(stub);
    // Refiling: only the notes that changed, and the tag row that came into being.
    const moved = await stub.updateMany([a.id, c.id], { addTags: ['kept', 'new'] });
    expect(moved.changed.sort()).toEqual([a.id, c.id].sort());
    const newTag = (await stub.listTags()).find((t) => t.name === 'new')!;
    expect(await feedRows(stub, seq2)).toEqual([
      { entity: 'tag', id: newTag.id },
      ...moved.changed.map((id) => ({ entity: 'note', id })),
    ]);
    const seq3 = await feedSeq(stub);
    expect((await stub.updateMany([c.id], { addTags: ['kept'] })).changed).toEqual([]);
    expect(await feedRows(stub, seq3)).toEqual([]);
    // Purging: tombstones, and the tags the purge swept.
    expect((await stub.purgeMany([b.id, a.id])).deleted).toBe(1);
    expect(await feedRows(stub, seq3)).toEqual([{ entity: 'note', id: b.id, deleted: true }]);
    const seq4 = await feedSeq(stub);
    await stub.removeMany([a.id, c.id]);
    const purged = await stub.purge('trashed');
    expect(purged.notes).toBe(2);
    const rows = await feedRows(stub, seq4);
    expect(rows.slice(0, 2)).toEqual([{ entity: 'note', id: a.id }, { entity: 'note', id: c.id }]);
    expect(rows.slice(2, 4).map((r) => r.id).sort()).toEqual([a.id, c.id].sort());
    expect(rows.slice(2, 4).every((r) => r.deleted)).toBe(true);
    // Every tag was on a purged note, so every tag went with the sweep.
    expect(rows.slice(4).map((r) => r.entity)).toEqual(['tag', 'tag']);
    expect(rows.slice(4).every((r) => r.deleted)).toBe(true);
  });

  it('import: the note once, nothing for a re-import that changes nothing, the note again when it refiles', async () => {
    const { stub } = freshStore('feed-import');
    const input = { title: 'T', body: 'b', tags: ['x'], notebook: 'Inbox', createdAt: 1, updatedAt: 1, contentHash: 'h1' };
    const first = await stub.importNote(input);
    expect(first.created).toBe(true);
    const rows = await feedRows(stub);
    expect(rows.map((r) => r.entity)).toEqual(['notebook', 'tag', 'note']);
    const seq = await feedSeq(stub);
    expect((await stub.importNote(input)).created).toBe(false);
    expect(await feedRows(stub, seq)).toEqual([]);
    // Unfiled by a notebook deletion, then re-imported: the note is refiled and recorded.
    const nb = (await stub.listNotebooks())[0]!;
    await stub.deleteNotebook(nb.id);
    const seq2 = await feedSeq(stub);
    expect((await stub.importNote(input)).created).toBe(false);
    const after = await feedRows(stub, seq2);
    expect(after.map((r) => r.entity)).toEqual(['notebook', 'note']);
    expect(after[1]).toEqual({ entity: 'note', id: first.id });
  });
});

describe('the feed records tag, notebook and field writes', () => {
  it('a tag rename is one row and a delete one tombstone; a merge names the notes that moved', async () => {
    const { stub } = freshStore('feed-tags');
    const a = await stub.create(note({ tags: ['receipts'] }));
    const b = await stub.create(note({ tags: ['receipts', 'receipt'] }));
    await stub.remove(b.id); // trashed notes carry their tags too, and move with them
    const tags = await stub.listTags();
    const receipts = tags.find((t) => t.name === 'receipts')!;
    const seq = await feedSeq(stub);
    expect(await stub.renameTag(receipts.id, 'Receipts')).toEqual({ id: receipts.id, name: 'Receipts', merged: false });
    // The notes carry the tag by id, so nothing about them is in the feed for a rename.
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'tag', id: receipts.id }]);
    // The same name again: nothing changed, nothing recorded.
    const seq2 = await feedSeq(stub);
    await stub.renameTag(receipts.id, 'Receipts');
    expect(await feedRows(stub, seq2)).toEqual([]);
    // A merge: the tag that went is a tombstone, the one that stays is a row, and the
    // notes whose ids changed follow.
    const receipt = (await stub.listTags()).find((t) => t.name === 'receipt') ?? (await listAllTags(stub)).find((t) => t.name === 'receipt')!;
    expect(await stub.renameTag(receipts.id, 'receipt', { merge: true })).toEqual({ id: receipt.id, name: 'receipt', merged: true });
    const merged = await feedRows(stub, seq2);
    expect(merged.slice(0, 2)).toEqual([{ entity: 'tag', id: receipts.id, deleted: true }, { entity: 'tag', id: receipt.id }]);
    expect(merged.slice(2).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    const seq3 = await feedSeq(stub);
    expect(await stub.deleteTag(receipt.id)).toBe(true);
    expect(await feedRows(stub, seq3)).toEqual([{ entity: 'tag', id: receipt.id, deleted: true }]);
  });

  it('a notebook: created, renamed, and deleted with the notes it unfiled', async () => {
    const { stub } = freshStore('feed-notebooks');
    const nb = (await stub.createNotebook('Taxes'))!;
    expect(await feedRows(stub)).toEqual([{ entity: 'notebook', id: nb.id }]);
    expect(await stub.createNotebook('taxes')).toBeNull();
    expect(await feedRows(stub)).toHaveLength(1);
    const a = await stub.create(note({ notebook: 'Taxes' }));
    const b = await stub.create(note({ notebook: 'Taxes' }));
    const seq = await feedSeq(stub);
    expect(await stub.updateNotebook(nb.id, { name: 'Tax', emoji: '🧾' })).toBe('ok');
    // A rename is one row: notes refer to the notebook by id and a client joins the name.
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'notebook', id: nb.id }]);
    const seq2 = await feedSeq(stub);
    expect(await stub.updateNotebook(nb.id, {})).toBe('ok');
    expect(await feedRows(stub, seq2)).toEqual([]);
    expect(await stub.deleteNotebook(nb.id, { trashNotes: true })).toBe(true);
    const gone = await feedRows(stub, seq2);
    expect(gone[0]).toEqual({ entity: 'notebook', id: nb.id, deleted: true });
    expect(gone.slice(1).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('a field: its notebook on every change, and the notes whose values a conversion, deletion or cleared option touched', async () => {
    const { stub } = freshStore('feed-fields');
    const nb = (await stub.createNotebook('Coupons'))!;
    const amount = await stub.createField(nb.id, { name: 'Amount', type: 'text', options: [] });
    const amountId = (amount as { id: string }).id;
    const kind = await stub.createField(nb.id, { name: 'Kind', type: 'select', options: ['food', 'fuel'] });
    const kindId = (kind as { id: string }).id;
    const a = await stub.create(note({ notebook: 'Coupons', fields: { [amountId]: '12', [kindId]: 'food' } }));
    const b = await stub.create(note({ notebook: 'Coupons', fields: { [amountId]: 'twelve', [kindId]: 'fuel' } }));
    const c = await stub.create(note({ notebook: 'Coupons' }));
    let seq = await feedSeq(stub);
    expect(await feedRows(stub, 1)).toEqual(expect.arrayContaining([{ entity: 'notebook', id: nb.id }]));

    // A rename of the field: the notebook, nothing else.
    expect(await stub.updateField(nb.id, amountId, { name: 'Total' })).toMatchObject({ cleared: 0 });
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'notebook', id: nb.id }]);
    seq = await feedSeq(stub);
    // Reordering: the notebook.
    expect(await stub.reorderFields(nb.id, [kindId, amountId])).toBe(true);
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'notebook', id: nb.id }]);
    seq = await feedSeq(stub);
    // A conversion rewrites a's value and clears b's: both notes, and the notebook.
    expect(await stub.updateField(nb.id, amountId, { type: 'number' })).toMatchObject({ cleared: 1 });
    const converted = await feedRows(stub, seq);
    expect(converted[0]).toEqual({ entity: 'notebook', id: nb.id });
    expect(converted.slice(1).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    seq = await feedSeq(stub);
    // Removing an option without clearing: the notebook only (through updateField).
    expect(await stub.removeFieldOption(nb.id, kindId, 'fuel', false)).toMatchObject({ cleared: 0 });
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'notebook', id: nb.id }]);
    seq = await feedSeq(stub);
    // Clearing it: the note that held it, then the notebook.
    const kindNow = await stub.updateField(nb.id, kindId, { options: ['food', 'fuel'] });
    expect(kindNow).toMatchObject({ cleared: 0 });
    seq = await feedSeq(stub);
    expect(await stub.removeFieldOption(nb.id, kindId, 'fuel', true)).toMatchObject({ cleared: 1 });
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'note', id: b.id }, { entity: 'notebook', id: nb.id }]);
    seq = await feedSeq(stub);
    // Deleting the field: the notebook and the one note still holding a value under it.
    expect(await stub.deleteField(nb.id, kindId)).toBe(true);
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'notebook', id: nb.id }, { entity: 'note', id: a.id }]);
    expect(c.id).toBeTruthy();
  });

  it('importing a notebook definition records the notebook once per change it makes', async () => {
    const { stub } = freshStore('feed-import-notebook');
    const first = await stub.importNotebook({ name: 'Podcast Bookmarks', emoji: '🎙️', fields: [{ name: 'Show', type: 'text' }] });
    const rows = await feedRows(stub);
    // resolveNotebook created it, updateNotebook set the emoji, createField added the field.
    expect(rows.every((r) => r.entity === 'notebook' && r.id === first.id)).toBe(true);
    expect(rows.length).toBe(3);
    const seq = await feedSeq(stub);
    await stub.importNotebook({ name: 'Podcast Bookmarks', emoji: '🎙️', fields: [{ name: 'Show', type: 'text' }] });
    expect(await feedRows(stub, seq)).toEqual([]);
  });
});

/** Every tag row, counted or not: `listTags` leaves out tags with no live note. */
async function listAllTags(stub: ReturnType<typeof freshStore>['stub']) {
  return runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ id: string; name: string }>(`SELECT id, name FROM tags`).toArray());
}

describe('the feed records file writes', () => {
  it('a file added or removed names the file and its note; text arriving names the file alone', async () => {
    const { stub } = freshStore('feed-files');
    const n = await stub.create(note());
    const seq = await feedSeq(stub);
    await stub.recordAttachment({ id: 'a1', noteId: n.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k/a1' });
    expect(await feedRows(stub, seq)).toEqual([{ entity: 'attachment', id: 'a1' }, { entity: 'note', id: n.id }]);
    const seq2 = await feedSeq(stub);
    await stub.recordText({ attachmentId: 'a1', noteId: n.id, filename: 'scan.pdf', text: 'acme invoice' });
    expect(await feedRows(stub, seq2)).toEqual([{ entity: 'attachment', id: 'a1' }]);
    const seq3 = await feedSeq(stub);
    // A copy with text: the copy's row, and its text row.
    await stub.recordAttachment({ id: 'a2', noteId: n.id, filename: 'scan-2.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k/a2' });
    await stub.copyText('a1', { attachmentId: 'a2', noteId: n.id, filename: 'scan-2.pdf' });
    expect(await feedRows(stub, seq3)).toEqual([
      { entity: 'attachment', id: 'a2' },
      { entity: 'note', id: n.id },
      { entity: 'attachment', id: 'a2' },
    ]);
    // A copy from a file with no text copies nothing and records nothing.
    const seq4 = await feedSeq(stub);
    await stub.recordAttachment({ id: 'a3', noteId: n.id, filename: 'bare.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k/a3' });
    await stub.recordAttachment({ id: 'a4', noteId: n.id, filename: 'bare-2.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k/a4' });
    const seq5 = await feedSeq(stub);
    await stub.copyText('a3', { attachmentId: 'a4', noteId: n.id, filename: 'bare-2.pdf' });
    expect(await feedRows(stub, seq5)).toEqual([]);
    expect(seq5).toBeGreaterThan(seq4);
    expect(await stub.removeAttachment(n.id, 'scan.pdf')).toBe('k/a1');
    expect(await feedRows(stub, seq5)).toEqual([{ entity: 'attachment', id: 'a1', deleted: true }, { entity: 'note', id: n.id }]);
    expect(await stub.removeAttachment(n.id, 'scan.pdf')).toBeNull();
    expect(await feedRows(stub, seq5)).toHaveLength(2);
  });
});
