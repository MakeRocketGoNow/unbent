import { beforeAll, describe, expect, it } from 'vitest';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { createD1NoteTables, freshStore, seedD1 } from './helpers.js';

/**
 * The one-time copy of an account's rows from the shared D1 database into its object.
 *
 * The test environment's D1 is empty, so the shared tables are created here in the shape
 * migrations 0003–0028 left them — `user_id` on every row, counts on the notebook and tag
 * rows — and filled for a user before their object is first woken. What is checked is
 * what the copy promises: every row arrives, the triggers rebuild the counts and the
 * search index on the way, a reference the shared database let dangle is repaired, the
 * flag is set so a second wake copies nothing, and a copy that stopped part way resumes.
 */

beforeAll(createD1NoteTables);

/** Evicts an object if it is running; one whose constructor threw has already gone. */
async function evict(stub: DurableObjectStub) {
  try {
    await evictDurableObject(stub);
  } catch (err) {
    if (!/not currently running/.test(String(err))) throw err;
  }
}

describe('copy from D1', () => {
  it('copies every row of the account on first wake, rebuilds counts and search, and repairs what dangled', async () => {
    const { userId, stub } = freshStore('copy');
    await seedD1(userId, 30);

    const stats = await stub.stats();
    expect(stats.migratedFromD1).toBe(true);
    expect(stats.counts).toMatchObject({
      notebooks: 2,
      notebook_fields: 1,
      tags: 2,
      notes: 30,
      note_tags: 30,
      note_fields: 15,
      attachments: 30,
      attachment_text: 30,
    });

    // Counts came from the triggers, not from the 999s the shared rows carried; the
    // dangling notebook reference was unfiled; the orphan link was dropped.
    const live = 30 - Math.ceil(30 / 7);
    expect(await stub.count()).toBe(live);
    expect(await stub.count({ trashed: true })).toBe(Math.ceil(30 / 7));
    const notebooks = await stub.listNotebooks();
    expect(notebooks.map((n) => [n.name, n.purpose, n.emoji, n.fields])).toEqual([
      ['Receipts', 'Bills', '🧾', 1],
      ['Recipes', null, null, 0],
    ]);
    expect(notebooks.reduce((n, nb) => n + nb.count, 0)).toBe(live - 1); // the unfiled one
    expect(await stub.countUnfiledNotes()).toBe(1);
    expect((await stub.get(`${userId}-n0029`))?.notebook).toBeNull();
    expect((await stub.listTags()).reduce((n, t) => n + t.count, 0)).toBe(live);
    expect(await stub.recountNotes()).toBe(0);

    // Search, files and values came through whole.
    expect((await stub.search('globex', 5)).length).toBe(5);
    expect(await stub.textFor(`${userId}-n0001`, 'scan.pdf')).toBe('invoice 1 from globex');
    expect(await stub.pendingTextCount()).toBe(0);
    expect((await stub.get(`${userId}-n0001`))?.fields?.[0]).toMatchObject({ name: 'Amount', value: 1 });
    expect(await stub.get(`${userId}-other`)).toBeNull();
    // The copy wrote the directory row itself: from here the account's D1 rows are frozen.
    const dir = await env.DB.prepare(`SELECT migrated_at FROM account_directory WHERE user_id = ?1`).bind(userId).first<{ migrated_at: number | null }>();
    expect(dir?.migrated_at).toEqual(expect.any(Number));

    // A second wake copies nothing: the flag stands and the rows are as they were.
    await evictDurableObject(stub);
    const again = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect((await again.stats()).counts.notes).toBe(30);
    const meta = await runInDurableObject(again, (_i, state) =>
      state.storage.sql.exec<{ key: string }>(`SELECT key FROM _meta ORDER BY key`).toArray().map((r) => r.key),
    );
    expect(meta).toEqual(['migrated_from_d1', 'user_id']);
  });

  it('marks a brand-new account done without copying anything', async () => {
    const { stub } = freshStore('empty');
    const stats = await stub.stats();
    expect(stats.migratedFromD1).toBe(true);
    expect(stats.counts.notes).toBe(0);
  });

  it('resumes from the last committed page after a reset part way', async () => {
    const { userId, stub } = freshStore('resume');
    await seedD1(userId, 12);
    await stub.ping();

    // Wind the object back to the state a reset in the middle of the notes table leaves:
    // notebooks, fields and tags copied whole, the first five notes in, the cursor on the
    // fifth, the flag unset, and nothing after.
    const fifth = await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      const keep = sql.exec<{ id: string }>(`SELECT id FROM notes ORDER BY id LIMIT 5`).toArray().map((r) => r.id);
      sql.exec(`DELETE FROM notes WHERE id NOT IN (${keep.map((k) => `'${k}'`).join(',')})`);
      sql.exec(`DELETE FROM note_tags`);
      sql.exec(`DELETE FROM note_fields`);
      sql.exec(`DELETE FROM attachments`);
      sql.exec(`DELETE FROM _meta WHERE key = 'migrated_from_d1'`);
      return keep[4];
    });
    const rid = (await env.DB.prepare(`SELECT rowid AS rid FROM notes WHERE id = ?1`).bind(fifth).first<{ rid: number }>())!.rid;
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO _meta (key, value) VALUES ('copy_cursor', ?1)`, `notes:${rid}`);
    });
    await evictDurableObject(stub);

    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    const stats = await woke.stats();
    expect(stats.migratedFromD1).toBe(true);
    expect(stats.counts).toMatchObject({ notes: 12, note_tags: 12, note_fields: 6, attachments: 12, attachment_text: 12 });
    expect(await woke.recountNotes()).toBe(0);
  });

  /**
   * The case a review caught: a wake that ran the repair pass and then failed — the
   * verification, a reset — used to leave the cursor on the last table and the repair
   * count at zero, so every later wake verified the same tail, found the child tables
   * short by rows an earlier wake had removed, and threw again, for good. Now the repair
   * count is kept across wakes and a failed verification drops the cursor, so the next
   * wake rescans and converges.
   */
  it('converges after a wake that fails once after the repair pass', async () => {
    const { userId, stub } = freshStore('after-repair');
    await seedD1(userId, 8);
    await stub.ping();
    const before = (await stub.stats()).counts;

    // The state such a failure leaves: copy done and repaired, flag unset, cursor at the
    // end of the last table — and one row the object no longer has, as a reset between
    // a page's transaction and the next could leave it.
    const tail = (await env.DB.prepare(`SELECT MAX(rowid) AS rid FROM attachment_text WHERE user_id = ?1`).bind(userId).first<{ rid: number }>())!.rid;
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`DELETE FROM _meta WHERE key IN ('migrated_from_d1', 'copy_repaired')`);
      sql.exec(`INSERT INTO _meta (key, value) VALUES ('copy_cursor', ?1)`, `attachment_text:${tail}`);
      sql.exec(`DELETE FROM note_tags WHERE rowid = (SELECT MIN(rowid) FROM note_tags)`);
    });
    await evictDurableObject(stub);

    // First wake: nothing new past the cursor, nothing to repair, a child table short by
    // one → verification fails, and the cursor is dropped on the way out.
    const first = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    await expect(first.stats()).rejects.toThrow(/rescans every table/);
    // Second wake: a full rescan puts the row back and verification passes.
    await evict(first);
    const second = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    const stats = await second.stats();
    expect(stats.migratedFromD1).toBe(true);
    expect(stats.counts).toEqual(before);
    expect(await second.recountNotes()).toBe(0);
    const meta = await runInDurableObject(second, (_i, state) =>
      state.storage.sql.exec<{ key: string }>(`SELECT key FROM _meta ORDER BY key`).toArray().map((r) => r.key),
    );
    expect(meta).toEqual(['migrated_from_d1', 'user_id']);
  });

  /**
   * D1 queries count against an invocation's subrequests, fifty on Free, so a wake
   * spends a budget and then pauses with an error the facade answers as a 503. The
   * budget is a knob in `_meta` for this test; nothing in the Worker writes it.
   */
  it('pauses at its query budget with a retryable error and finishes on later wakes', async () => {
    const { userId, stub } = freshStore('budget');
    await seedD1(userId, 6);
    // A budget of twelve: eight are reserved for the verification's counts, so each wake
    // fetches three pages of the sixteen the eight tables take (a page of rows and the
    // empty page after it) before it pauses.
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`DELETE FROM _meta WHERE key = 'migrated_from_d1'`);
      sql.exec(`INSERT INTO _meta (key, value) VALUES ('test_copy_budget', '12')`);
    });
    await evictDurableObject(stub);

    let wakes = 0;
    for (;;) {
      wakes += 1;
      const s = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
      try {
        const stats = await s.stats();
        expect(stats.migratedFromD1).toBe(true);
        expect(stats.counts).toMatchObject({ notes: 6, note_tags: 6, attachments: 6, attachment_text: 6 });
        break;
      } catch (err) {
        expect(err).toMatchObject({ name: 'CopyIncomplete', retryable: true });
        await evict(s);
      }
      expect(wakes).toBeLessThan(12);
    }
    // Several wakes were needed, and the copy picked up where it left off each time.
    expect(wakes).toBeGreaterThan(3);
    const meta = await runInDurableObject(env.USER_STORE.get(env.USER_STORE.idFromName(userId)), (_i, state) =>
      state.storage.sql.exec<{ key: string }>(`SELECT key FROM _meta ORDER BY key`).toArray().map((r) => r.key),
    );
    expect(meta).toEqual(['migrated_from_d1', 'user_id']);
  });

  /**
   * Found in review: `wipe` set its flag in memory only, so a wiped object copied its
   * account back from D1 on its next wake after eviction — a deletion that failed after
   * the wipe would have brought the account back as it was at the cutover, with its files
   * already gone from R2. The marker in the object's key-value storage is what stops it.
   */
  it('stays empty after a wipe and an eviction while D1 still holds the rows', async () => {
    const { userId, stub } = freshStore('wiped');
    await seedD1(userId, 5);
    expect((await stub.stats()).counts.notes).toBe(5);
    await stub.wipe();
    await evict(stub);

    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    const stats = await woke.stats();
    expect(stats).toMatchObject({ wiped: true, migratedFromD1: true });
    expect(stats.counts.notes).toBe(0);
    // Asked for its notes, it starts as a brand-new empty account rather than copying.
    await woke.create({ id: crypto.randomUUID(), title: 'Fresh start', body: '', tags: [] });
    expect((await woke.stats()).counts).toMatchObject({ notes: 1, attachments: 0 });
    await evict(woke);
    expect((await env.USER_STORE.get(env.USER_STORE.idFromName(userId)).stats()).counts.notes).toBe(1);
  });

  /**
   * A mismatch the rescan cannot mend: two notebooks in D1 whose names differ only in
   * case, which the store's `UNIQUE(name COLLATE NOCASE)` folds into one. Each wake would
   * otherwise re-read the whole account from D1 and fail again, for ever; after three
   * failures the copy stops asking and says so without a query.
   */
  it('stops rescanning after three failed verifications', async () => {
    const { userId, stub } = freshStore('stuck');
    await seedD1(userId, 3);
    await env.DB.prepare(`INSERT INTO notebooks VALUES (?1, ?2, 'receipts', 1, NULL, NULL, 0)`).bind(`${userId}-dup`, userId).run();

    const errors: string[] = [];
    for (let wake = 0; wake < 5; wake++) {
      const s = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
      try {
        await s.stats();
        errors.push('ok');
      } catch (err) {
        errors.push((err as Error).name === 'CopyStuck' ? 'stuck' : (err as Error).message.includes('rescans') ? 'rescan' : String(err));
      }
      await evict(s);
    }
    // Three rescans, then the copy gives up — and from then on `stats` answers, because
    // the object stays up; what refuses is a data call, checked below.
    expect(errors).toEqual(['rescan', 'rescan', 'rescan', 'ok', 'ok']);
    // The directory row never got its `migrated_at`, so the account's D1 rows stay writable.
    const dir = await env.DB.prepare(`SELECT migrated_at FROM account_directory WHERE user_id = ?1`).bind(userId).first<{ migrated_at: number | null }>();
    expect(dir?.migrated_at).toBeNull();

    // Stuck is not dead: the object stays up, so the operator can look and a deletion can
    // still wipe it. Only the data methods refuse. Found in review — a reset had made
    // every call fail, including the inspection the error message points at.
    const s = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect(await s.stats()).toMatchObject({ stuck: true, copyFailures: 3, migratedFromD1: false });
    expect(await s.usage()).toMatchObject({ stuck: true, migratedFromD1: false });
    expect((await s.readOnlySql('SELECT COUNT(*) AS n FROM notebooks')).rows).toEqual([{ n: 2 }]);
    await expect(s.list({ limit: 5 })).rejects.toMatchObject({ name: 'CopyStuck' });
    await s.wipe();
    expect(await s.stats()).toMatchObject({ wiped: true, stuck: false });
    await s.create({ id: crypto.randomUUID(), title: 'Started over', body: '', tags: [] });
    expect(await s.stats()).toMatchObject({ stuck: false, migratedFromD1: true });
    expect((await s.stats()).counts.notes).toBe(1);
  });

  /**
   * A run of large texts must not be one page: two hundred of the largest would have been
   * a hundred million characters, past the object's memory once decoded. Pages are cut by
   * total size in the query itself, with the first row always kept, so three texts of
   * three million characters arrive as three pages and a copy of an archive of big scans
   * cannot get stuck on a page it cannot hold.
   */
  it('copies a run of large texts a page at a time', async () => {
    const { userId, stub } = freshStore('bigtext');
    await seedD1(userId, 3);
    const big = 'lorem ipsum '.repeat(250_000); // 3,000,000 characters
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(`UPDATE attachment_text SET text = ?1 WHERE attachment_id = ?2`).bind(big, `${userId}-a${i}`).run();
    }
    const stats = await stub.stats();
    expect(stats.migratedFromD1).toBe(true);
    expect(stats.counts.attachment_text).toBe(3);
    expect((await stub.textFor(`${userId}-n0002`, 'scan.pdf'))?.length).toBe(big.length);
  });
});
