import { describe, expect, it } from 'vitest';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { Sql } from '@unbent/api/store/sql';
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
    expect(stats.migrations).toEqual(['0001-init']);
    expect(stats.counts.notes).toBe(0);

    // A second wake of the same object applies nothing and reads the same schema. The
    // `_meta.user_id` row written on the first wake is what a mismatch is checked against.
    await evictDurableObject(stub);
    const again = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect((await again.stats()).migrations).toEqual(['0001-init']);
    const meta = await runInDurableObject(again, (_i, state) =>
      state.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'user_id'`).toArray(),
    );
    expect(meta).toEqual([{ value: userId }]);
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
    expect(rebuilt).toMatchObject({ userId, wiped: false, migrations: ['0001-init'] });
    expect(rebuilt.counts.notes).toBe(0);

    // And after an eviction the object wakes as it was left — empty, no schema, and
    // never to copy its account back from D1 — until something asks for its notes.
    await stub.wipe();
    await evictDurableObject(stub);
    const woke = env.USER_STORE.get(env.USER_STORE.idFromName(userId));
    expect(await woke.stats()).toMatchObject({ wiped: true, migrations: [] });
    expect(await woke.schemaSql()).toEqual(expect.arrayContaining([expect.stringContaining('CREATE TABLE notes')]));
    expect(await woke.stats()).toMatchObject({ wiped: false, migrations: ['0001-init'] });
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
