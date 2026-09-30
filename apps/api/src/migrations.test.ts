/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { copyQueries } from './store/copy-from-d1.js';

/**
 * The D1 migrations, applied in order to a real SQLite by the `sqlite3` CLI, and then the
 * one thing about them no other suite can see: what the freeze in 0032 refuses and what
 * it lets through. The live suite's accounts are created after the cutover and have no
 * rows in these tables, and the store tests build D1 by hand without its triggers or
 * foreign keys — which is exactly how 0031 shipped refusing every account deletion
 * (found in review: a `user` delete cascades through UPDATEs, not only deletes, and the
 * update triggers refused them).
 *
 * Skipped where the CLI is not installed; CI's runners and every developer Mac have it.
 * The schema is a real one to the CLI, so `trusted_schema` is switched on for the FTS
 * triggers it would otherwise call unsafe.
 */

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');
let sqlite3: string | null = 'sqlite3';
try {
  execFileSync(sqlite3, ['--version'], { stdio: 'ignore' });
} catch {
  sqlite3 = null;
}

function db(file: string) {
  const run = (sql: string) =>
    execFileSync(sqlite3!, ['-cmd', 'PRAGMA trusted_schema=ON', '-cmd', 'PRAGMA foreign_keys=ON', '-bail', file], {
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const refused = (sql: string): string | null => {
    try {
      run(sql);
      return null;
    } catch (err) {
      return String((err as { stderr?: string }).stderr ?? err);
    }
  };
  return { run, refused };
}

function migration(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

describe.skipIf(!sqlite3)('the D1 migrations', () => {
  let file: string;
  beforeAll(() => {
    file = join(mkdtempSync(join(tmpdir(), 'unbent-migrations-')), 'd1.sqlite');
  });

  it('apply in order to a real SQLite', () => {
    const { run } = db(file);
    for (const f of files) run(migration(f));
    expect(run(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%frozen%'`)).toBe('16');
  });

  /**
   * The copy from D1 pages every table by user and rowid, and before 0034 the planner
   * answered most of those with every row of the account and a sort, per page, and two
   * of them with a walk over every account (found in review). The plans are the promise,
   * so they are pinned against the real migrations: every page leads with a range seek on
   * an index by user and rowid, no sort, no table scan, and no scan for a count or for
   * the row check.
   *
   * And the other half of the promise, found in the next review: the indexes 0034 added
   * for the copy were plain `user_id` indexes, which `main`'s own statements — served from
   * this database by dev until the cutover merges, by production while a deploy drains,
   * and by a rolled-back Worker — then picked over their narrow ones, so a file lookup by
   * note read every file of the account. 0035 makes them expression indexes only the
   * copy's spelling matches. The three statements below are `main`'s, as written in
   * `lib/attachments-repo.ts` and `lib/notes-repo.ts` there, and each must keep the index
   * it had.
   */
  it('serve the copy from D1 by index, and leave main\'s statements their own indexes', () => {
    const { run } = db(file);
    const { tables, anyRows } = copyQueries();
    for (const q of tables) {
      const page = run(`EXPLAIN QUERY PLAN ${q.page}`);
      expect(page, `${q.table} page: ${page}`).toMatch(/SEARCH \w+ USING (COVERING )?INDEX \S+ \((<expr>|user_id)=\? AND rowid>\?/);
      expect(page, `${q.table} page: ${page}`).not.toMatch(/TEMP B-TREE|SCAN [a-z_]+/);
      const count = run(`EXPLAIN QUERY PLAN ${q.count}`);
      expect(count, `${q.table} count: ${count}`).not.toMatch(/SCAN [a-z_]+/);
    }
    expect(run(`EXPLAIN QUERY PLAN ${anyRows}`)).not.toMatch(/SCAN [a-z_]+/);

    for (const [sql, index] of [
      [`SELECT filename FROM attachments WHERE note_id = ?1 AND user_id = ?2`, 'idx_attachments_note'],
      [`SELECT a.filename FROM attachments a JOIN notes n ON n.id = a.note_id WHERE a.note_id = ?1 AND a.user_id = ?2 AND n.user_id = ?2`, 'idx_attachments_note'],
      [`SELECT id FROM notes WHERE user_id = ?1 AND content_hash = ?2 AND deleted_at IS NULL`, 'idx_notes_user_hash'],
    ] as const) {
      const plan = run(`EXPLAIN QUERY PLAN ${sql}`);
      expect(plan, `${sql}: ${plan}`).toContain(index);
      expect(plan, `${sql}: ${plan}`).not.toContain('_copy');
    }
  });

  it('freeze a migrated account\'s rows, leave an unmigrated one\'s alone, and still let a user be deleted', () => {
    const { run, refused } = db(file);
    // Seeded as the shared database held accounts at the cutover: filed notes with a tag
    // and a read file. One account's store has its copy (`migrated_at`), one's has not.
    // The triggers ignore rows whose account is not migrated, which is what lets these
    // inserts land at all after the migrations above ran.
    run(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('m', 'M', 'm@example.test', 0, 'n', 'n'), ('f', 'F', 'f@example.test', 0, 'n', 'n');
      INSERT INTO account_directory (user_id, created_at, migrated_at) VALUES ('m', 1, NULL), ('f', 1, NULL);
      INSERT INTO notebooks (id, user_id, name, created_at) VALUES ('nbm', 'm', 'Taxes', 1), ('nbf', 'f', 'Taxes', 1);
      INSERT INTO tags (id, user_id, name) VALUES ('tm', 'm', 'home'), ('tf', 'f', 'home');
      INSERT INTO notes (id, user_id, title, body, created_at, updated_at, notebook_id) VALUES ('nm', 'm', 't', 'b', 1, 1, 'nbm'), ('nf', 'f', 't', 'b', 1, 1, 'nbf');
      INSERT INTO note_tags VALUES ('nm', 'tm'), ('nf', 'tf');
      INSERT INTO attachments (id, note_id, user_id, filename, content_type, size, r2_key, created_at) VALUES ('am', 'nm', 'm', 'f.pdf', 'application/pdf', 1, 'k', 1), ('af', 'nf', 'f', 'f.pdf', 'application/pdf', 1, 'k', 1);
      INSERT INTO attachment_text (attachment_id, note_id, user_id, filename, text, created_at) VALUES ('am', 'nm', 'm', 'f.pdf', 'hello', 1), ('af', 'nf', 'f', 'f.pdf', 'hello', 1);
      UPDATE account_directory SET migrated_at = 2 WHERE user_id = 'm';
    `);

    // Migrated: every kind of write is refused, with the reason.
    for (const sql of [
      `UPDATE notes SET title = 'x' WHERE id = 'nm'`,
      `INSERT INTO notes (id, user_id, title, body, created_at, updated_at) VALUES ('nm2', 'm', 't', 'b', 1, 1)`,
      `INSERT INTO note_tags VALUES ('nm', 'tf')`,
      `UPDATE attachment_text SET text = 'changed' WHERE attachment_id = 'am'`,
      `UPDATE notebooks SET name = 'Renamed' WHERE id = 'nbm'`,
    ]) {
      expect(refused(sql), sql).toMatch(/notes moved to the per-account store/);
    }

    // Not migrated: writes land, since D1 is still this account's truth.
    run(`UPDATE notes SET title = 'x' WHERE id = 'nf'; INSERT INTO notes (id, user_id, title, body, created_at, updated_at) VALUES ('nf2', 'f', 't', 'b', 1, 1); INSERT INTO note_tags VALUES ('nf2', 'tf');`);
    expect(run(`SELECT COUNT(*) FROM notes WHERE user_id = 'f'`)).toBe('2');

    // Deleting the migrated user cascades through the frozen tables: the FK's SET NULL on
    // notes, the count triggers' updates on notebooks and note_counts, has_text on
    // attachments — all updates the triggers would refuse while the user row existed.
    run(`DELETE FROM user WHERE id = 'm'`);
    expect(run(`SELECT COUNT(*) FROM notes WHERE user_id = 'm'`)).toBe('0');
    expect(run(`SELECT COUNT(*) FROM attachments WHERE user_id = 'm'`)).toBe('0');
    expect(run(`SELECT COUNT(*) FROM attachment_text WHERE user_id = 'm'`)).toBe('0');
    expect(run(`SELECT COUNT(*) FROM notebooks WHERE user_id = 'm'`)).toBe('0');
    expect(run(`SELECT COUNT(*) FROM note_tags WHERE note_id = 'nm'`)).toBe('0');
    // The directory row has no foreign key to `user`, and outlives it on purpose.
    expect(run(`SELECT COUNT(*) FROM account_directory WHERE user_id = 'm'`)).toBe('1');
  });

  it('are undone by the unfreeze script, for a rollback', () => {
    const { run } = db(file);
    run(readFileSync(join(import.meta.dirname, '..', 'scripts', 'unfreeze-note-tables.sql'), 'utf8'));
    expect(run(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%frozen%'`)).toBe('0');
    run(`UPDATE account_directory SET migrated_at = 2 WHERE user_id = 'f'; UPDATE notes SET title = 'writable again' WHERE id = 'nf'`);
    expect(run(`SELECT title FROM notes WHERE id = 'nf'`)).toBe('writable again');
  });
});
