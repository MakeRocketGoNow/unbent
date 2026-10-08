import { beforeAll, describe, expect, it } from 'vitest';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { BATCH, EXPIRY_COST, FINISH_COST, LATE_WRITES_MS, SUBREQUEST_BUDGET, pickAffordable, sweepStores } from '@unbent/api/lib/sweep';
import { DELETED_BLOB_RETENTION_MS } from '@unbent/api/store/deleted-blobs';
import { listRestores, startRestore } from '@unbent/api/lib/restores';
import { RESTORES_DDL } from './helpers.js';

/**
 * The sweep, against real objects and a local D1 carrying the three control-plane
 * tables it reads: `user`, `account_directory` and `_unbent_meta`, created here in the
 * shape migrations 0002, 0030 and 0001 give them. What is checked is the sweep's one
 * invariant and its jobs: a live account is woken and measured and never wiped; a
 * tombstoned account, or one whose user row is gone, is wiped and its row dropped once
 * the object is empty, its prefix in R2 is too, and its late writes are over; an
 * account never opened gets its object created and measured; an
 * account with no directory row gets one; and a walk longer than a batch continues
 * across invocations from where it left off.
 *
 * The D1 here is this file's own, so rows from other files never appear in it, but every
 * test in this file shares it: the counts asserted are lower bounds, and the batching
 * test loops until a pass is done rather than assuming the directory holds only its rows.
 */

const stamp = Date.now();
const uid = (label: string) => `sweep-${label}-${stamp}`;

beforeAll(async () => {
  await env.DB.exec(
    [
      `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS account_directory (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, migrated_at INTEGER, storage_bytes INTEGER NOT NULL DEFAULT 0, note_count INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER, deleted_at INTEGER, copied_at INTEGER, restore_at INTEGER, restore_to_at INTEGER, restore_undo TEXT);`,
      `CREATE TABLE IF NOT EXISTS _unbent_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
      ...RESTORES_DDL,
    ].join(' '),
  );
});

async function user(id: string) {
  await env.DB.prepare(`INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES (?1, 'T', ?2, 'now', 'now')`).bind(id, `${id}@example.test`).run();
}
async function directory(id: string, deletedAt: number | null = null) {
  await env.DB.prepare(`INSERT INTO account_directory (user_id, created_at, deleted_at) VALUES (?1, 1, ?2)`).bind(id, deletedAt).run();
}
async function row(id: string) {
  return env.DB.prepare(`SELECT * FROM account_directory WHERE user_id = ?1`).bind(id).first<{ note_count: number; storage_bytes: number; last_active_at: number | null; deleted_at: number | null }>();
}
const stub = (id: string) => env.USER_STORE.get(env.USER_STORE.idFromName(id));

/** Runs batches until a pass over the whole directory is done, returning the reports. */
async function fullPass(over: Parameters<typeof sweepStores>[0] = env) {
  const reports = [];
  for (let i = 0; i < 20; i++) {
    const report = await sweepStores(over);
    reports.push(report);
    if (report.done) break;
  }
  expect(reports[reports.length - 1]!.done).toBe(true);
  return reports;
}

describe('the store sweep', () => {
  it('measures the living, finishes the dead, and never wipes an account the directory says is alive', async () => {
    // A live account with notes in its object.
    const live = uid('live');
    await user(live);
    await directory(live);
    await stub(live).create({ id: crypto.randomUUID(), title: 'Mine', body: 'keep', tags: [] });
    await stub(live).create({ id: crypto.randomUUID(), title: 'Mine too', body: 'keep', tags: [] });

    // Deleted, with the wipe still to do: the tombstone is set and the object has rows.
    // The user row is gone, as it is after a deletion; the row is only dropped once it is,
    // and once the deletion is old enough that no session of the account can still write.
    const tombstoned = uid('tombstoned');
    await directory(tombstoned, Date.now() - LATE_WRITES_MS - 60_000);
    await stub(tombstoned).create({ id: crypto.randomUUID(), title: 'Gone', body: 'x', tags: [] });

    // Tombstoned but the user row survived — a deletion that wiped the store and then
    // failed to remove the user. Wiped, and kept as a tombstone rather than dropped, or
    // the heal would give an empty account a live row.
    const halfDeleted = uid('half');
    await user(halfDeleted);
    await directory(halfDeleted, Date.now());
    await stub(halfDeleted).create({ id: crypto.randomUUID(), title: 'Half', body: 'x', tags: [] });

    // A row whose user row is missing: the `afterDelete` hook never ran. Wiped, and given
    // the tombstone it should have had, from which its late writes are waited out.
    const orphan = uid('orphan');
    await directory(orphan);
    await stub(orphan).create({ id: crypto.randomUUID(), title: 'Orphaned', body: 'x', tags: [] });

    // Each with a wind-back in the history, which goes with the dead account's row and
    // stays with the living one's.
    for (const id of [live, tombstoned]) await startRestore(env.DB, { userId: id, operatorId: 'op', kind: 'moment', toAt: 1 });

    // Never opened: no object exists until the sweep names it.
    const fresh = uid('fresh');
    await user(fresh);
    await directory(fresh);

    // A user with no directory row at all: created before the hook that writes one, or
    // whose write failed. The sweep heals the directory first, so it is found.
    const unlisted = uid('unlisted');
    await user(unlisted);

    const before = Date.now();
    const reports = await fullPass();
    expect(reports.flatMap((r) => r.failed)).toEqual([]);
    expect(reports.reduce((n, r) => n + r.visited, 0)).toBeGreaterThanOrEqual(6);
    expect(reports.reduce((n, r) => n + r.wiped, 0)).toBeGreaterThanOrEqual(3);

    expect(await row(live)).toMatchObject({ note_count: 2 });
    expect((await row(live))!.storage_bytes).toBeGreaterThan(0);
    // The store's newest write, so the operator page can sort accounts by it without
    // waking every store; it was a column nothing wrote until the sweep did.
    expect((await row(live))!.last_active_at).toBeGreaterThan(0);
    expect((await stub(live).stats()).counts.notes).toBe(2);

    expect(await row(tombstoned)).toBeNull();
    expect((await stub(tombstoned).stats()).wiped).toBe(true);
    expect((await listRestores(env.DB, tombstoned)).restores).toEqual([]);
    expect((await listRestores(env.DB, live)).restores).toHaveLength(1);
    // Stamped with the sweep's own time, so the wait starts now rather than at some
    // earlier moment that would let the row go at once.
    expect((await row(orphan))!.deleted_at).toBeGreaterThanOrEqual(before);
    expect((await stub(orphan).stats()).wiped).toBe(true);
    expect((await stub(halfDeleted).stats()).wiped).toBe(true);
    expect(await env.DB.prepare(`SELECT deleted_at FROM account_directory WHERE user_id = ?1`).bind(halfDeleted).first<{ deleted_at: number | null }>()).toMatchObject({ deleted_at: expect.any(Number) });

    // Woken and measured: the object exists now, with a schema and no notes.
    expect((await row(fresh))!.storage_bytes).toBeGreaterThan(0);
    const freshMeta = await runInDurableObject(stub(fresh), (_i, state) =>
      state.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'user_id'`).toArray(),
    );
    expect(freshMeta).toEqual([{ value: fresh }]);
    expect((await row(unlisted))!.storage_bytes).toBeGreaterThan(0);

    // Running again changes nothing for the living and finds nothing left of the dead.
    const again = await fullPass();
    expect(again.flatMap((r) => r.failed)).toEqual([]);
    expect((await stub(live).stats()).counts.notes).toBe(2);
    expect(await row(tombstoned)).toBeNull();
  });

  it('walks a directory longer than a batch across invocations, then starts over', async () => {
    const ids = Array.from({ length: BATCH + 5 }, (_, i) => uid(`batch-${String(i).padStart(2, '0')}`));
    for (const id of ids) {
      await user(id);
      await directory(id);
    }
    const reports = await fullPass();
    // More than one batch was needed, none but the last was the end, and every one of
    // these accounts was visited exactly once in the pass.
    expect(reports.length).toBeGreaterThan(1);
    expect(reports.slice(0, -1).every((r) => !r.done && r.visited === BATCH)).toBe(true);
    for (const id of ids) expect((await row(id))!.storage_bytes).toBeGreaterThan(0);
    // The pass ended, so the next invocation starts from the top of the directory again.
    const cursor = await env.DB.prepare(`SELECT value FROM _unbent_meta WHERE key = 'store_sweep_cursor'`).first<{ value: string }>();
    expect(cursor?.value).toBe('');
  });

  /**
   * The deploy's pass must visit every account, but the cursor is the cron's and is
   * usually partway down the directory. A batch resumed from the bottom ends at once;
   * `restart` starts at the top whatever the cursor says.
   */
  it('starts from the top of the directory when asked to, whatever the cursor says', async () => {
    const early = uid('restart');
    await user(early);
    await directory(early);
    // Past every id in the directory, as a cursor left near the end of a pass would be.
    const park = () =>
      env.DB.prepare(`INSERT INTO _unbent_meta (key, value) VALUES ('store_sweep_cursor', '~') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();

    await park();
    const resumed = await sweepStores(env);
    expect(resumed).toMatchObject({ visited: 0, done: true });

    await park();
    const restarted = await sweepStores(env, { restart: true });
    expect(restarted.visited).toBeGreaterThan(0);
    // The rest of the pass carries on from where the restarted batch left the cursor.
    const reports = [restarted, ...(restarted.done ? [] : await fullPass())];
    expect(reports[reports.length - 1]!.done).toBe(true);
    expect((await row(early))!.storage_bytes).toBeGreaterThan(0);
  });

  /**
   * A preview Worker shares the dev instance's D1, and usually its note stores, so its
   * walk does nothing at all: it must not heal, measure, drop a row or move the cursor in
   * a directory that is dev's.
   */
  it('does nothing when the sweep is switched off, as on a preview', async () => {
    const preview = uid('preview');
    await user(preview);
    await directory(preview);
    await stub(preview).create({ id: crypto.randomUUID(), title: 'On the preview', body: 'x', tags: [] });
    // A user with no row, which a real pass would heal, and a tombstoned row with no
    // user, which a real pass would drop.
    const unlisted = uid('preview-unlisted');
    await user(unlisted);
    const dead = uid('preview-dead');
    await directory(dead, Date.now());
    const cursorBefore = await env.DB.prepare(`SELECT value FROM _unbent_meta WHERE key = 'store_sweep_cursor'`).first<{ value: string }>();

    const report = await sweepStores({ ...env, STORE_SWEEP: '0' });
    expect(report).toMatchObject({ visited: 0, done: true, failed: [] });
    expect(await row(preview)).toMatchObject({ note_count: 0, storage_bytes: 0 });
    expect(await row(unlisted)).toBeNull();
    expect(await row(dead)).not.toBeNull();
    expect((await stub(preview).usage()).notes).toBe(1);
    const cursorAfter = await env.DB.prepare(`SELECT value FROM _unbent_meta WHERE key = 'store_sweep_cursor'`).first<{ value: string }>();
    expect(cursorAfter?.value ?? null).toBe(cursorBefore?.value ?? null);
  });

  /**
   * Deleted files leave R2 from here and nowhere else (MAK-171, part 1): the walk asks
   * each store for the keys past thirty-five days, deletes them from the bucket, and has
   * the store forget them. A file deleted yesterday stays in the bucket, with its
   * tombstone, for a restore to find.
   */
  it('deletes the files past their retention from R2 and forgets them, and leaves the rest', async () => {
    const id = uid('blobs');
    await user(id);
    await directory(id);
    const s = stub(id);
    const n = await s.create({ id: crypto.randomUUID(), title: 'Files', body: '', tags: [] });
    const key = (name: string) => `users/${id}/notes/${n.id}/files/${name}`;
    for (const name of ['due.pdf', 'fresh.pdf', 'kept.pdf']) {
      await env.BLOBS.put(key(name), name);
      await s.recordAttachment({ id: name, noteId: n.id, filename: name, contentType: 'application/pdf', size: 1, r2Key: key(name) });
    }
    await s.removeAttachment(n.id, 'due.pdf');
    await s.removeAttachment(n.id, 'fresh.pdf');
    // The first deletion was thirty-six days ago.
    await runInDurableObject(s, (_i, state) => {
      state.storage.sql.exec(`UPDATE deleted_blobs SET deleted_at = ?1 WHERE r2_key = ?2`, Date.now() - DELETED_BLOB_RETENTION_MS - 86_400_000, key('due.pdf'));
    });
    // Both objects are in the bucket until the sweep: deleting the rows deleted nothing.
    expect(await env.BLOBS.head(key('due.pdf'))).not.toBeNull();
    expect(await env.BLOBS.head(key('fresh.pdf'))).not.toBeNull();

    const reports = await fullPass();
    expect(reports.flatMap((r) => r.failed)).toEqual([]);
    expect(reports.reduce((n, r) => n + r.blobsDeleted, 0)).toBeGreaterThanOrEqual(1);
    expect(await env.BLOBS.head(key('due.pdf'))).toBeNull();
    expect(await env.BLOBS.head(key('fresh.pdf'))).not.toBeNull();
    expect(await env.BLOBS.head(key('kept.pdf'))).not.toBeNull();
    const left = await runInDurableObject(s, (_i, state) =>
      state.storage.sql.exec<{ r2_key: string }>(`SELECT r2_key FROM deleted_blobs`).toArray().map((r) => r.r2_key),
    );
    expect(left).toEqual([key('fresh.pdf')]);
    // Measured as before, files or no files.
    expect(await row(id)).toMatchObject({ note_count: 1 });
  });

  /**
   * The expiry is two subrequests on top of a visit, and so is finishing a deleted
   * account (a page of its prefix, listed and deleted), and a batch is sized against the
   * Free plan's fifty: once every account is visited, what is left buys as many as fit,
   * deleted accounts first, from a start that rotates with the hour so the same accounts
   * are not put off on every walk. The arithmetic the sweep relies on, pinned: a batch of
   * twenty live accounts fits thirteen expiries, one of twenty deletions finishes three
   * and stays within the fifty, and the accounts chosen move round the list as the hours
   * pass.
   */
  it('budgets the R2 work against the subrequests an invocation has, and rotates who gets it', () => {
    const d1 = 4;
    const due = Array.from({ length: BATCH }, (_, i) => `a${i}`);
    // All twenty live and all with files due: twenty-four spent, thirteen fit.
    const first = pickAffordable(due, d1 + BATCH, 0, EXPIRY_COST);
    expect(first.length).toBe(13);
    expect(d1 + BATCH + first.length * EXPIRY_COST).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect(first).toEqual(due.slice(0, 13));
    // The next hour starts one further on, and wraps: the seven put off come first.
    expect(pickAffordable(due, d1 + BATCH, 1, EXPIRY_COST)).toEqual([...due.slice(1, 14)]);
    expect(pickAffordable(due, d1 + BATCH, 13, EXPIRY_COST)).toEqual([...due.slice(13), ...due.slice(0, 6)]);
    // A batch that is all deletions past their late writes spends forty-four on wipes and
    // `usage`, within the fifty, and finishes three; a wiped store has no files due, so
    // nothing is left for an expiry.
    expect(d1 + BATCH * 2).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    const finished = pickAffordable(due, d1 + BATCH * 2, 5, FINISH_COST);
    expect(finished.length).toBe(3);
    expect(d1 + BATCH * 2 + finished.length * FINISH_COST).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect(pickAffordable([], d1 + BATCH * 2, 5, EXPIRY_COST)).toEqual([]);
    // Nothing left: nothing chosen, however many are due.
    expect(pickAffordable(due, SUBREQUEST_BUDGET - 1, 0, EXPIRY_COST)).toEqual([]);
    // Fewer due than slots: all of them, whatever the hour.
    expect(pickAffordable(['x', 'y'], d1 + BATCH, 7, EXPIRY_COST)).toEqual(['y', 'x']);
  });

  /**
   * A session open when its account was deleted keeps passing `requireAuth` on its cached
   * cookie for a while, and can make a note and upload a file to it after the deletion
   * swept the prefix — measured against `wrangler dev`, see `deleteAccount`. The note
   * comes back in the store and the file under the prefix. While the late writes can
   * still happen the row stays and only the store is wiped; once they are over the sweep
   * deletes what the prefix holds, and the row goes only when that is nothing, so a file
   * cannot be left with nothing to find it.
   */
  it("deletes a deleted account's late files before it drops the row, and not while it could still be written to", async () => {
    const late = uid('late');
    await directory(late, Date.now());
    const s = stub(late);
    const n = await s.create({ id: crypto.randomUUID(), title: 'After the deletion', body: '', tags: [] });
    const key = (name: string) => `users/${late}/notes/${n.id}/files/${name}`;
    for (const name of ['late.pdf', 'later.pdf']) {
      await env.BLOBS.put(key(name), name);
      await s.recordAttachment({ id: name, noteId: n.id, filename: name, contentType: 'application/pdf', size: 1, r2Key: key(name) });
    }
    // An account whose id the late one's is a prefix of, and which is alive: its file is
    // under `users/<id>…/` too, and must not be taken for the deleted account's.
    const neighbour = `${late}x`;
    await user(neighbour);
    await directory(neighbour);
    const neighbourKey = `users/${neighbour}/notes/n/files/mine.pdf`;
    await env.BLOBS.put(neighbourKey, 'mine');

    // Inside the window: wiped, but the row and the files stay, since a session could
    // still be writing under them.
    let reports = await fullPass();
    expect(reports.flatMap((r) => r.failed)).toEqual([]);
    expect((await s.stats()).wiped).toBe(true);
    expect(await row(late)).not.toBeNull();
    expect(await env.BLOBS.head(key('late.pdf'))).not.toBeNull();

    // The window closes. Through a bucket whose pages are one key long, so the prefix
    // takes more than one walk to empty, as an archive's would at a thousand a page: the
    // first walk deletes a file and must keep the row, since the row is all that would
    // find the other; the second deletes the last and drops it.
    await env.DB.prepare(`UPDATE account_directory SET deleted_at = ?2 WHERE user_id = ?1`).bind(late, Date.now() - LATE_WRITES_MS - 1).run();
    const shortPages = Object.assign(Object.create(env.BLOBS) as R2Bucket, {
      list: (options?: R2ListOptions) => env.BLOBS.list({ ...options, limit: 1 }),
      delete: (keys: string | string[]) => env.BLOBS.delete(keys),
    });
    const left = async () => (await env.BLOBS.list({ prefix: `users/${late}/` })).objects.length;
    reports = await fullPass({ ...env, BLOBS: shortPages });
    expect(reports.flatMap((r) => r.failed)).toEqual([]);
    expect(await left()).toBe(1);
    expect(await row(late)).not.toBeNull();

    reports = await fullPass({ ...env, BLOBS: shortPages });
    expect(reports.flatMap((r) => r.failed)).toEqual([]);
    expect(reports.reduce((n, r) => n + r.lateBlobsDeleted, 0)).toBeGreaterThanOrEqual(1);
    expect(await left()).toBe(0);
    expect(await row(late)).toBeNull();
    expect(await env.BLOBS.head(neighbourKey)).not.toBeNull();
    expect(await row(neighbour)).not.toBeNull();
  });

  it('counts one account\'s failure and carries on to the next', async () => {
    const fine = uid('fine');
    await user(fine);
    await directory(fine);
    // An object that refuses to wake: its database claims another user.
    const broken = uid('broken');
    await user(broken);
    await directory(broken);
    const b = stub(broken);
    await b.ping();
    await runInDurableObject(b, (_i, state) => {
      state.storage.sql.exec(`UPDATE _meta SET value = 'someone-else' WHERE key = 'user_id'`);
    });
    await evictDurableObject(b);

    const reports = await fullPass();
    expect(reports.flatMap((r) => r.failed)).toContain(broken);
    expect(reports.flatMap((r) => r.failed)).not.toContain(fine);
    expect((await row(fine))!.storage_bytes).toBeGreaterThan(0);
  });
});
