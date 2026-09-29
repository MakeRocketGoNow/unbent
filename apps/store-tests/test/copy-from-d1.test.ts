import { beforeAll, describe, expect, it } from 'vitest';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { freshStore } from './helpers.js';

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

const D1_SCHEMA = `
CREATE TABLE IF NOT EXISTS notebooks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, purpose TEXT, emoji TEXT, note_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS notebook_fields (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, notebook_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, options TEXT, position INTEGER NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER, notebook_name TEXT, scale_max INTEGER, scale_step REAL, currency TEXT);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, note_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, source_enex TEXT, content_hash TEXT, notebook_id TEXT);
CREATE TABLE IF NOT EXISTS note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (note_id, tag_id));
CREATE TABLE IF NOT EXISTS note_fields (note_id TEXT NOT NULL, field_id TEXT NOT NULL, user_id TEXT NOT NULL, value_text TEXT NOT NULL, value_num REAL, PRIMARY KEY (note_id, field_id));
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, user_id TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, md5 TEXT, r2_key TEXT NOT NULL, created_at INTEGER NOT NULL, has_text INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS attachment_text (attachment_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, user_id TEXT NOT NULL, filename TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, read_by TEXT);
`;

/** Fills D1 for `user`: `notes` notes across two notebooks, tagged, valued, with a scan each. */
async function seedD1(user: string, notes: number) {
  const stmts: D1PreparedStatement[] = [];
  const p = (sql: string, ...binds: unknown[]) => stmts.push(env.DB.prepare(sql).bind(...binds));
  p(`INSERT INTO notebooks VALUES (?1, ?2, 'Receipts', 1, 'Bills', '🧾', 999)`, `${user}-nb1`, user);
  p(`INSERT INTO notebooks VALUES (?1, ?2, 'Recipes', 1, NULL, NULL, 999)`, `${user}-nb2`, user);
  p(`INSERT INTO notebook_fields (id, user_id, notebook_id, name, type, position, created_at) VALUES (?1, ?2, ?3, 'Amount', 'number', 0, 1)`, `${user}-f1`, user, `${user}-nb1`);
  p(`INSERT INTO tags VALUES (?1, ?2, 'home', 999)`, `${user}-t1`, user);
  p(`INSERT INTO tags VALUES (?1, ?2, 'work', 999)`, `${user}-t2`, user);
  for (let i = 0; i < notes; i++) {
    const id = `${user}-n${String(i).padStart(4, '0')}`;
    // The last note points at a notebook the shared database no longer has.
    const nb = i === notes - 1 ? 'gone' : i % 2 ? `${user}-nb1` : `${user}-nb2`;
    p(`INSERT INTO notes (id, user_id, title, body, created_at, updated_at, deleted_at, content_hash, notebook_id) VALUES (?1, ?2, ?3, 'acme receipt', ?4, ?4, ?5, ?6, ?7)`, id, user, `Note ${i}`, 1000 + i, i % 7 === 0 ? 5 : null, `h${i}`, nb);
    p(`INSERT INTO note_tags VALUES (?1, ?2)`, id, i % 3 ? `${user}-t1` : `${user}-t2`);
    if (i % 2) p(`INSERT INTO note_fields VALUES (?1, ?2, ?3, ?4, ?4)`, id, `${user}-f1`, user, String(i));
    p(`INSERT INTO attachments (id, note_id, user_id, filename, content_type, size, r2_key, created_at, has_text) VALUES (?1, ?2, ?3, 'scan.pdf', 'application/pdf', 1, ?4, 1, 1)`, `${user}-a${i}`, id, user, `users/${user}/notes/${id}/files/a-scan.pdf`);
    p(`INSERT INTO attachment_text VALUES (?1, ?2, ?3, 'scan.pdf', ?4, 1, NULL)`, `${user}-a${i}`, id, user, `invoice ${i} from globex`);
  }
  // A link whose note is gone, which the shared database's cascade may have missed.
  p(`INSERT INTO note_tags VALUES ('nowhere', ?1)`, `${user}-t1`);
  // Another user's rows, which must not come across.
  p(`INSERT INTO notes (id, user_id, title, body, created_at, updated_at) VALUES (?1, 'someone-else', 'Theirs', 'x', 1, 1)`, `${user}-other`);
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

beforeAll(async () => {
  await env.DB.exec(D1_SCHEMA.trim().split('\n').join(' '));
});

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
});
