import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { DELETED_BLOB_RETENTION_MS, EXPIRED_BLOBS_PER_VISIT } from '@unbent/api/store/deleted-blobs';
import { DUMP_TABLES } from '@unbent/api/store/tables';
import { freshStore } from './helpers.js';

/**
 * Deleted files follow the store (MAK-171, part 1): every method that deletes an
 * attachment row leaves the file's key in `deleted_blobs` with the time, the hourly sweep
 * takes the keys past thirty-five days and tells the store to forget them, and a key
 * recorded again loses its tombstone. Each rule here is one a store restore depends on:
 * a tombstone that was missing, or one that outlived its row's return, is a file deleted
 * from under a restored note thirty-five days later.
 */

type Stub = ReturnType<typeof freshStore>['stub'];
const DAY = 24 * 60 * 60 * 1000;

const file = (noteId: string, id: string) => ({
  id,
  noteId,
  filename: `${id}.pdf`,
  contentType: 'application/pdf',
  size: 3,
  r2Key: `users/u/notes/${noteId}/files/${id}-${id}.pdf`,
});

/** The table as it stands, by key. */
function tombstones(stub: Stub) {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql.exec<{ r2_key: string; deleted_at: number }>(`SELECT r2_key, deleted_at FROM deleted_blobs ORDER BY r2_key`).toArray(),
  );
}

describe('deleted files', () => {
  it('are tombstoned by every method that deletes a row, with the keys of the rows that went and no others', async () => {
    const { stub } = freshStore('tombstones');
    const live = await stub.create({ id: 'live', title: 'Kept', body: '', tags: [] });
    await stub.recordAttachment(file(live.id, 'keep'));
    await stub.recordAttachment(file(live.id, 'gone'));
    const before = Date.now();

    // A file deleted from a live note.
    expect(await stub.removeAttachment(live.id, 'gone.pdf')).toBe(file(live.id, 'gone').r2Key);
    expect(await stub.removeAttachment(live.id, 'gone.pdf')).toBeNull();
    expect(await tombstones(stub)).toEqual([{ r2_key: file(live.id, 'gone').r2Key, deleted_at: expect.any(Number) }]);
    expect((await tombstones(stub))[0]!.deleted_at).toBeGreaterThanOrEqual(before);

    // One trashed note purged; a live one named beside it is left alone, files included.
    const one = await stub.create({ id: 'one', title: 'One', body: '', tags: [] });
    await stub.recordAttachment(file(one.id, 'f1'));
    await stub.remove(one.id);
    expect(await stub.purgeOne(live.id)).toEqual({ deleted: false, keys: [] });
    expect(await stub.purgeOne(one.id)).toEqual({ deleted: true, keys: [file(one.id, 'f1').r2Key] });

    // Several at once: a note restored under the selection keeps its file.
    const a = await stub.create({ id: 'a', title: 'A', body: '', tags: [] });
    const b = await stub.create({ id: 'b', title: 'B', body: '', tags: [] });
    await stub.recordAttachment(file(a.id, 'fa'));
    await stub.recordAttachment(file(b.id, 'fb'));
    await stub.removeMany([a.id, b.id]);
    await stub.restore(b.id);
    expect(await stub.purgeMany([a.id, b.id, live.id])).toEqual({ deleted: 1, keys: [file(a.id, 'fa').r2Key] });

    // Emptying the trash, then wiping the account.
    const c = await stub.create({ id: 'c', title: 'C', body: '', tags: [] });
    await stub.recordAttachment(file(c.id, 'fc'));
    await stub.remove(c.id);
    expect(await stub.purge('trashed')).toMatchObject({ notes: 1, keys: [file(c.id, 'fc').r2Key] });
    expect(await stub.purge('all')).toMatchObject({ notes: 2, keys: expect.arrayContaining([file(live.id, 'keep').r2Key, file(b.id, 'fb').r2Key]) });

    expect((await tombstones(stub)).map((t) => t.r2_key).sort()).toEqual(
      ['gone', 'f1', 'fa', 'fc', 'keep', 'fb'].map((id) => file({ gone: 'live', f1: 'one', fa: 'a', fc: 'c', keep: 'live', fb: 'b' }[id]!, id).r2Key).sort(),
    );
    expect((await stub.stats()).counts).toMatchObject({ attachments: 0, deleted_blobs: 6 });
    // The feed heard about the notes and the file, not about the tombstones.
    expect(await stub.allBlobKeys()).toEqual({ keys: [], nextRowid: null });
  });

  it('gives the sweep only the keys past the retention, oldest first and one delete call at most, and forgets only those', async () => {
    const { stub } = freshStore('expiry');
    await stub.create({ id: 'n', title: 'N', body: '', tags: [] });
    const now = Date.now();
    // Three files deleted at known times: 40 days ago, 36 days ago, and today.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO deleted_blobs (r2_key, deleted_at) VALUES ('k/oldest', ?1), ('k/old', ?2), ('k/fresh', ?3)`,
        now - 40 * DAY,
        now - 36 * DAY,
        now,
      );
    });

    const visit = await stub.sweepVisit(now);
    expect(visit).toMatchObject({ notes: 1, wiped: false, expiredBlobs: ['k/oldest', 'k/old'] });
    // The day before the retention is out, nothing; the day it is, the key.
    expect((await stub.sweepVisit(now + DELETED_BLOB_RETENTION_MS - DAY)).expiredBlobs).toEqual(['k/oldest', 'k/old']);
    expect((await stub.sweepVisit(now + DELETED_BLOB_RETENTION_MS)).expiredBlobs).toEqual(['k/oldest', 'k/old', 'k/fresh']);

    // Between the sweep asking and telling, the fresh key's file was deleted again: a
    // newer tombstone the forget must leave, or its object would never be asked about.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE deleted_blobs SET deleted_at = ?1 WHERE r2_key = 'k/old'`, now);
    });
    expect(await stub.forgetBlobs(['k/oldest', 'k/old', 'k/never-here'], now)).toEqual({ forgotten: 1 });
    expect((await tombstones(stub)).map((t) => t.r2_key)).toEqual(['k/fresh', 'k/old']);
    expect((await stub.sweepVisit(now)).expiredBlobs).toEqual([]);
  });

  it('hands over at most one R2 delete call of keys a visit, and the rest on the next', async () => {
    const { stub } = freshStore('expiry-page');
    const now = Date.now();
    await runInDurableObject(stub, (_i, state) => {
      state.storage.transactionSync(() => {
        for (let i = 0; i < EXPIRED_BLOBS_PER_VISIT + 5; i++) {
          state.storage.sql.exec(`INSERT INTO deleted_blobs (r2_key, deleted_at) VALUES (?1, ?2)`, `k/${String(i).padStart(4, '0')}`, now - 40 * DAY - i);
        }
      });
    });
    const first = (await stub.sweepVisit(now)).expiredBlobs;
    expect(first.length).toBe(EXPIRED_BLOBS_PER_VISIT);
    await stub.forgetBlobs(first, now);
    const second = (await stub.sweepVisit(now)).expiredBlobs;
    expect(second.length).toBe(5);
    expect(new Set([...first, ...second]).size).toBe(EXPIRED_BLOBS_PER_VISIT + 5);
  });

  it('takes the tombstone off a key that is recorded again, so a replayed upload keeps its file', async () => {
    const { stub } = freshStore('revive');
    const n = await stub.create({ id: 'n', title: 'N', body: '', tags: [] });
    const f = file(n.id, 'same-id');
    await stub.recordAttachment(f);
    await stub.removeAttachment(n.id, f.filename);
    expect((await tombstones(stub)).map((t) => t.r2_key)).toEqual([f.r2Key]);
    // The outbox replays the upload: same id, same key, a live row again.
    await stub.recordAttachment(f);
    expect(await tombstones(stub)).toEqual([]);
    // Thirty-six days on, the sweep has nothing to take from this store.
    expect((await stub.sweepVisit(Date.now() + 36 * DAY)).expiredBlobs).toEqual([]);
    expect(await stub.allBlobKeys()).toEqual({ keys: [f.r2Key], nextRowid: null });
  });

  it('pages every tombstoned key by key for the blob sweep to count as referenced', async () => {
    const { stub } = freshStore('gc-keys');
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO deleted_blobs (r2_key, deleted_at) VALUES ('k0', 1), ('k1', 1), ('k2', 1), ('k3', 1), ('k4', 1)`);
    });
    const first = await stub.tombstonedBlobKeys('', 2);
    expect(first).toEqual({ keys: ['k0', 'k1'], next: 'k1' });
    const second = await stub.tombstonedBlobKeys(first.next!, 2);
    expect(second).toEqual({ keys: ['k2', 'k3'], next: 'k3' });
    expect(await stub.tombstonedBlobKeys(second.next!, 2)).toEqual({ keys: ['k4'], next: null });
    expect(await stub.tombstonedBlobKeys()).toMatchObject({ keys: ['k0', 'k1', 'k2', 'k3', 'k4'], next: null });
  });

  it('is dumped with the data tables, so a store rebuilt from a dump still owes its deletions', async () => {
    const { stub } = freshStore('dumped');
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO deleted_blobs (r2_key, deleted_at) VALUES ('users/u/x', 42)`);
    });
    // The last table, so its slice holds nothing else.
    const page = await stub.dumpSlice({ table: DUMP_TABLES.indexOf('deleted_blobs'), after: 0 });
    expect(new TextDecoder().decode(page.bytes)).toBe(`INSERT INTO deleted_blobs (r2_key, deleted_at) VALUES ('users/u/x', 42);\n`);
    expect(await stub.schemaSql()).toEqual(expect.arrayContaining([expect.stringContaining('CREATE TABLE deleted_blobs'), expect.stringContaining('idx_deleted_blobs_due')]));
  });
});
