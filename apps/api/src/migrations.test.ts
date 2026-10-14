/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DUMP_SQL, OPERATOR_PAGE_SQL } from './lib/directory.js';
import { LAPSE_DUE_SQL } from './lib/plan.js';
import { RESTORES_SQL } from './lib/restores.js';

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
/** The migrations either side of the drop: the ones that built the note tables, and the ones written since. */
const BEFORE = files.slice(0, files.indexOf(DROP));
const AFTER = files.slice(files.indexOf(DROP) + 1);
const NOTE_TABLES = `('notes', 'notebooks', 'notebook_fields', 'tags', 'note_tags', 'note_fields', 'attachments', 'attachment_text', 'note_counts', 'notes_fts', 'tags_fts', 'note_fields_fts', 'attachment_text_fts')`;

describe.skipIf(!sqlite3)('the D1 migrations', () => {
  let file: string;
  beforeAll(() => {
    file = join(mkdtempSync(join(tmpdir(), 'unbent-migrations-')), 'd1.sqlite');
  });

  it('apply in order to a real SQLite, up to the drop', () => {
    const { run } = db(file);
    expect(files).toContain(DROP);
    for (const f of BEFORE) run(migration(f));
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
    // And every migration since applies on top of the dropped schema.
    for (const f of AFTER) run(migration(f));
    expect(run(`SELECT COUNT(*) FROM pragma_table_info('account_directory') WHERE name LIKE 'dump_%'`)).toBe('6');
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

/**
 * The plans the directory's statements get, on a database built from every migration.
 * The operator's accounts list walks `user`'s email index and finds each directory row by
 * its key; the dump run's statements, which join `user` too, must keep driving from the
 * directory. The planner has no statistics, so an index it can use is an index it takes:
 * the first version of 0039's activity index, since dropped by 0042, was partial on
 * `deleted_at IS NULL`, and the dump run's two statements walked it on every hourly run
 * (found in review). Pinned here, where AGENTS.md says a new D1 index is checked, so the
 * next index on these tables shows what it does to the others.
 */
describe.skipIf(!sqlite3)('the directory\'s query plans', () => {
  let query: (sql: string) => string;
  let plan: (sql: string) => string;
  beforeAll(() => {
    const file = join(mkdtempSync(join(tmpdir(), 'unbent-plans-')), 'd1.sqlite');
    const { run } = db(file);
    for (const f of files) run(migration(f));
    query = run;
    plan = (sql) => run(`EXPLAIN QUERY PLAN ${sql}`);
  });

  it('walk the accounts list down the email index, with or without a search, and find each row by its key', () => {
    const pages: [after: string, needle: string][] = [["''", 'NULL'], ["'m@example.com'", 'NULL'], ["''", "'ex'"], ["'m@example.com'", "'ex'"]];
    for (const [after, needle] of pages) {
      const p = plan(OPERATOR_PAGE_SQL.replace('?1', after).replace(/\?2/g, needle).replace('?3', '50'));
      // The first page's `email > ''` is a seek too, from the start of the index.
      expect(p).toContain('SEARCH u USING INDEX sqlite_autoindex_user_2 (email>?)');
      expect(p).toContain('SEARCH d USING INDEX sqlite_autoindex_account_directory_1 (user_id=?)');
      // In the index's order, so a page is `LIMIT` rows read and not the table sorted.
      expect(p).not.toContain('TEMP B-TREE');
    }
  });

  it('leave the sweep and the dump run on the directory\'s key, not on the list\'s email index', () => {
    // `listDirectory`, the sweep's walk.
    expect(
      plan(`SELECT d.*, (u.id IS NOT NULL) AS user_exists FROM account_directory d LEFT JOIN user u ON u.id = d.user_id WHERE d.user_id > '' ORDER BY d.user_id LIMIT 20`),
    ).toContain('SEARCH d USING INDEX sqlite_autoindex_account_directory_1');
    // The dump run's due list and its status, the statements `dumpStores` runs, which
    // join `user` too and must keep finding it by id rather than walking it by email.
    const due = plan(DUMP_SQL.due.replace('?1', '1').replace('?2', '20'));
    const status = plan(DUMP_SQL.status.replace('?1', '1').replace(/\?2/g, '50'));
    for (const p of [due, status]) expect(p).not.toContain('sqlite_autoindex_user_2');
  });

  /**
   * The plan table's one walk (0045): the sweep asking which accounts have run out and
   * not been told. Its partial index serves exactly that statement, and the table's other
   * statements go by key or by the customer's unique index, so it changes nothing else.
   */
  it('find the plans that have run out from their own partial index', () => {
    const p = plan(LAPSE_DUE_SQL.replace('?1', '1').replace('?2', '5').replace('?3', '0'));
    // `IS NOT NULL` becomes the range's lower bound, so the index is read from its first entry.
    expect(p).toContain('SEARCH p USING INDEX idx_account_plan_lapse_due (plan_until>? AND plan_until<?)');
    expect(p).toContain('SEARCH u USING INDEX sqlite_autoindex_user_1 (id=?)');
    expect(p).not.toContain('TEMP B-TREE');
    expect(plan(`SELECT * FROM account_plan WHERE paddle_customer_id = 'ctm_x'`)).toContain('idx_account_plan_customer');
  });

  /**
   * The statement's filter on real rows, since `plan-mail.test.ts` fakes the database:
   * a trial's `source` and `paddle_status` are NULL, and a `NOT (… = …)` over them is
   * NULL, which once held every trial's mail back for the renewal grace.
   */
  it('find a lapsed trial and comp at once, and a renewing subscription only once its grace is up', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 10 * DAY;
    query(`
      INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES
        ('trial', 'T', 't@example.com', 0, 'n', 'n'), ('comp', 'C', 'c@example.com', 0, 'n', 'n'),
        ('renewing', 'R', 'r@example.com', 0, 'n', 'n'), ('long-gone', 'L', 'l@example.com', 0, 'n', 'n'),
        ('cancelling', 'X', 'x@example.com', 0, 'n', 'n');
      INSERT INTO account_plan (user_id, plan, plan_until, storage_gb, source, paddle_status, paddle_cancels_at, created_at, updated_at) VALUES
        ('trial', 'trial', ${now - 3_600_000}, 10, NULL, NULL, NULL, 1, 1),
        ('comp', 'active', ${now - 3_600_000}, 10, 'comp', NULL, NULL, 1, 1),
        ('renewing', 'active', ${now - 3_600_000}, 10, 'paddle', 'active', NULL, 1, 1),
        ('long-gone', 'active', ${now - 2 * DAY}, 10, 'paddle', 'active', NULL, 1, 1),
        ('cancelling', 'active', ${now - 3_600_000}, 10, 'paddle', 'active', ${now - 3_600_000}, 1, 1);
    `);
    const due = query(LAPSE_DUE_SQL.replace('?1', String(now)).replace('?2', '10').replace('?3', String(now - DAY)))
      .split('\n')
      .map((line) => line.split('|')[0]);
    expect(due).toEqual(['long-gone', 'trial', 'comp', 'cancelling']);
    query(`DELETE FROM account_plan; DELETE FROM user;`);
  });

  it('drop the activity index the list no longer reads', () => {
    // Run, not planned: the plan of a read of the catalogue names no index whatever it holds.
    expect(query(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_account_directory_activity'`)).toBe('0');
  });
});

/**
 * 0041 carries 0038's one record per account into the history, so the wind-back an
 * operator could undo the day before it landed is still undoable the day after. Only a
 * live account's, and only a whole record: 0038 wrote the moment and the time together,
 * and a row missing either was never offered.
 */
describe.skipIf(!sqlite3)('the restore history', () => {
  let run: (sql: string) => string;
  beforeAll(() => {
    const file = join(mkdtempSync(join(tmpdir(), 'unbent-restores-')), 'd1.sqlite');
    ({ run } = db(file));
    const RESTORES = '0041_restores.sql';
    for (const f of files.slice(0, files.indexOf(RESTORES))) run(migration(f));
    run(`
      INSERT INTO account_directory (user_id, created_at, restore_at, restore_to_at, restore_undo) VALUES
        ('wound', 1, 2000, 1000, 'bookmark-a'),
        ('no-undo', 1, 3000, 1500, NULL),
        ('never', 1, NULL, NULL, NULL);
      INSERT INTO account_directory (user_id, created_at, deleted_at, restore_at, restore_to_at, restore_undo) VALUES
        ('deleted', 1, 5, 4000, 3500, 'bookmark-b');
    `);
    run(migration(RESTORES));
  });

  it('starts from the last wind-back the directory recorded for each live account, with no operator', () => {
    expect(run(`SELECT user_id, operator_id IS NULL, kind, state, started_at, applied_at, to_at, undo FROM restores ORDER BY user_id`)).toBe(
      ['no-undo|1|moment|applied|3000|3000|1500|', 'wound|1|moment|applied|2000|2000|1000|bookmark-a'].join('\n'),
    );
  });

  it('reads one account through its index, for the list and for an undo\'s bookmark', () => {
    const plan = (sql: string) => run(`EXPLAIN QUERY PLAN ${sql}`);
    const list = plan(RESTORES_SQL.list.replace('?1', "'u'").replace('?2', '21'));
    expect(list).toContain('SEARCH r USING INDEX idx_restores_user (user_id=?)');
    // Newest first from the index itself, whose entries carry the rowid in order.
    expect(list).not.toContain('TEMP B-TREE');
    expect(plan(RESTORES_SQL.undone.replace('?1', "'u'").replace('?2', "'b'"))).toContain('SEARCH restores USING INDEX idx_restores_user (user_id=?)');
    // The newest row's id, checked inside every start: the index alone, which carries the rowid.
    expect(plan(RESTORES_SQL.newest.replace('?1', "'u'"))).toContain('SEARCH restores USING COVERING INDEX idx_restores_user (user_id=?)');
  });
});
