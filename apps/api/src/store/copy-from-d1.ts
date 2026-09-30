import type { Sql } from './sql.js';

/**
 * The one-time copy of an account's rows out of the shared D1 database into its object.
 *
 * This is the documented exception to rule 1 (the object touches its SQLite and nothing
 * else): it reads D1, once, on the first wake after the cutover, and never again. It
 * exists so that the accounts that predate the per-account store — the owner's and a few
 * friends' — arrive in their objects without anyone exporting and importing, and it is
 * deleted, along with `DB` on `StoreEnv`, once every account's directory row says it has
 * run. Nothing else in src/store/ may take a D1 binding.
 *
 * Shape: the tables are copied in dependency order, each paged out of D1 by `rowid` and
 * written in one transaction per page with the page's last rowid recorded in
 * `_meta.copy_cursor`. A reset part way — the object's CPU budget, a deploy — resumes at
 * the last committed page; `INSERT OR IGNORE` makes the overlap harmless. Foreign keys
 * are off for the copy and back on after it, because the shared database never enforced
 * them and a row that points at nothing there (a note whose notebook was removed by a
 * path that forgot to unfile it) must not stop the copy: such rows are repaired after —
 * unfiled, or dropped when they are links — and counted in the log line.
 *
 * Counts are not copied. The notebook and tag counts and the account totals are rebuilt
 * by the triggers as the rows arrive, and `recountNotes` confirms them at the end;
 * `has_text` is set by the text rows' trigger the same way. FTS is filled by the insert
 * triggers.
 *
 * At the end the object's counts are compared with D1's. A mismatch throws, which resets
 * the object, and drops the cursor first, so the next wake rescans every table from the
 * start (`INSERT OR IGNORE` makes that a no-op for rows already here) and verifies again;
 * the sweep surfaces an account that never converges. The repair count is kept in
 * `_meta` across wakes for the same reason: a wake that verifies what an earlier wake
 * repaired has to know how many rows that was.
 *
 * D1 queries count against the subrequests one invocation may make — fifty on Workers
 * Free — and the copy runs inside the first request's invocation. So each wake spends at
 * most `D1_CALL_BUDGET` queries, then persists where it got to and throws an error marked
 * retryable, which the facade turns into a 503 with Retry-After; the next request, or the
 * sweep's next try, continues. An archive-sized account (4k notes, 4k files, 2.4k texts)
 * is about 55 queries at these page sizes: two wakes.
 */

const META_MIGRATED = 'migrated_from_d1';
const META_CURSOR = 'copy_cursor';
const META_REPAIRED = 'copy_repaired';
/**
 * A knob for the store tests, which have no other way to trip the budget cheaply: an
 * integer under this key, written through `runInDurableObject`, replaces `D1_CALL_BUDGET`
 * for that object. Nothing in the Worker writes it.
 */
const META_TEST_BUDGET = 'test_copy_budget';

/**
 * D1 queries one wake may spend before it hands back to the caller. Under the Free plan's
 * fifty, with room for the queries the first request's own handler made before it reached
 * the object.
 */
export const D1_CALL_BUDGET = 40;

/** How D1 stores the marker on the shared tables. Read here and nowhere else in the store. */
interface Table {
  name: string;
  /** Columns copied, in D1's names; the object's are the same. */
  columns: string[];
  /**
   * Rows per page. Sized against the budget above rather than the object's transaction:
   * the dry run wrote 200 notes a transaction in milliseconds, and every page is one
   * query. Texts are capped at half a million characters each when stored (their average
   * in production is nine kilobytes), so a page of two hundred is a few megabytes usually
   * and a hundred at the very worst, well inside a Worker's memory.
   */
  page: number;
  /** How the user's rows are found: by their own `user_id`, or through the note's. */
  scope: 'user_id' | 'via_note';
}

const TABLES: Table[] = [
  { name: 'notebooks', columns: ['id', 'name', 'created_at', 'purpose', 'emoji'], page: 1000, scope: 'user_id' },
  {
    name: 'notebook_fields',
    columns: ['id', 'notebook_id', 'name', 'type', 'options', 'position', 'created_at', 'deleted_at', 'notebook_name', 'scale_max', 'scale_step', 'currency'],
    page: 1000,
    scope: 'user_id',
  },
  { name: 'tags', columns: ['id', 'name'], page: 1000, scope: 'user_id' },
  {
    name: 'notes',
    columns: ['id', 'title', 'body', 'created_at', 'updated_at', 'deleted_at', 'source_enex', 'content_hash', 'notebook_id'],
    page: 500,
    scope: 'user_id',
  },
  { name: 'note_tags', columns: ['note_id', 'tag_id'], page: 1000, scope: 'via_note' },
  { name: 'note_fields', columns: ['note_id', 'field_id', 'value_text', 'value_num'], page: 1000, scope: 'user_id' },
  {
    name: 'attachments',
    columns: ['id', 'note_id', 'filename', 'content_type', 'size', 'r2_key', 'created_at'],
    page: 1000,
    scope: 'user_id',
  },
  {
    name: 'attachment_text',
    columns: ['attachment_id', 'note_id', 'filename', 'text', 'created_at', 'read_by'],
    page: 200,
    scope: 'user_id',
  },
];

export interface CopyReport {
  /** Rows copied per table, in this run. */
  copied: Record<string, number>;
  /** Rows the repair pass unfiled or dropped because they pointed at nothing, over every wake. */
  repaired: number;
  /** Stored counts `recountNotes` had to correct after the copy; expected 0. */
  corrections: number;
  ms: number;
  resumed: boolean;
}

/**
 * Thrown when a wake has spent its query budget with the copy still to finish. Carries
 * `retryable`, which survives RPC as an own property and is what `translateStoreError`
 * reads to answer the caller with a 503 and Retry-After rather than a failure.
 */
export class CopyIncomplete extends Error {
  readonly retryable = true;
  constructor(readonly queries: number, readonly at: string) {
    super(`copy from D1 paused after ${queries} queries at ${at}; the next request continues it`);
    this.name = 'CopyIncomplete';
  }
}

/** Whether the copy has run for this object. */
export function copiedFromD1(sql: Sql): boolean {
  return sql.first<{ value: string }>('SELECT value FROM _meta WHERE key = ?1', META_MIGRATED) !== null;
}

/** Marks the copy done without running it: for an object that starts empty by design. */
export function markCopiedFromD1(sql: Sql): void {
  sql.exec('INSERT INTO _meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING', META_MIGRATED, String(Date.now()));
}

function readMeta(sql: Sql, key: string): string | null {
  return sql.first<{ value: string }>('SELECT value FROM _meta WHERE key = ?1', key)?.value ?? null;
}

function readCursor(sql: Sql): { table: string; rowid: number } | null {
  const value = readMeta(sql, META_CURSOR);
  if (value === null) return null;
  const at = value.lastIndexOf(':');
  return { table: value.slice(0, at), rowid: Number(value.slice(at + 1)) };
}

function selectPage(t: Table): string {
  const cols = t.columns.map((c) => `t.${c}`).join(', ');
  return t.scope === 'user_id'
    ? `SELECT t.rowid AS rid, ${cols} FROM ${t.name} t
        WHERE t.user_id = ?1 AND t.rowid > ?2 ORDER BY t.rowid LIMIT ?3`
    : `SELECT t.rowid AS rid, ${cols} FROM ${t.name} t
         JOIN notes n ON n.id = t.note_id
        WHERE n.user_id = ?1 AND t.rowid > ?2 ORDER BY t.rowid LIMIT ?3`;
}

function countSql(t: Table): string {
  return t.scope === 'user_id'
    ? `SELECT COUNT(*) AS n FROM ${t.name} WHERE user_id = ?1`
    : `SELECT COUNT(*) AS n FROM ${t.name} t JOIN notes n ON n.id = t.note_id WHERE n.user_id = ?1`;
}

/**
 * Runs the copy for `userId`, or returns null when it has already run. Idempotent and
 * resumable; see the module comment. `recount` is `NotesStore.recountNotes`, passed in
 * so this module owes nothing to the store's shape.
 */
export async function copyFromD1(
  sql: Sql,
  db: D1Database,
  userId: string,
  recount: () => number,
  /** `ctx.storage.sync`: forces pending writes to disk before a throw resets the object. */
  flush: () => Promise<void>,
): Promise<CopyReport | null> {
  if (copiedFromD1(sql)) return null;
  const started = Date.now();
  const budget = Number(readMeta(sql, META_TEST_BUDGET)) || D1_CALL_BUDGET;

  // Every D1 query goes through here, so the budget is counted where it is spent. A page
  // is fetched only while the verification's own queries — one count per table — would
  // still fit after it; past that, the wake stops with its state persisted and tells the
  // caller to come back. The verification itself never pauses: its progress is not
  // persisted, so a wake that could pause inside it would restart it every time and
  // never finish.
  let queries = 0;
  const spend = async (at: string, reserve = TABLES.length) => {
    if (queries + 1 + reserve > budget) {
      await flush();
      throw new CopyIncomplete(queries, at);
    }
    queries += 1;
  };

  // A database with no note tables — a fresh instance, the test environment, or an
  // instance after the tables are dropped — has nothing to copy. The flag is set so the
  // question is never asked again.
  await spend('probe', 0);
  const hasTables = await db
    .prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'notes'`)
    .first<{ hit: number }>();
  if (!hasTables) {
    markCopiedFromD1(sql);
    return { copied: {}, repaired: 0, corrections: 0, ms: Date.now() - started, resumed: false };
  }

  const cursor = readCursor(sql);
  if (cursor) console.log(`[store] copy resumed user=${userId} at=${cursor.table}:${cursor.rowid}`);
  const copied: Record<string, number> = {};
  // Off for the copy, on again after: the shared database never enforced these, and a
  // dangling reference there must not stop the copy here. Outside any transaction, where
  // the pragma is a no-op.
  sql.exec('PRAGMA foreign_keys = OFF');
  try {
    let skipping = cursor !== null;
    for (const t of TABLES) {
      let rowid = 0;
      if (skipping) {
        if (t.name !== cursor!.table) continue; // already copied whole on an earlier run
        rowid = cursor!.rowid;
        skipping = false;
      }
      const insert = `INSERT OR IGNORE INTO ${t.name} (${t.columns.join(', ')})
                      VALUES (${t.columns.map((_, i) => `?${i + 1}`).join(', ')})`;
      for (;;) {
        await spend(`${t.name}:${rowid}`);
        const page = await db
          .prepare(selectPage(t))
          .bind(userId, rowid, t.page)
          .all<Record<string, unknown> & { rid: number }>();
        if (page.results.length === 0) break;
        sql.tx(() => {
          for (const r of page.results) {
            sql.exec(insert, ...t.columns.map((c) => r[c] as string | number | null));
          }
          const last = page.results[page.results.length - 1]!;
          sql.exec(
            'INSERT INTO _meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            META_CURSOR,
            `${t.name}:${last.rid}`,
          );
        });
        copied[t.name] = (copied[t.name] ?? 0) + page.results.length;
        rowid = page.results[page.results.length - 1]!.rid;
      }
    }

    // Rows the shared database let point at nothing. A note in a notebook that is gone
    // is unfiled, which is what deleting the notebook should have done; a link or a
    // value or a file whose note is gone is dropped, since nothing could ever read it.
    // The count accumulates in `_meta` across wakes: a later wake that only verifies
    // must still know how many rows an earlier one took away.
    let repairedNow = 0;
    const fix = (statement: string) => {
      repairedNow += sql.exec<{ n: number }>(`${statement} RETURNING 1 AS n`).length;
    };
    sql.tx(() => {
      fix(`UPDATE notes SET notebook_id = NULL WHERE notebook_id IS NOT NULL AND notebook_id NOT IN (SELECT id FROM notebooks)`);
      fix(`DELETE FROM note_tags WHERE note_id NOT IN (SELECT id FROM notes) OR tag_id NOT IN (SELECT id FROM tags)`);
      fix(`DELETE FROM note_fields WHERE note_id NOT IN (SELECT id FROM notes) OR field_id NOT IN (SELECT id FROM notebook_fields)`);
      fix(`DELETE FROM attachments WHERE note_id NOT IN (SELECT id FROM notes)`);
      fix(`DELETE FROM attachment_text WHERE attachment_id NOT IN (SELECT id FROM attachments) OR note_id NOT IN (SELECT id FROM notes)`);
      sql.exec(
        `INSERT INTO _meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = CAST(_meta.value AS INTEGER) + CAST(excluded.value AS INTEGER)`,
        META_REPAIRED,
        String(repairedNow),
      );
    });
    const repaired = Number(readMeta(sql, META_REPAIRED) ?? 0);
    sql.exec('PRAGMA foreign_keys = ON');
    const violations = sql.exec('PRAGMA foreign_key_check');
    if (violations.length > 0) {
      throw new Error(`copy from D1 left ${violations.length} foreign key violations after repair`);
    }

    // The triggers built every count as the rows arrived; this proves it, and is the
    // only recount an object should ever need.
    const corrections = recount();

    // What arrived against what D1 holds. Read at the end rather than the start, since
    // the tables are frozen and a count is a query the budget has to cover. The tables
    // the repair can touch may come up short by exactly what it removed, over every
    // wake; every other table must match. A mismatch drops the cursor before it throws,
    // so the next wake rescans from the first row rather than verifying the same tail.
    const actual = (name: string) => sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`)?.n ?? 0;
    const expected: Record<string, number> = {};
    for (const t of TABLES) {
      await spend(`count:${t.name}`, 0);
      expected[t.name] = (await db.prepare(countSql(t)).bind(userId).first<{ n: number }>())?.n ?? 0;
    }
    // Flushed to disk before the throw: the throw resets the object, and a write the
    // runtime has not yet confirmed is discarded with it — measured 2026-09-30, where the
    // DELETE alone, even in its own transaction, never reached the next wake, which then
    // verified the same tail and failed the same way for good.
    const incomplete = async (why: string): Promise<Error> => {
      sql.exec('DELETE FROM _meta WHERE key = ?1', META_CURSOR);
      await flush();
      return new Error(`copy from D1 incomplete: ${why}; the next wake rescans every table`);
    };
    for (const name of ['notebooks', 'notebook_fields', 'tags', 'notes']) {
      if (actual(name) !== expected[name]) {
        throw await incomplete(`${name} has ${actual(name)} rows, D1 has ${expected[name]}`);
      }
    }
    let short = 0;
    for (const name of ['note_tags', 'note_fields', 'attachments', 'attachment_text']) {
      short += (expected[name] ?? 0) - actual(name);
    }
    if (short > repaired || short < 0) {
      throw await incomplete(`child tables are ${short} rows short, ${repaired} repaired`);
    }

    sql.tx(() => {
      markCopiedFromD1(sql);
      sql.exec('DELETE FROM _meta WHERE key IN (?1, ?2, ?3)', META_CURSOR, META_REPAIRED, META_TEST_BUDGET);
    });
    const report = { copied, repaired, corrections, ms: Date.now() - started, resumed: cursor !== null };
    console.log(
      `[store] migrated user=${userId} notes=${actual('notes')} attachments=${actual('attachments')} texts=${actual('attachment_text')} repaired=${repaired} corrections=${corrections} queries=${queries} resumed=${report.resumed} ms=${report.ms}`,
    );
    return report;
  } catch (err) {
    // Whatever happened, the engine must not be left with foreign keys off: the object is
    // about to reset, but the pragma is per connection and the next wake checks it.
    sql.exec('PRAGMA foreign_keys = ON');
    if (err instanceof CopyIncomplete) {
      console.log(`[store] copy paused user=${userId} queries=${err.queries} at=${err.at}`);
    }
    throw err;
  }
}
