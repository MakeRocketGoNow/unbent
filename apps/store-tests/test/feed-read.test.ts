import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { FeedPage } from '@unbent/shared';
import { feedSeq, freshStore } from './helpers.js';

/**
 * The feed's reader (`changesSince` and `snapshotPage`) against writes made through
 * the surface, so what a page carries is what a client would apply. The contract is in
 * `packages/shared/src/feed.ts`.
 */

const note = (over: Partial<Parameters<ReturnType<typeof freshStore>['stub']['create']>[0]> = {}) => ({
  id: crypto.randomUUID(),
  title: 'Alpha invoice',
  body: 'running quickly through the woods',
  tags: [] as string[],
  ...over,
});

const page = (p: Awaited<ReturnType<ReturnType<typeof freshStore>['stub']['changesSince']>>): FeedPage => {
  if (p.reset) throw new Error('unexpected reset');
  return p;
};

describe('changesSince', () => {
  it('carries each entity once, whole, as it now is, with tombstones for what is gone', async () => {
    const { stub } = freshStore('read-feed');
    expect(await stub.changesSince(0, 100)).toMatchObject({ reset: false, seq: 0, next: 0, more: false, notes: [], tombstones: [] });

    const a = await stub.create(note({ notebook: 'Receipts', tags: ['home'] }));
    await stub.update(a.id, { title: 'Edited twice' });
    await stub.update(a.id, { title: 'Edited thrice' });
    const b = await stub.create(note());
    await stub.recordAttachment({ id: 'f1', noteId: b.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, r2Key: 'k/f1' });
    await stub.recordText({ attachmentId: 'f1', noteId: b.id, filename: 'scan.pdf', text: 'acme' });
    const c = await stub.create(note({ tags: ['gone'] }));
    await stub.remove(c.id);
    await stub.purgeOne(c.id);

    const p = page(await stub.changesSince(0, 100));
    expect(p.seq).toBe(await feedSeq(stub));
    expect(p.next).toBe(p.seq);
    expect(p.more).toBe(false);
    expect(p.epoch).toMatch(/^[0-9a-f]{32}$/);
    // Note a three times and b thrice (create, file, text) collapse to one each, as they are now.
    expect(p.notes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    const home = (await stub.listTags()).find((t) => t.name === 'home')!;
    const receipts = (await stub.listNotebooks())[0]!;
    const noteA = p.notes.find((n) => n.id === a.id)!;
    expect(noteA).toMatchObject({ title: 'Edited thrice', notebookId: receipts.id, tagIds: [home.id], files: [] });
    // Names are the tag's and the notebook's rows to carry, not the note's.
    expect(noteA).not.toHaveProperty('tags');
    expect(noteA).not.toHaveProperty('notebook');
    expect(p.notes.find((n) => n.id === b.id)).toMatchObject({ files: [{ id: 'f1', noteId: b.id, filename: 'scan.pdf', contentType: 'application/pdf', size: 3, hasText: true, createdAt: expect.any(Number) }] });
    expect(p.notebooks).toEqual([{ id: expect.any(String), name: 'Receipts', purpose: null, emoji: null, fieldDefs: [] }]);
    // The tag c took to the trash keeps its row with no live note; `purgeOne` leaves the
    // sweep to the bulk purges, so it is a tag row here, not a tombstone. No counts: a
    // client derives them from the notes it holds.
    expect(p.tags).toEqual([
      { id: expect.any(String), name: 'gone', color: expect.any(Number) },
      { id: expect.any(String), name: 'home', color: expect.any(Number) },
    ]);
    expect(p.attachments).toEqual([expect.objectContaining({ id: 'f1', noteId: b.id, hasText: true })]);
    // c was created, tagged, trashed and purged within the page: one tombstone, no note.
    expect(p.tombstones).toEqual([{ entity: 'note', id: c.id }]);
    expect(p.notes.find((n) => n.id === c.id)).toBeUndefined();

    // From the cursor on: nothing, until something changes; a trashed note comes with `deletedAt`.
    expect(page(await stub.changesSince(p.next, 100))).toMatchObject({ notes: [], next: p.next, more: false });
    await stub.remove(b.id);
    const after = page(await stub.changesSince(p.next, 100));
    expect(after.notes).toEqual([expect.objectContaining({ id: b.id, deletedAt: expect.any(Number) })]);
  });

  it('pages: a full page says more, the next continues from its last seq', async () => {
    const { stub } = freshStore('read-pages');
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await stub.create(note({ title: `N${i}` }))).id);
    const first = page(await stub.changesSince(0, 3));
    expect(first.notes.map((n) => n.title)).toEqual(['N0', 'N1', 'N2']);
    expect(first).toMatchObject({ next: 3, more: true });
    const second = page(await stub.changesSince(first.next, 3));
    expect(second.notes.map((n) => n.title)).toEqual(['N3', 'N4', 'N5']);
    const third = page(await stub.changesSince(second.next, 3));
    expect(third.notes.map((n) => n.title)).toEqual(['N6']);
    expect(third).toMatchObject({ next: 7, more: false });
  });

  it('cuts a page on bytes and carries the cursor of the last note kept', async () => {
    const { stub } = freshStore('read-cut');
    const big = 'x'.repeat(1_500_000);
    for (let i = 0; i < 4; i++) await stub.create(note({ title: `Big ${i}`, body: big }));
    const first = page(await stub.changesSince(0, 100));
    // Four of 1.5 MB against a 4 MiB budget: two go, the third would overflow.
    expect(first.notes.map((n) => n.title)).toEqual(['Big 0', 'Big 1']);
    expect(first).toMatchObject({ next: 2, more: true });
    const second = page(await stub.changesSince(first.next, 100));
    expect(second.notes.map((n) => n.title)).toEqual(['Big 2', 'Big 3']);
    expect(second.more).toBe(false);
  });

  it('decides the cut on sizes, in bytes, before it loads a body', async () => {
    const { stub } = freshStore('read-cut-sizes');
    // Eight notes of 1.5 MB: a page of them loaded whole would be 12 MB in the object.
    for (let i = 0; i < 8; i++) await stub.create(note({ title: `Big ${i}`, body: 'x'.repeat(1_500_000) }));
    await stub.resetCounters();
    const first = page(await stub.changesSince(0, 100));
    expect(first.notes.map((n) => n.title)).toEqual(['Big 0', 'Big 1']);
    const { rowsRead } = await stub.counters();
    // The eight feed rows, eight sizes, and two notes whole: the six dropped notes were
    // never read. Loading all eight first read about sixty rows here (measured 36).
    expect(rowsRead).toBeLessThan(45);
    const snap = await stub.snapshotPage(null, 100);
    expect(snap.notes).toHaveLength(2);
    expect(snap.next).toBe(snap.notes[1]!.id);
    // Bytes, not characters: three-byte characters count three times over.
    const { stub: wide } = freshStore('read-cut-utf8');
    await wide.create(note({ title: 'Wide 0', body: '語'.repeat(1_000_000) })); // 3 MB in UTF-8
    await wide.create(note({ title: 'Wide 1', body: '語'.repeat(1_000_000) }));
    const w = page(await wide.changesSince(0, 100));
    expect(w.notes.map((n) => n.title)).toEqual(['Wide 0']);
    expect(w.more).toBe(true);
  });

  it('answers reset for a cursor past the counter or before the oldest row kept', async () => {
    const { stub } = freshStore('read-reset');
    const a = await stub.create(note());
    expect(await stub.changesSince(99, 100)).toEqual({ reset: true, seq: 1, epoch: expect.any(String) });
    // Prune the first row away, as retention would.
    for (let i = 0; i < 3; i++) await stub.update(a.id, { title: `t${i}` });
    await runInDurableObject(stub, (_i, state) => state.storage.sql.exec(`DELETE FROM changes WHERE seq <= 2`));
    expect(await stub.changesSince(0, 100)).toMatchObject({ reset: true });
    expect(await stub.changesSince(1, 100)).toMatchObject({ reset: true });
    // A cursor at the row just before the oldest kept is fine: it has seen everything older.
    expect(await stub.changesSince(2, 100)).toMatchObject({ reset: false, next: 4 });
    expect(await stub.changesSince(4, 100)).toMatchObject({ reset: false, next: 4, notes: [] });
  });

  it('feedRestored names a new epoch, and a cursor from the old one is reset by the server', async () => {
    const { stub } = freshStore('read-epoch');
    const a = await stub.create(note());
    const before = page(await stub.changesSince(0, 10, undefined)).epoch;
    expect(await stub.changesSince(1, 10, before)).toMatchObject({ reset: false, next: 1 });
    const { epoch } = await stub.feedRestored();
    expect(epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(epoch).not.toBe(before);
    // The same cursor with the old epoch: refused, whatever the counter says. With the
    // new one, or with none, served.
    expect(await stub.changesSince(1, 10, before)).toEqual({ reset: true, seq: 1, epoch });
    expect(await stub.changesSince(1, 10, epoch)).toMatchObject({ reset: false, epoch });
    expect(page(await stub.changesSince(0, 10)).notes.map((n) => n.id)).toEqual([a.id]);
  });

  it('a merge delivers retagged notes before the loser\'s tombstone, so a short page cannot hide the tag', async () => {
    const { stub } = freshStore('read-merge-page');
    const moved: string[] = [];
    for (let i = 0; i < 4; i++) moved.push((await stub.create(note({ tags: ['receipts'] }))).id);
    await stub.create(note({ tags: ['receipt'] }));
    const tags = await stub.listTags();
    const receipts = tags.find((t) => t.name === 'receipts')!;
    const receipt = tags.find((t) => t.name === 'receipt')!;
    const since = await feedSeq(stub);
    expect(await stub.renameTag(receipts.id, 'receipt', { merge: true })).toEqual({
      id: receipt.id,
      name: 'receipt',
      merged: true,
    });
    const first = page(await stub.changesSince(since, 2));
    expect(first.more).toBe(true);
    expect(first.notes).toHaveLength(2);
    expect(first.notes.every((n) => n.tagIds.includes(receipt.id))).toBe(true);
    expect(first.tombstones).toEqual([]);
    let cursor = first.next;
    let sawTombstone = false;
    for (;;) {
      const next = page(await stub.changesSince(cursor, 2));
      if (next.tombstones.some((t) => t.entity === 'tag' && t.id === receipts.id)) sawTombstone = true;
      if (!next.more) break;
      cursor = next.next;
    }
    expect(sawTombstone).toBe(true);
  });
});

describe('snapshotPage', () => {
  it('walks every note by id, trashed included, and carries the library on the first page', async () => {
    const { stub } = freshStore('snapshot');
    const nb = (await stub.createNotebook('Coupons'))!;
    await stub.createField(nb.id, { name: 'Amount', type: 'number', options: [] });
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await stub.create(note({ notebook: 'Coupons', tags: ['t'] }))).id);
    await stub.remove(made[4]!);
    const seq = await feedSeq(stub);

    const first = await stub.snapshotPage(null, 2);
    expect(first.seq).toBe(seq);
    expect(first.notebooks).toEqual([{ id: nb.id, name: 'Coupons', purpose: null, emoji: null, fieldDefs: [expect.objectContaining({ name: 'Amount' })] }]);
    expect(first.tags).toEqual([{ id: expect.any(String), name: 't', color: expect.any(Number) }]);
    expect(first.total).toBe(5);
    expect(first.notes).toHaveLength(2);
    expect(first.next).toBe(first.notes[1]!.id);

    const second = await stub.snapshotPage(first.next, 2);
    expect(second.notebooks).toBeUndefined();
    expect(second.total).toBeUndefined();
    const third = await stub.snapshotPage(second.next, 2);
    expect(third.notes).toHaveLength(1);
    expect(third.next).toBeNull();
    const all = [...first.notes, ...second.notes, ...third.notes];
    expect(all.map((n) => n.id).sort()).toEqual([...made].sort());
    expect(all.map((n) => n.id)).toEqual([...all.map((n) => n.id)].sort());
    expect(all.find((n) => n.id === made[4])).toMatchObject({ deletedAt: expect.any(Number), tagIds: [first.tags![0]!.id] });
    // An exact fit: the last page is full and says so with a cursor; the one after is empty.
    const fit = await stub.snapshotPage(second.next, 1);
    expect(fit.next).toBe(made.sort()[4]);
    expect(await stub.snapshotPage(fit.next, 1)).toMatchObject({ notes: [], next: null });
  });
});
