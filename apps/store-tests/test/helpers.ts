import { env } from 'cloudflare:test';

/**
 * A stub for a store nothing else in the run has touched.
 *
 * Every test takes its store from here rather than naming one, because the plugin's
 * storage isolation does not reach SQLite-backed objects: a store written by one test is
 * still full in the next, whatever the config says (measured 2026-09-29). A random name
 * per call is the isolation, and it is a helper rather than a convention so a new test
 * cannot forget it.
 *
 * The name is what the object takes to be its user id, so it is also what its
 * `_meta.user_id` row will say.
 */
export function freshStore(label = 'test') {
  const userId = `${label}-${crypto.randomUUID()}`;
  return { userId, stub: env.USER_STORE.get(env.USER_STORE.idFromName(userId)) };
}

/**
 * The shared database's note tables, in the shape migrations 0003–0030 left them — `user_id`
 * on every row, counts on the notebook and tag rows, the account directory — for the tests
 * that seed an account in D1 and watch its object copy it. The test environment's D1 is
 * empty, so a test file creates these itself. Each file's D1 is its own; every test's rows
 * are keyed by a fresh user id anyway.
 */
export const D1_SCHEMA = `
CREATE TABLE IF NOT EXISTS notebooks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, purpose TEXT, emoji TEXT, note_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS notebook_fields (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, notebook_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, options TEXT, position INTEGER NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER, notebook_name TEXT, scale_max INTEGER, scale_step REAL, currency TEXT);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, note_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, source_enex TEXT, content_hash TEXT, notebook_id TEXT);
CREATE TABLE IF NOT EXISTS note_tags (note_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (note_id, tag_id));
CREATE TABLE IF NOT EXISTS note_fields (note_id TEXT NOT NULL, field_id TEXT NOT NULL, user_id TEXT NOT NULL, value_text TEXT NOT NULL, value_num REAL, PRIMARY KEY (note_id, field_id));
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, note_id TEXT NOT NULL, user_id TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, md5 TEXT, r2_key TEXT NOT NULL, created_at INTEGER NOT NULL, has_text INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS attachment_text (attachment_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, user_id TEXT NOT NULL, filename TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, read_by TEXT);
CREATE TABLE IF NOT EXISTS account_directory (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, migrated_at INTEGER, storage_bytes INTEGER NOT NULL DEFAULT 0, note_count INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER, deleted_at INTEGER, copied_at INTEGER);
`;


export async function createD1NoteTables() {
  await env.DB.exec(D1_SCHEMA.trim().split('\n').join(' '));
}

/** Fills the shared tables for `user`: `notes` notes across two notebooks, tagged, valued, with a scan each. */
export async function seedD1(user: string, notes: number) {
  const stmts: D1PreparedStatement[] = [];
  const p = (sql: string, ...binds: unknown[]) => stmts.push(env.DB.prepare(sql).bind(...binds));
  p(`INSERT INTO account_directory (user_id, created_at) VALUES (?1, 1)`, user);
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

