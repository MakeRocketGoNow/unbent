import { describe, expect, it } from 'vitest';
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
