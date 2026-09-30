/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The D1 migrations, applied in order to a real SQLite by the `sqlite3` CLI, and the one
 * thing about them no other suite can see: that 0036 refuses to drop the note tables
 * while any account with rows in them is not recorded as copied into its store. The live
 * suite's accounts have no rows in those tables, and the store tests never build them.
 *
 * Skipped where the CLI is not installed; CI's runners and every developer Mac have it.
 * The schema is a real one to the CLI, so `trusted_schema` is switched on for the FTS
 * triggers the older migrations carry, which it would otherwise call unsafe.
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
const DROP = '0036_drop_note_tables.sql';
const NOTE_TABLES = `('notes', 'notebooks', 'notebook_fields', 'tags', 'note_tags', 'note_fields', 'attachments', 'attachment_text', 'note_counts', 'notes_fts', 'tags_fts', 'note_fields_fts', 'attachment_text_fts')`;

describe.skipIf(!sqlite3)('the D1 migrations', () => {
  let file: string;
  beforeAll(() => {
    file = join(mkdtempSync(join(tmpdir(), 'unbent-migrations-')), 'd1.sqlite');
  });

  it('apply in order to a real SQLite, up to the drop', () => {
    const { run } = db(file);
    expect(files[files.length - 1]).toBe(DROP);
    for (const f of files) if (f !== DROP) run(migration(f));
    expect(run(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ${NOTE_TABLES}`)).toBe('13');
  });

  /**
   * Three accounts with rows: one with a directory row not marked copied, one with a user
   * row and notes but no directory row at all (the heal never reached it), and one with
   * no notes — an empty notebook with a field definition, and a tag — which a guard that
   * only looked at `notes` let through (found in review). Each refuses the drop, since a
   * dropped row that was never copied is the one loss here with no way back. Refused by
   * a CHECK, and everything is still there afterwards.
   */
  it('refuse to drop the note tables while an account with rows is not recorded as copied', () => {
    const { run, refused } = db(file);
    run(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('m', 'M', 'm@example.test', 0, 'n', 'n'), ('unlisted', 'U', 'u@example.test', 0, 'n', 'n'), ('noteless', 'N', 'x@example.test', 0, 'n', 'n');
      INSERT INTO account_directory (user_id, created_at) VALUES ('m', 1), ('noteless', 1);
      INSERT INTO notes (id, user_id, title, body, created_at, updated_at) VALUES ('n1', 'm', 't', 'b', 1, 1);
      INSERT INTO notes (id, user_id, title, body, created_at, updated_at) VALUES ('n2', 'unlisted', 't', 'b', 1, 1);
      INSERT INTO notebooks (id, user_id, name, created_at) VALUES ('nb', 'noteless', 'Empty', 1);
      INSERT INTO notebook_fields (id, user_id, notebook_id, name, type, position, created_at) VALUES ('f', 'noteless', 'nb', 'Amount', 'number', 0, 1);
      INSERT INTO tags (id, user_id, name) VALUES ('t', 'noteless', 'someday');
    `);
    expect(refused(migration(DROP))).toMatch(/CHECK constraint failed/);
    expect(run(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ${NOTE_TABLES}`)).toBe('13');

    // The listed account is copied; the unlisted one still has rows nobody copied.
    run(`UPDATE account_directory SET copied_at = 2 WHERE user_id = 'm'`);
    expect(refused(migration(DROP))).toMatch(/CHECK constraint failed/);
    // It too; the account with only a notebook and a tag still holds the drop.
    run(`INSERT INTO account_directory (user_id, created_at, copied_at) VALUES ('unlisted', 1, 2)`);
    expect(refused(migration(DROP))).toMatch(/CHECK constraint failed/);
    expect(run(`SELECT COUNT(*) FROM notes`)).toBe('2');
  });

  it('drop every note-plane object once every account with rows is copied, and nothing else', () => {
    const { run } = db(file);
    run(`UPDATE account_directory SET copied_at = 2 WHERE user_id = 'noteless'`);
    run(migration(DROP));
    // Tables, their triggers and indexes, the FTS shadow tables and the guard: all gone.
    expect(
      run(
        `SELECT COUNT(*) FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('attachment_uploads', 'attachment_uploads_user')
            AND (name LIKE '%note%' OR name LIKE '%attach%' OR name LIKE 'tags%' OR name LIKE '%fts%' OR name LIKE '%frozen%' OR name LIKE '%_copy' OR name = '_drop_guard')`,
      ),
    ).toBe('0');
    // The control plane is untouched, the directory's record included.
    for (const table of ['user', 'session', 'account', 'account_directory', 'attachment_uploads', '_unbent_meta']) {
      expect(run(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '${table}'`), table).toBe('1');
    }
    expect(run(`SELECT copied_at FROM account_directory WHERE user_id = 'm'`)).toBe('2');
  });
});
