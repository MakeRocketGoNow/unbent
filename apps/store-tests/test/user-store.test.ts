import { describe, expect, it } from 'vitest';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { Sql } from '@unbent/api/store/sql';
import { isRestoreUnsupported, readRestoreRefusal } from '@unbent/api/store/restore';
import { DUMP_TABLES } from '@unbent/api/store/tables';
import { freshStore } from './helpers.js';

/**
 * The object's lifecycle: what the constructor guarantees on every wake, and the operator
 * surface that everything else — the sweep, the dump, account deletion — is built on.
 * Runs against the real runtime; see vitest.config.ts for why.
 */
describe('UserStore lifecycle', () => {
  it('migrates on first wake, knows its user, and applies nothing on the second', async () => {
    const { userId, stub } = freshStore('wake');
    expect(await stub.ping()).toEqual({ userId });

    const stats = await stub.stats();
    expect(stats.userId).toBe(userId);
    expect(stats.migrations).toEqual(['0001-init', '0002-changes', '0003-revisions', '0004-revision-props', '0005-deleted-blobs']);
    expect(stats.counts.notes).toBe(0);

    // A second wake of the same object applies nothing and reads the same schema. The
    // `_meta.user_id` row written on the first wake is what a mismatch is checked against.
    await evictDurableObject(stub);
    const again = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect((await again.stats()).migrations).toEqual(['0001-init', '0002-changes', '0003-revisions', '0004-revision-props', '0005-deleted-blobs']);
    const meta = await runInDurableObject(again, (_i, state) =>
      state.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'user_id'`).toArray(),
    );
    expect(meta).toEqual([{ value: userId }]);
  });

  it('applies a schema file that arrived after the object was in use, on its next wake', async () => {
    const { userId, stub } = freshStore('later-file');
    await stub.ping();
    // Put the object back where one that was created under 0001 alone would be: the feed
    // table gone, no record of 0002, the counter and epoch rows never written, with a
    // note already in it. What 0002 has to tolerate is exactly this.
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('n1', 'T', 'b', 1, 1)`);
      sql.exec(`DROP TABLE changes`);
      // And every file after it, or the object would hold a later file without an earlier
      // one, which no object can.
      sql.exec(`DROP TABLE note_revisions`);
      sql.exec(`DROP TABLE deleted_blobs`);
      sql.exec(`DELETE FROM _migrations WHERE name IN ('0002-changes', '0003-revisions', '0004-revision-props', '0005-deleted-blobs')`);
      sql.exec(`DELETE FROM _meta WHERE key IN ('seq', 'feed_epoch')`);
    });
    await evictDurableObject(stub);
    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    const stats = await woke.stats();
    expect(stats.migrations).toEqual(['0001-init', '0002-changes', '0003-revisions', '0004-revision-props', '0005-deleted-blobs']);
    expect(stats.counts.notes).toBe(1);
    expect(stats.counts.changes).toBe(0);
    const meta = await runInDurableObject(woke, (_i, state) =>
      state.storage.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM _meta WHERE key IN ('seq', 'feed_epoch') ORDER BY key`).toArray(),
    );
    expect(meta).toEqual([
      { key: 'feed_epoch', value: expect.stringMatching(/^[0-9a-f]{32}$/) },
      { key: 'seq', value: '0' },
    ]);
  });

  it('gives a store in use under 0002 its history table, and the next save keeps a copy', async () => {
    const { userId, stub } = freshStore('history-file');
    const note = await stub.create({ id: crypto.randomUUID(), title: 'T', body: 'before', tags: [] });
    // As production's objects are when 0003 reaches them: notes and a feed, no history.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`DROP TABLE note_revisions`);
      state.storage.sql.exec(`DROP TABLE deleted_blobs`);
      state.storage.sql.exec(`DELETE FROM _migrations WHERE name IN ('0003-revisions', '0004-revision-props', '0005-deleted-blobs')`);
    });
    await evictDurableObject(stub);
    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect(await woke.listRevisions(note.id)).toEqual([]);
    await woke.update(note.id, { body: 'after' });
    expect(await woke.listRevisions(note.id)).toEqual([expect.objectContaining({ title: 'T', size: 6 })]);
    expect((await woke.stats()).counts.note_revisions).toBe(1);
  });

  it('gives a store in use under 0003 the columns for what a version holds, and reads its old copies as not recorded', async () => {
    const { userId, stub } = freshStore('history-props-file');
    const note = await stub.create({ id: crypto.randomUUID(), title: 'T', body: 'before', tags: ['kept'] });
    await stub.update(note.id, { body: 'after' });
    // As production's objects are when 0004 reaches them: copies with a title and a body
    // and nothing else. The columns go and come back; the row is one 0003 would have made.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`ALTER TABLE note_revisions DROP COLUMN props`);
      state.storage.sql.exec(`ALTER TABLE note_revisions DROP COLUMN changed`);
      state.storage.sql.exec(`DROP TABLE deleted_blobs`);
      state.storage.sql.exec(`DELETE FROM _migrations WHERE name IN ('0004-revision-props', '0005-deleted-blobs')`);
    });
    await evictDurableObject(stub);
    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    const [old] = (await woke.listRevisions(note.id))!;
    expect(old).not.toHaveProperty('changed');
    const whole = (await woke.getRevision(note.id, old!.id))!;
    expect(whole.body).toBe('before');
    // Not recorded, which is not "had no tags": restoring it leaves the note's alone.
    expect(whole).not.toHaveProperty('props');
    await woke.update(note.id, { tags: ['kept', 'added since'] });
    const restored = await woke.restoreRevision(note.id, old!.id);
    expect(restored).toMatchObject({ note: { body: 'before', tags: ['added since', 'kept'] } });
    expect(restored).not.toHaveProperty('skipped');
  });

  it('enforces foreign keys, so a purged note takes its files, text, tags and values with it', async () => {
    const { stub } = freshStore('fk');
    const fk = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec<{ foreign_keys: number }>('PRAGMA foreign_keys').toArray(),
    );
    expect(fk).toEqual([{ foreign_keys: 1 }]);

    const after = await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO notebooks (id, name, created_at) VALUES ('nb', 'Receipts', 1)`);
      sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at, notebook_id) VALUES ('n1', 'T', 'b', 1, 1, 'nb')`);
      sql.exec(`INSERT INTO tags (id, name) VALUES ('t', 'home')`);
      sql.exec(`INSERT INTO note_tags (note_id, tag_id) VALUES ('n1', 't')`);
      sql.exec(`INSERT INTO notebook_fields (id, notebook_id, name, type, position, created_at) VALUES ('f', 'nb', 'Amount', 'number', 0, 1)`);
      sql.exec(`INSERT INTO note_fields (note_id, field_id, value_text, value_num) VALUES ('n1', 'f', '12', 12)`);
      sql.exec(`INSERT INTO attachments (id, note_id, filename, content_type, size, r2_key, created_at) VALUES ('a', 'n1', 'scan.pdf', 'application/pdf', 1, 'k', 1)`);
      sql.exec(`INSERT INTO attachment_text (attachment_id, note_id, filename, text, created_at) VALUES ('a', 'n1', 'scan.pdf', 'acme invoice', 1)`);
      sql.exec(`DELETE FROM notes WHERE id = 'n1'`);
      const count = (t: string) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).toArray()[0]?.n;
      return {
        note_tags: count('note_tags'),
        note_fields: count('note_fields'),
        attachments: count('attachments'),
        attachment_text: count('attachment_text'),
        fts: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM attachment_text_fts WHERE attachment_text_fts MATCH 'acme'`).toArray()[0]?.n,
        counts: sql.exec('SELECT live, unfiled, trashed FROM note_counts').toArray(),
        notebook: sql.exec('SELECT note_count FROM notebooks').toArray(),
        tag: sql.exec('SELECT note_count FROM tags').toArray(),
      };
    });
    expect(after).toEqual({
      note_tags: 0,
      note_fields: 0,
      attachments: 0,
      attachment_text: 0,
      fts: 0,
      counts: [{ live: 0, unfiled: 0, trashed: 0 }],
      notebook: [{ note_count: 0 }],
      tag: [{ note_count: 0 }],
    });
  });

  it('refuses an object whose database belongs to another user', async () => {
    const { stub } = freshStore('mismatch');
    await stub.ping();
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE _meta SET value = 'someone-else' WHERE key = 'user_id'`);
    });
    await evictDurableObject(stub);
    await expect(stub.ping()).rejects.toThrow(/belongs to another user/);
  });

  it('readOnlySql returns rows and cannot commit a write', async () => {
    const { stub } = freshStore('readonly');
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('n1', 'T', 'b', 1, 1)`);
    });
    const read = await stub.readOnlySql('SELECT id, title FROM notes WHERE id = ?1', ['n1']);
    expect(read.rows).toEqual([{ id: 'n1', title: 'T' }]);
    expect(read.truncated).toBe(false);

    // A write is refused by the prefix check; a write smuggled past it is rolled back.
    await expect(stub.readOnlySql('DELETE FROM notes')).rejects.toThrow(/SELECT, WITH or EXPLAIN/);
    await expect(
      stub.readOnlySql(`WITH x AS (SELECT 1) DELETE FROM notes`),
    ).rejects.toThrow();
    expect((await stub.stats()).counts.notes).toBe(1);
  });

  it('wipe empties the object, stats says so, and the next data call rebuilds the schema', async () => {
    const { userId, stub } = freshStore('wipe');
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('n1', 'T', 'b', 1, 1)`);
    });
    await stub.wipe();
    const wiped = await stub.stats();
    expect(wiped.wiped).toBe(true);
    expect(wiped.counts.notes).toBe(0);
    expect(wiped.migrations).toEqual([]);

    // Reached again on the same instance: schema back, still this user's, empty.
    expect(await stub.schemaSql()).toEqual(expect.arrayContaining([expect.stringContaining('CREATE TABLE notes')]));
    const rebuilt = await stub.stats();
    expect(rebuilt).toMatchObject({ userId, wiped: false, migrations: ['0001-init', '0002-changes', '0003-revisions', '0004-revision-props', '0005-deleted-blobs'] });
    expect(rebuilt.counts.notes).toBe(0);

    // And after an eviction the object wakes as it was left — empty, no schema, and
    // never to copy its account back from D1 — until something asks for its notes.
    await stub.wipe();
    await evictDurableObject(stub);
    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect(await woke.stats()).toMatchObject({ wiped: true, migrations: [] });
    expect(await woke.schemaSql()).toEqual(expect.arrayContaining([expect.stringContaining('CREATE TABLE notes')]));
    expect(await woke.stats()).toMatchObject({ wiped: false, migrations: ['0001-init', '0002-changes', '0003-revisions', '0004-revision-props', '0005-deleted-blobs'] });
  });

  it('dumpPage pages a table by rowid and stops with a null cursor', async () => {
    const { stub } = freshStore('dump');
    await runInDurableObject(stub, (_i, state) => {
      for (let i = 0; i < 5; i++) {
        state.storage.sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES (?1, 'T', 'b', 1, 1)`, `n${i}`);
      }
    });
    // Pages come back as INSERT statements, one a line, already encoded; see `dumpPage`
    // for why the object formats and encodes them rather than the Worker.
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const ids = (bytes: Uint8Array) => [...text(bytes).matchAll(/^INSERT INTO notes \(id, .*VALUES \('(n\d)'/gm)].map((m) => m[1]);
    const first = await stub.dumpPage('notes', 0, 2);
    expect(first.rows).toBe(2);
    expect(ids(first.bytes)).toEqual(['n0', 'n1']);
    expect(text(first.bytes)).not.toContain('_rowid');
    expect(first.nextRowid).not.toBeNull();
    const second = await stub.dumpPage('notes', first.nextRowid!, 2);
    expect(ids(second.bytes)).toEqual(['n2', 'n3']);
    const third = await stub.dumpPage('notes', second.nextRowid!, 2);
    expect(ids(third.bytes)).toEqual(['n4']);
    expect(third.nextRowid).toBeNull();
    await expect(stub.dumpPage('notes_fts' as 'notes')).rejects.toThrow(/not a data table/);
  });

  /*
   * The dump pages the tables `DUMP_TABLES` names, not the ones the schema has, so a
   * schema file that adds a table and forgets the list would ship a dump that rebuilds a
   * store without it — silently, since a missing table is just one less `INSERT` run. Read
   * the schema the way the object holds it and hold the list to it. The search tables and
   * the shadows FTS5 keeps for each (`notes_fts_data`, `_idx`, …) are excluded by name
   * from what the schema says is virtual, not listed, so a new search table needs nothing
   * here; the dump rebuilds them from the data tables (`dumpChunks` in routes/admin.ts).
   */
  it('dumps every table the schema has but the search indexes', async () => {
    const { stub } = freshStore('dump-coverage');
    const tables = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`)
        .toArray(),
    );
    const virtual = tables.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql)).map((t) => t.name);
    expect(virtual.length).toBeGreaterThan(0);
    const real = tables
      .map((t) => t.name)
      // `sqlite_*` is SQLite's own and `_cf_*` the runtime's (where it keeps the object's
      // key-value storage); neither is the store's to dump.
      .filter((name) => !/^(sqlite_|_cf_)/.test(name))
      .filter((name) => !virtual.some((v) => name === v || name.startsWith(`${v}_`)));
    expect([...DUMP_TABLES].sort()).toEqual(real.sort());
  });

  it('readOnlySql stops reading at its byte budget rather than loading the result first', async () => {
    const { stub } = freshStore('readonlybytes');
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('n1', 'T', 'b', 1, 1)`);
      for (let i = 0; i < 4; i++) {
        sql.exec(`INSERT INTO attachments (id, note_id, filename, content_type, size, r2_key, created_at) VALUES (?1, 'n1', ?2, 'application/pdf', 1, ?1, 1)`, `a${i}`, `f${i}.pdf`);
        sql.exec(`INSERT INTO attachment_text (attachment_id, note_id, filename, text, created_at) VALUES (?1, 'n1', ?2, ?3, 1)`, `a${i}`, `f${i}.pdf`, 'x'.repeat(5 * 1024 * 1024));
      }
    });
    // Four texts of five megabytes: the first is kept, the second passes the budget and
    // stops the read there, and the rows behind it were never pulled off the cursor.
    const result = await stub.readOnlySql('SELECT attachment_id, text FROM attachment_text ORDER BY rowid');
    expect(result.rows.map((r) => r.attachment_id)).toEqual(['a0']);
    expect(result.truncated).toBe(true);
    expect(result.rowsRead).toBeLessThan(4);
    // The row cap works the same way, without a byte in sight.
    const capped = await stub.readOnlySql('SELECT attachment_id FROM attachment_text ORDER BY rowid', [], 2);
    expect(capped.rows.map((r) => r.attachment_id)).toEqual(['a0', 'a1']);
    expect(capped.truncated).toBe(true);
  });

  it('dumpPage cuts a page at its byte budget and keeps paging from the cut', async () => {
    const { stub } = freshStore('dumpbytes');
    // Three texts of five megabytes each: two fit the eight-megabyte budget only one at a
    // time, so a page of five hundred still hands back one row and a cursor.
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('n1', 'T', 'b', 1, 1)`);
      for (let i = 0; i < 3; i++) {
        sql.exec(`INSERT INTO attachments (id, note_id, filename, content_type, size, r2_key, created_at) VALUES (?1, 'n1', ?2, 'application/pdf', 1, ?1, 1)`, `a${i}`, `f${i}.pdf`);
        sql.exec(`INSERT INTO attachment_text (attachment_id, note_id, filename, text, created_at) VALUES (?1, 'n1', ?2, ?3, 1)`, `a${i}`, `f${i}.pdf`, 'x'.repeat(5 * 1024 * 1024));
      }
    });
    const ids = (bytes: Uint8Array) => [...new TextDecoder().decode(bytes).matchAll(/VALUES \('(a\d)'/g)].map((m) => m[1]);
    const first = await stub.dumpPage('attachment_text', 0, 500);
    expect(ids(first.bytes)).toEqual(['a0']);
    expect(first.nextRowid).not.toBeNull();
    const second = await stub.dumpPage('attachment_text', first.nextRowid!, 500);
    expect(ids(second.bytes)).toEqual(['a1']);
    const third = await stub.dumpPage('attachment_text', second.nextRowid!, 500);
    expect(ids(third.bytes)).toEqual(['a2']);
    expect(third.nextRowid).toBeNull();
  });

  it('nested transactions commit once and a throw unwinds all of it', async () => {
    const { stub } = freshStore('tx');
    const result = await runInDurableObject(stub, (instance: unknown) => {
      // Reach the seam the stores use, not the raw storage, so this proves the `tx` the
      // repos rely on: a public method calling another opens a nested transaction.
      const sql = (instance as { sql: Sql }).sql;
      sql.tx(() => {
        sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('outer', 'T', 'b', 1, 1)`);
        sql.tx(() => {
          sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('inner', 'T', 'b', 1, 1)`);
        });
      });
      try {
        sql.tx(() => {
          sql.exec(`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES ('lost', 'T', 'b', 1, 1)`);
          sql.tx(() => {
            throw new Error('boom');
          });
        });
      } catch {
        // expected
      }
      return sql.exec<{ id: string }>('SELECT id FROM notes ORDER BY id').map((r) => r.id);
    });
    expect(result).toEqual(['inner', 'outer']);
  });
});

/**
 * Point-in-time restore, as far as it can be tested here: not at all. Miniflare exposes
 * the bookmark methods but refuses every one that reads history — `getBookmarkForTime`
 * and `onNextSessionRestoreBookmark` both throw "does not implement point-in-time
 * recovery" (measured 2026-10-01, workerd under @cloudflare/vitest-plugin 1.3) — and
 * `getCurrentBookmark` answers all zeros. So the round trip, restoring and then undoing
 * with the bookmark the restore hands back, is verified on a deployed instance instead:
 * a preview of a PR that touches `src/store/` has stores of its own on the real runtime.
 *
 * What these pin is the local behaviour the route depends on: the refusal is the one
 * `isRestoreUnsupported` recognises, so `pnpm dev` answers 501 rather than a confusing
 * 400, and a refused restore leaves the store exactly as it was and still serving. If
 * Miniflare gains history, the first test fails, and that is the moment to replace both
 * with the real round trip.
 */
describe('UserStore point-in-time restore under Miniflare', () => {
  it('is refused as unsupported, for a time and for a bookmark', async () => {
    const { stub } = freshStore('restore');
    await stub.ping();
    const bookmark = '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b';
    for (const target of [{ at: Date.now() - 60_000 }, { bookmark }]) {
      const preview = await stub.restorePreview(target).then(
        () => null,
        (err: unknown) => err,
      );
      // A bookmark is passed through by the preview without asking the runtime.
      if ('at' in target) expect(isRestoreUnsupported(preview)).toBe(true);
      const restore = await stub.restoreTo(target).then(
        () => null,
        (err: unknown) => err,
      );
      expect(isRestoreUnsupported(restore)).toBe(true);
      // Marked as refused before scheduling, which is what lets the route say so.
      expect(readRestoreRefusal(restore)).not.toBeNull();
    }
  });

  it('leaves the store as it was when refused', async () => {
    const { userId, stub } = freshStore('restore-kept');
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`INSERT INTO tags (id, name) VALUES ('t', 'home')`);
    });
    await stub.restoreTo({ at: Date.now() - 60_000 }).catch(() => undefined);
    const again = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect((await again.stats()).counts.tags).toBe(1);
  });
});
