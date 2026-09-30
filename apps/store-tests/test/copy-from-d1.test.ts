import { beforeAll, describe, expect, it } from 'vitest';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { createD1NoteTables, freshStore, seedD1 } from './helpers.js';

/**
 * The one-time copy of an account's rows from the shared D1 database into its object.
 *
 * The test environment's D1 is empty, so the shared tables are created here in the shape
 * migrations 0003–0028 left them — `user_id` on every row, counts on the notebook and tag
 * rows — and filled for a user before their object is asked to copy. What is checked is
 * what the copy promises: nothing happens until it is asked; every row arrives when it
 * is, the triggers rebuild the counts and the search index on the way, a reference the
 * shared database let dangle is unfiled or skipped, the flag is set so a second call
 * copies nothing; a call that spends its budget pauses and the next continues; a note
 * written before the copy survives it, with its tag merged into the one D1 delivers;
 * and a mismatch is reported, not retried, until the operator says so.
 */

beforeAll(createD1NoteTables);

const metaKeys = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ key: string }>(`SELECT key FROM _meta ORDER BY key`).toArray().map((r) => r.key));

describe('copy from D1', () => {
  it('copies nothing on wake, and every row of the account when asked, rebuilding counts and search', async () => {
    const { userId, stub } = freshStore('copy');
    await seedD1(userId, 30);
    // A file whose note the shared database no longer has: fetched, since files are
    // found by user, and skipped. (The seed's orphan tag link is found through its note,
    // so it is never fetched at all, and D1's own count leaves it out the same way.)
    await env.DB.prepare(`INSERT INTO attachments (id, note_id, user_id, filename, content_type, size, r2_key, created_at) VALUES (?1, 'nowhere', ?2, 'lost.pdf', 'application/pdf', 1, 'k', 1)`).bind(`${userId}-lost`, userId).run();

    // Waking reads nothing from D1: the object is empty and says the copy has not run.
    expect(await stub.stats()).toMatchObject({ migratedFromD1: false, copyMismatch: null });
    expect((await stub.stats()).counts.notes).toBe(0);

    const result = await stub.copyFromD1();
    expect(result).toMatchObject({ status: 'done', resumed: false, corrections: 0, unfiled: 1, skipped: 1, merged: 0 });
    if (result.status !== 'done') throw new Error('unreachable');
    expect(result.copied).toEqual({ notebooks: 2, notebook_fields: 1, tags: 2, notes: 30, note_tags: 30, note_fields: 15, attachments: 30, attachment_text: 30 });
    expect(result.usage).toMatchObject({ notes: 30, migratedFromD1: true });

    const stats = await stub.stats();
    expect(stats.migratedFromD1).toBe(true);
    expect(stats.counts).toMatchObject({ notebooks: 2, notebook_fields: 1, tags: 2, notes: 30, note_tags: 30, note_fields: 15, attachments: 30, attachment_text: 30 });

    // Counts came from the triggers, not from the 999s the shared rows carried; the
    // dangling notebook reference was unfiled; the orphan link was skipped.
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
    // The copy wrote the directory row itself: frozen from its start, and now finished.
    const dir = await env.DB.prepare(`SELECT migrated_at, copied_at FROM account_directory WHERE user_id = ?1`).bind(userId).first<{ migrated_at: number | null; copied_at: number | null }>();
    expect(dir).toEqual({ migrated_at: expect.any(Number), copied_at: expect.any(Number) });

    // A second call copies nothing, and so does one after an eviction: the flag stands.
    expect(await stub.copyFromD1()).toMatchObject({ status: 'already' });
    await evictDurableObject(stub);
    const again = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect(await again.copyFromD1()).toMatchObject({ status: 'already' });
    expect((await again.stats()).counts.notes).toBe(30);
    expect(await metaKeys(again)).toEqual(['migrated_from_d1', 'user_id']);
  });

  it('marks an account with nothing in D1 done', async () => {
    const { stub } = freshStore('empty');
    expect(await stub.copyFromD1()).toMatchObject({ status: 'done', copied: {}, usage: { notes: 0, migratedFromD1: true } });
    expect(await stub.stats()).toMatchObject({ migratedFromD1: true });
  });

  /**
   * D1 queries count against an invocation's subrequests, fifty on Free, so a call
   * spends a budget and then answers `paused` with its progress committed. The budget is
   * an option for this test; the Worker never passes one.
   */
  it('pauses at its query budget and continues from the last committed page on the next call', async () => {
    const { userId, stub } = freshStore('budget');
    await seedD1(userId, 12);
    // A budget of thirteen: nine are reserved for the verification's counts and the
    // directory write, so each call fetches three pages of the sixteen the eight tables
    // take (a page of rows and the empty page after it) before it pauses.
    const statuses: string[] = [];
    for (let calls = 0; calls < 12; calls++) {
      const result = await stub.copyFromD1({ budget: 13 });
      statuses.push(result.status);
      if (result.status === 'done') {
        expect(result.resumed).toBe(true);
        expect(result.copied).toMatchObject({ notes: 12, note_tags: 12, note_fields: 6, attachments: 12, attachment_text: 12 });
        break;
      }
      expect(result).toMatchObject({ status: 'paused', at: expect.stringMatching(/^\w+:\d+$/) });
      // Frozen from the first call, before the copy is anywhere near done — a write to
      // the account's D1 rows from now on is refused rather than missed — and not yet
      // recorded as copied, which is the column that means done.
      const dir = await env.DB.prepare(`SELECT migrated_at, copied_at FROM account_directory WHERE user_id = ?1`).bind(userId).first<{ migrated_at: number | null; copied_at: number | null }>();
      expect(dir).toEqual({ migrated_at: expect.any(Number), copied_at: null });
      // Nothing copied yet is lost across a pause, or across an eviction in between.
      if (calls === 2) await evictDurableObject(stub);
    }
    expect(statuses.filter((s) => s === 'paused').length).toBeGreaterThan(3);
    expect(statuses[statuses.length - 1]).toBe('done');
    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect(await woke.recountNotes()).toBe(0);
    expect(await metaKeys(woke)).toEqual(['migrated_from_d1', 'user_id']);
  });

  /**
   * Between the deploy and the sweep an account not yet copied opens empty, and its
   * owner may write — a note, with their usual tag, in their usual notebook. The copy
   * counts what it lands rather than comparing table totals, so the note is neither a
   * mismatch nor lost; and the tag and notebook D1 then delivers under the same names
   * are merged into the ones already here, with every D1 row that pointed at them
   * rewritten, rather than refused.
   */
  it('keeps a note written before the copy ran, merging its tag and notebook with what D1 delivers', async () => {
    const { userId, stub } = freshStore('window');
    await seedD1(userId, 6);
    const receipts = await stub.createNotebook('receipts'); // D1 has 'Receipts': the same notebook to the store
    const mine = await stub.create({ id: crypto.randomUUID(), title: 'Written first', body: 'before the copy', tags: ['home'], notebook: 'receipts' });
    expect(await stub.copyFromD1()).toMatchObject({
      status: 'done',
      copied: { notebooks: 1, tags: 1, notes: 6, note_tags: 6, notebook_fields: 1 },
      merged: 2,
      usage: { notes: 7 },
    });
    expect((await stub.get(mine.id))).toMatchObject({ title: 'Written first', tags: ['home'], notebook: 'receipts' });
    // Live notes only: the seed trashes the first, which is the only 'work' one but this.
    expect((await stub.listTags()).map((t) => [t.name, t.count])).toEqual([['home', 5], ['work', 1]]);
    const notebooks = await stub.listNotebooks();
    expect(notebooks.map((n) => [n.name, n.fields])).toEqual([['receipts', 1], ['Recipes', 0]]);
    // The D1 notes filed in 'Receipts' — the odd ones, less the last, which the seed
    // files nowhere — are in the merged notebook with the one written first.
    expect(notebooks.find((n) => n.name === 'receipts')!.count).toBe(1 + 2);
    expect((await stub.get(`${userId}-n0001`))).toMatchObject({ notebook: 'receipts', fields: [expect.objectContaining({ name: 'Amount', value: 1 })] });
    expect(await stub.recountNotes()).toBe(0);
  });

  /**
   * A mismatch: two files on one note under the same filename, which the store's
   * `UNIQUE(note_id, filename)` refuses and nothing here can merge. The copy says so and
   * stops; the account keeps working on what it has; nothing reads D1 again until the
   * operator, having fixed the rows, asks for a retry.
   */
  it('reports a mismatch it cannot mend, and retries only when asked', async () => {
    const { userId, stub } = freshStore('mismatch');
    await seedD1(userId, 3);
    await env.DB.prepare(`INSERT INTO attachments (id, note_id, user_id, filename, content_type, size, r2_key, created_at) VALUES (?1, ?2, ?3, 'scan.pdf', 'application/pdf', 1, 'k', 1)`).bind(`${userId}-dup`, `${userId}-n0001`, userId).run();

    const first = await stub.copyFromD1();
    expect(first).toMatchObject({ status: 'mismatch', reason: expect.stringMatching(/^attachments: 3 of 4 rows landed/) });
    // Recorded, not marked, and the `migrated_at` the copy wrote before its first page
    // is cleared again, so the account's D1 rows are writable for the operator.
    expect(await stub.stats()).toMatchObject({ migratedFromD1: false, copyMismatch: (first as { reason: string }).reason });
    const dir = await env.DB.prepare(`SELECT migrated_at, copied_at FROM account_directory WHERE user_id = ?1`).bind(userId).first<{ migrated_at: number | null; copied_at: number | null }>();
    expect(dir).toEqual({ migrated_at: null, copied_at: null });
    // The account is not refused anything: what landed is there to use.
    expect((await stub.list({ limit: 5 })).length).toBe(2); // the third is in the trash
    // Asked again without `retry`, the answer is the record, with no query spent.
    expect(await stub.copyFromD1()).toMatchObject({ status: 'mismatch', reason: (first as { reason: string }).reason, queries: 0 });

    // The operator fixes D1 and retries: the rescan fetches the mended row, ignores the
    // rows already here, and verifies.
    await env.DB.prepare(`UPDATE attachments SET filename = 'scan (2).pdf' WHERE id = ?1`).bind(`${userId}-dup`).run();
    expect(await stub.copyFromD1()).toMatchObject({ status: 'mismatch' });
    const retried = await stub.copyFromD1({ retry: true });
    expect(retried).toMatchObject({ status: 'done', copied: { attachments: 4, notes: 3 }, usage: { migratedFromD1: true } });
    expect((await stub.listAttachments(`${userId}-n0001`)).map((a) => a.filename)).toEqual(['scan.pdf', 'scan (2).pdf']);
    expect(await stub.stats()).toMatchObject({ migratedFromD1: true, copyMismatch: null });
    expect(await metaKeys(stub)).toEqual(['migrated_from_d1', 'user_id']);
  });

  /**
   * Found in review: `wipe` set its flag in memory only, so a wiped object copied its
   * account back from D1 on its next wake after eviction — a deletion that failed after
   * the wipe would have brought the account back as it was at the cutover, with its files
   * already gone from R2. The marker in the object's key-value storage is what stops it,
   * and a wiped object answers the copy with `already` rather than running it.
   */
  it('stays empty after a wipe and an eviction while D1 still holds the rows', async () => {
    const { userId, stub } = freshStore('wiped');
    await seedD1(userId, 5);
    expect(await stub.copyFromD1()).toMatchObject({ status: 'done' });
    expect((await stub.stats()).counts.notes).toBe(5);
    await stub.wipe();
    await evictDurableObject(stub);

    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    const stats = await woke.stats();
    expect(stats).toMatchObject({ wiped: true, migratedFromD1: true });
    expect(stats.counts.notes).toBe(0);
    expect(await woke.copyFromD1()).toMatchObject({ status: 'already', usage: { wiped: true } });
    // And asking did not rebuild it: it is still empty storage.
    expect((await woke.stats()).wiped).toBe(true);
    // Asked for its notes, it starts as a brand-new empty account rather than copying.
    await woke.create({ id: crypto.randomUUID(), title: 'Fresh start', body: '', tags: [] });
    expect((await woke.stats()).counts).toMatchObject({ notes: 1, attachments: 0 });
    await evictDurableObject(woke);
    expect((await env.USER_STORE.get(env.USER_STORE.idFromName(userId)).stats()).counts.notes).toBe(1);
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
    // The probe, the freeze, fourteen pages for the other tables (a page and the empty
    // one after it, for seven of them), three for the texts — the first two, since the
    // cut is by the rows before the next, then the third, then the empty one — eight
    // counts and the copied mark: twenty-eight queries.
    expect(await stub.copyFromD1()).toMatchObject({ status: 'done', queries: 1 + 1 + 14 + 3 + 8 + 1 });
    expect((await stub.stats()).counts.attachment_text).toBe(3);
    expect((await stub.textFor(`${userId}-n0002`, 'scan.pdf'))?.length).toBe(big.length);
  });
});
