import type { Sql } from './sql.js';

/**
 * The one-time copy of an account's rows out of the shared D1 database into its object.
 *
 * This is the documented exception to rule 1 (the object touches its SQLite and nothing
 * else): it reads D1, once per account, and never again. It exists so that the accounts
 * that predate the per-account store — the owner's and a few friends' — arrive in their
 * objects without anyone exporting and importing, and it is deleted, along with `DB` on
 * `StoreEnv`, once every account's directory row says it has run. Nothing else in
 * src/store/ may take a D1 binding.
 *
 * It runs only when asked. The sweep asks, for every account whose object has not yet
 * been copied, and the operator's route asks for one account at a time; nothing about a
 * wake — a person opening the app — reads D1. That is a deliberate retreat from an
 * earlier shape, where the copy ran in the constructor on first wake: it then had to be
 * right about the runtime's reset semantics, about which writes survive a throw, about
 * the subrequests the request that woke the object had already spent, and about what a
 * person sees while it runs, and three rounds of review each found a case it was wrong
 * about. A copy that runs inside an ordinary request, called by code that expects an
 * answer rather than a page, has none of those questions to get wrong. What it costs is
 * a window between the deploy and the sweep in which an account not yet copied opens
 * empty; the runbook closes it in minutes, and a note written in that window survives
 * the copy (see verification, below).
 *
 * Shape: the tables are copied in dependency order, each paged out of D1 by `rowid` and
 * written in one transaction per page with the page's last rowid recorded in `_meta`, so
 * a call that stops at its query budget, or a run cut short by anything else, resumes at
 * the last committed page. Foreign keys stay on. The shared database never enforced
 * them, so a row there may point at nothing — a note whose notebook was removed by a path
 * that forgot to unfile it, a tag link whose note is gone — and such a row is dealt with
 * as it arrives rather than by a repair pass afterwards: a note is unfiled, anything else
 * is skipped and counted. `INSERT OR IGNORE` makes a rescan a no-op for rows already
 * here.
 *
 * Counts are not copied. The notebook and tag counts and the account totals are rebuilt
 * by the triggers as the rows arrive, and `recountNotes` confirms them at the end;
 * `has_text` is set by the text rows' trigger the same way. FTS is filled by the insert
 * triggers.
 *
 * A tag or notebook the store already has under the same name is merged rather than
 * refused: the D1 row's id is mapped to the existing row's, and every row that points
 * at it is rewritten as it arrives. That is what makes the window above survivable —
 * the first thing a person does in an empty account is make a note with their usual
 * tag, and without this the tag D1 then delivers would collide with it — and it is also
 * what the store's own uniqueness means for two D1 notebooks whose names differ only in
 * case, which `UNIQUE(name COLLATE NOCASE)` cannot hold apart. That second kind is a
 * silent change to an account's structure, so every merge is counted in the result and
 * the runbook expects zero for an account that predates the cutover. Fields are not
 * merged: a `notebook_fields` row that collides on `(notebook_id, name)` after its
 * notebook was merged is ignored by the insert and surfaces as a mismatch, because two
 * fields of one name can differ in type and a wrong merge would be worse than a stop.
 *
 * Verification is by what landed, not by what the tables hold: the rows each page
 * inserted are counted (`RETURNING`, so a row the store ignored is not) and kept with the
 * cursor, and at the end inserted plus skipped plus merged must equal D1's count for
 * every table. A note the owner wrote before the copy ran does not upset that, where
 * comparing table totals would have called it a row too many. A mismatch is a row the
 * store refused for a reason it cannot mend — two files on one note under the same
 * filename, say — or D1 having changed underneath; it is recorded, the account is not
 * marked, and nothing tries again until the operator says so with `retry`, after looking
 * with the SQL route and fixing the rows in D1 (which are not frozen, since the account
 * is not migrated). A retry rescans every table, so a row the operator mended in D1 is
 * fetched, and re-counts what it skips from zero, since a rescan skips the same rows
 * again.
 *
 * The account's rows in D1 are frozen from the copy's first query, not from its last:
 * `account_directory.migrated_at` is written before a page is read, and migration 0032's
 * triggers then refuse every insert and update to that account's rows. That is what
 * makes a write from a draining old isolate refused, visibly, rather than lost — one
 * that landed after its page was read would otherwise never arrive here, and a count
 * would not catch an update. A copy that cannot be verified clears the mark again, so
 * the operator can fix the rows where they are. That the account's copy *finished* is a
 * different fact with a different column, `copied_at`, written when verification passes
 * and nowhere earlier: it is what the runbook checks and what the migration that drops
 * these tables will refuse to run without.
 *
 * D1 queries count against the subrequests one invocation may make — fifty on Workers
 * Free — so each call spends at most `D1_CALL_BUDGET` and then answers `paused` with
 * its progress committed; the caller calls again. Rows read count too, against the daily
 * budget the shared database ran out of twice: every page is a range seek on an index
 * of the copy's own (migration 0035; `migrations.test.ts` pins the plans), an account
 * with no rows is done in a few queries rather than eighteen, and what each call read is
 * in its answer as `d1RowsRead`, so "the copy reads each account about once" is a number
 * in the log rather than a belief. The index is on the expression `(user_id || '')`
 * rather than the column, and every statement here spells that expression: a plain
 * index on `user_id` was taken up by `main`'s own statements — a file lookup by note, the
 * import's duplicate check — and turned them into reads of whole accounts, on the
 * database dev still serves `main` from (found in review). An expression index is
 * matched only by the expression, so it is the copy's alone. An archive-sized account (4k notes, 4k
 * files, 2.4k texts) is about 55 queries at these page sizes: two calls.
 */

const META_MIGRATED = 'migrated_from_d1';
/** JSON: where the copy got to and what it has counted; see `Progress`. Gone once the copy is done. */
const META_PROGRESS = 'copy_progress';
/** The reason the last verification failed. While it is set, only a `retry` runs the copy. */
const META_MISMATCH = 'copy_mismatch';

/**
 * D1 queries one call may spend before it answers `paused`. Under the Free plan's fifty,
 * with the verification's own queries reserved on top (see `spend`).
 */
export const D1_CALL_BUDGET = 40;

/**
 * The most characters of text one page carries, for the two tables whose rows can be
 * large. A text is capped at half a million characters when stored and a body at what D1
 * allows a row, and two hundred of the largest texts in one page would have been a
 * hundred million characters — past the object's memory once decoded, on exactly the
 * run of consecutive big scans an imported batch of PDFs leaves (found in review). A
 * page stops once the rows before the next one pass this, and always carries at least
 * one row, so the biggest single text still fits with room to spare. Four million is
 * eight megabytes decoded.
 */
export const PAGE_CHARS = 4_000_000;

/** A column that points at another table's row: rewritten if that row was merged, and checked. */
interface Parent {
  column: string;
  table: string;
  /**
   * When the row pointed at is not here: `unfile` nulls the column and keeps the row (a
   * note's notebook); `skip` drops the row; `keep` does nothing, for a reference the
   * store's schema deliberately does not enforce (a field's notebook, which a tombstone
   * outlives).
   */
  onMissing: 'unfile' | 'skip' | 'keep';
}

/** How D1 stores the marker on the shared tables. Read here and nowhere else in the store. */
interface Table {
  name: string;
  /** Columns copied, in D1's names; the object's are the same. */
  columns: string[];
  /**
   * Rows per page, at most. Sized against the query budget rather than the object's
   * transaction: the dry run wrote 200 notes a transaction in milliseconds, and every
   * page is one query.
   */
  page: number;
  /** The column whose length bounds a page by `PAGE_CHARS`, for the tables with big rows. */
  sizeColumn?: string;
  /**
   * How the user's rows are found: by their own `user_id`, or a note at a time through
   * the note's — for a table with no `user_id`, whose page is then `page` notes' worth of
   * rows rather than `page` rows; see `selectPage`.
   */
  scope: 'user_id' | 'by_note';
  /** The store's foreign keys out of this table, checked per row since D1 never did. */
  parents?: Parent[];
  /** The condition that finds a row already here by name, for the tables merged rather than refused. */
  mergeOn?: string;
}

const TABLES: Table[] = [
  { name: 'notebooks', columns: ['id', 'name', 'created_at', 'purpose', 'emoji'], page: 1000, scope: 'user_id', mergeOn: 'name = ?1 COLLATE NOCASE' },
  {
    name: 'notebook_fields',
    columns: ['id', 'notebook_id', 'name', 'type', 'options', 'position', 'created_at', 'deleted_at', 'notebook_name', 'scale_max', 'scale_step', 'currency'],
    page: 1000,
    scope: 'user_id',
    parents: [{ column: 'notebook_id', table: 'notebooks', onMissing: 'keep' }],
  },
  { name: 'tags', columns: ['id', 'name'], page: 1000, scope: 'user_id', mergeOn: 'name = ?1' },
  {
    name: 'notes',
    columns: ['id', 'title', 'body', 'created_at', 'updated_at', 'deleted_at', 'source_enex', 'content_hash', 'notebook_id'],
    page: 500,
    sizeColumn: 'body',
    scope: 'user_id',
    parents: [{ column: 'notebook_id', table: 'notebooks', onMissing: 'unfile' }],
  },
  {
    name: 'note_tags',
    columns: ['note_id', 'tag_id'],
    page: 1000,
    scope: 'by_note',
    parents: [
      { column: 'note_id', table: 'notes', onMissing: 'skip' },
      { column: 'tag_id', table: 'tags', onMissing: 'skip' },
    ],
  },
  {
    name: 'note_fields',
    columns: ['note_id', 'field_id', 'value_text', 'value_num'],
    page: 1000,
    scope: 'user_id',
    parents: [
      { column: 'note_id', table: 'notes', onMissing: 'skip' },
      { column: 'field_id', table: 'notebook_fields', onMissing: 'skip' },
    ],
  },
  {
    name: 'attachments',
    columns: ['id', 'note_id', 'filename', 'content_type', 'size', 'r2_key', 'created_at'],
    page: 1000,
    scope: 'user_id',
    parents: [{ column: 'note_id', table: 'notes', onMissing: 'skip' }],
  },
  {
    name: 'attachment_text',
    columns: ['attachment_id', 'note_id', 'filename', 'text', 'created_at', 'read_by'],
    page: 200,
    sizeColumn: 'text',
    scope: 'user_id',
    parents: [
      { column: 'attachment_id', table: 'attachments', onMissing: 'skip' },
      { column: 'note_id', table: 'notes', onMissing: 'skip' },
    ],
  },
];

/** What `_meta.copy_progress` holds between calls. */
interface Progress {
  /** `<table>:<rowid>` of the last committed page, or null before the first. */
  cursor: string | null;
  /** Rows landed per table, over every call: what verification compares with D1. */
  inserted: Record<string, number>;
  /** Rows dropped per table for a missing parent, over the current scan. */
  skipped: Record<string, number>;
  /** Per table, the D1 id of each row merged into a row already here, and that row's id. */
  merged: Record<string, Record<string, string>>;
}

export interface CopyOptions {
  /**
   * Whether the copy may write the directory: `migrated_at` before its first page, which
   * freezes the account's D1 rows (migration 0032), and `copied_at` when it has
   * verified. Off on the pull-request previews, which share the dev instance's D1 while
   * dev still runs the old code and writes it: a preview's copy of an account would
   * otherwise refuse that account's saves on dev until the merge.
   */
  freeze: boolean;
  /** Runs the copy again after a recorded mismatch. Nothing else does. */
  retry?: boolean | undefined;
  /** D1 queries this call may spend; the tests' way to see a pause. Defaults to `D1_CALL_BUDGET`. */
  budget?: number | undefined;
}

export type CopyResult =
  /** Nothing to do: the copy has run (or the account started empty by design). */
  | { status: 'already' }
  /** The budget is spent with tables still to copy; progress is committed, call again. */
  | { status: 'paused'; queries: number; d1RowsRead: number; at: string }
  /** Verification failed, now or on an earlier call; the account is not marked. See `retry`. */
  | { status: 'mismatch'; reason: string; queries: number; d1RowsRead: number }
  | {
      status: 'done';
      /** Rows landed per table, over every call. */
      copied: Record<string, number>;
      /** Rows dropped for a missing parent, notes unfiled for one, and tags and notebooks merged by name. */
      skipped: number;
      unfiled: number;
      merged: number;
      /** Stored counts `recountNotes` had to correct after the copy; expected 0. */
      corrections: number;
      queries: number;
      /** Rows D1 reports this call read, over every query; about the account's row count, once. */
      d1RowsRead: number;
      ms: number;
      resumed: boolean;
    };

/** Whether the copy has run for this object. */
export function copiedFromD1(sql: Sql): boolean {
  return sql.first<{ value: string }>('SELECT value FROM _meta WHERE key = ?1', META_MIGRATED) !== null;
}

/** Marks the copy done without running it: for an object that starts empty by design. */
export function markCopiedFromD1(sql: Sql): void {
  sql.exec('INSERT INTO _meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING', META_MIGRATED, String(Date.now()));
}

/** The recorded reason the last verification failed, for `stats`. */
export function copyMismatch(sql: Sql): string | null {
  return readMeta(sql, META_MISMATCH);
}

function readMeta(sql: Sql, key: string): string | null {
  return sql.first<{ value: string }>('SELECT value FROM _meta WHERE key = ?1', key)?.value ?? null;
}

function writeMeta(sql: Sql, key: string, value: string): void {
  sql.exec('INSERT INTO _meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

function readProgress(sql: Sql): Progress {
  const raw = readMeta(sql, META_PROGRESS);
  return raw ? (JSON.parse(raw) as Progress) : { cursor: null, inserted: {}, skipped: {}, merged: {} };
}

/**
 * One page: the user's rows past the cursor, in rowid order, up to the row limit. For a
 * table with big rows the page is also cut by size, in the same query: a running total of
 * the size column over the page is computed with a window function, and a row is kept
 * while the total *before* it is under `PAGE_CHARS` — so the first row is always kept,
 * whatever its size, and the page ends at the first row that would take it over. One
 * query either way, which is what the budget counts.
 *
 * A table with no `user_id` of its own (`note_tags`) is paged by note: the next `page`
 * of the user's notes by rowid, through the copy's index, and every link they have, with
 * the last note's rowid as the cursor. Walking the links by their own rowid read the
 * whole table across every account for each account copied, and starting from the
 * user's notes without a bound gathered and sorted every link per page (both found in
 * review). It is a LEFT JOIN so a note with no links still yields a row — with a null
 * link, which the caller drops — because a run of unlinked notes would otherwise come
 * back as an empty page, and an empty page means the end of the table.
 */
function selectPage(t: Table): string {
  const cols = t.columns.map((c) => `t.${c}`).join(', ');
  if (t.scope === 'by_note') {
    return `SELECT n.rowid AS rid, ${cols}
              FROM notes n LEFT JOIN ${t.name} t ON t.note_id = n.id
             WHERE (n.user_id || '') = ?1 AND n.rowid > ?2
               AND n.rowid <= (SELECT MAX(rowid) FROM (SELECT rowid FROM notes WHERE (user_id || '') = ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3))
             ORDER BY n.rowid`;
  }
  const from = `FROM ${t.name} t WHERE (t.user_id || '') = ?1 AND t.rowid > ?2`;
  if (!t.sizeColumn) return `SELECT t.rowid AS rid, ${cols} ${from} ORDER BY t.rowid LIMIT ?3`;
  return `SELECT * FROM (
            SELECT t.rowid AS rid, ${cols},
                   SUM(length(t.${t.sizeColumn})) OVER (ORDER BY t.rowid) - length(t.${t.sizeColumn}) AS before
            ${from} ORDER BY t.rowid LIMIT ?3
          ) WHERE before < ?4`;
}

function countSql(t: Table): string {
  return t.scope === 'user_id'
    ? `SELECT COUNT(*) AS n FROM ${t.name} WHERE (user_id || '') = ?1`
    : `SELECT COUNT(*) AS n FROM ${t.name} t JOIN notes n ON n.id = t.note_id WHERE (n.user_id || '') = ?1`;
}

/** Whether the user has any rows here at all: the four tables everything else hangs off. */
const ANY_ROWS_SQL = `SELECT (EXISTS (SELECT 1 FROM notes WHERE (user_id || '') = ?1)
                           OR EXISTS (SELECT 1 FROM notebooks WHERE (user_id || '') = ?1)
                           OR EXISTS (SELECT 1 FROM tags WHERE (user_id || '') = ?1)
                           OR EXISTS (SELECT 1 FROM attachments WHERE (user_id || '') = ?1)) AS hit`;

/** Every statement the copy runs against D1 with a plan worth pinning; see `migrations.test.ts`. */
export function copyQueries(): { tables: Array<{ table: string; page: string; count: string }>; anyRows: string } {
  return { tables: TABLES.map((t) => ({ table: t.name, page: selectPage(t), count: countSql(t) })), anyRows: ANY_ROWS_SQL };
}

/** Internal: the budget is spent. Never leaves this module. */
class Paused {
  constructor(readonly at: string) {}
}

/**
 * Runs, or continues, the copy for `userId`. `recount` is `NotesStore.recountNotes`,
 * passed in so this module owes nothing to the store's shape. Answers rather than throws
 * for everything the copy itself can decide (see `CopyResult`); a D1 failure propagates.
 */
export async function copyFromD1(sql: Sql, db: D1Database, userId: string, recount: () => number, opts: CopyOptions): Promise<CopyResult> {
  if (copiedFromD1(sql)) return { status: 'already' };
  const mismatch = readMeta(sql, META_MISMATCH);
  if (mismatch !== null && !opts.retry) return { status: 'mismatch', reason: mismatch, queries: 0, d1RowsRead: 0 };
  const started = Date.now();
  const budget = opts.budget ?? D1_CALL_BUDGET;

  // Every D1 query goes through here, so the budget is counted where it is spent. A page
  // is fetched only while the verification's own queries — one count per table, and the
  // directory write that follows, `copied_at` or the unfreeze — would still fit after it;
  // past that, the call stops with its state committed and answers `paused`. The verification itself never pauses: its progress is
  // not persisted, so a call that could pause inside it would restart it every time and
  // never finish.
  let queries = 0;
  const spend = (at: string, reserve = TABLES.length + 1) => {
    if (queries + 1 + reserve > budget) throw new Paused(at);
    queries += 1;
  };
  // Every D1 statement goes through one of these two, so the rows D1 reports it read are
  // added up where they are spent.
  let d1RowsRead = 0;
  const all = async <T>(statement: D1PreparedStatement): Promise<T[]> => {
    const res = await statement.all<T>();
    d1RowsRead += res.meta.rows_read ?? 0;
    return res.results;
  };
  const run = async (statement: D1PreparedStatement): Promise<void> => {
    d1RowsRead += (await statement.run()).meta.rows_read ?? 0;
  };
  // Nothing to copy: marked in the object, and recorded as finished where the runbook
  // reads it, the same as a copy that had rows.
  const nothing = async () => {
    if (opts.freeze) {
      spend('copied', 0);
      await run(db.prepare(`UPDATE account_directory SET copied_at = COALESCE(copied_at, ?2) WHERE user_id = ?1`).bind(userId, Date.now()));
    }
    markCopiedFromD1(sql);
    return { status: 'done' as const, copied: {}, skipped: 0, unfiled: 0, merged: 0, corrections: 0, queries, d1RowsRead, ms: Date.now() - started, resumed: false };
  };

  try {
    // A database with no note tables — a fresh instance, the test environment, or an
    // instance after the tables are dropped — has nothing to copy. The flag is set so the
    // question is never asked again.
    spend('probe', 0);
    const hasTables = (await all<{ hit: number }>(db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'notes'`)))[0];
    if (!hasTables) return nothing();

    // Frozen from here, before anything is read; see the module comment. Before the row
    // check below as well as before the pages: an account with no rows *now* could still
    // get one from an old isolate draining during the deploy, and it would land after the
    // check and be lost without a trace (found in review). Freezing an account that will
    // never have rows here costs one write and nothing else. Idempotent, so a resumed call
    // pays one query to say it again. Not on a preview; see `opts.freeze`.
    if (opts.freeze) {
      spend('freeze', 0);
      await run(db.prepare(`UPDATE account_directory SET migrated_at = COALESCE(migrated_at, ?2) WHERE user_id = ?1`).bind(userId, Date.now()));
    }

    // An account with no rows here — every account made after the cutover — is done in
    // one more query rather than sixteen.
    spend('any', 0);
    const any = (await all<{ hit: number }>(db.prepare(ANY_ROWS_SQL).bind(userId)))[0];
    if (!any?.hit) return nothing();

    const progress = readProgress(sql);
    const resumed = progress.cursor !== null;
    if (mismatch !== null) {
      // A retry: rescan from the first row. Rows already here are ignored by the insert
      // and stay counted; rows skipped last time are skipped and counted again, so that
      // count starts over.
      sql.exec('DELETE FROM _meta WHERE key = ?1', META_MISMATCH);
      progress.cursor = null;
      progress.skipped = {};
    }
    if (resumed) console.log(`[store] copy resumed user=${userId} at=${progress.cursor}`);
    let unfiled = 0;

    let skipping = progress.cursor !== null;
    for (const t of TABLES) {
      let rowid = 0;
      if (skipping) {
        const at = progress.cursor!.lastIndexOf(':');
        if (t.name !== progress.cursor!.slice(0, at)) continue; // already copied whole on an earlier call
        rowid = Number(progress.cursor!.slice(at + 1));
        skipping = false;
      }
      const insert = `INSERT OR IGNORE INTO ${t.name} (${t.columns.join(', ')})
                      VALUES (${t.columns.map((_, i) => `?${i + 1}`).join(', ')}) RETURNING 1 AS n`;
      for (;;) {
        spend(`${t.name}:${rowid}`);
        const results = await all<Record<string, unknown> & { rid: number }>(
          db.prepare(selectPage(t)).bind(userId, rowid, t.page, ...(t.sizeColumn ? [PAGE_CHARS] : [])),
        );
        if (results.length === 0) break;
        sql.tx(() => {
          rows: for (const r of results) {
            // A note with no rows here, carried so the page is not empty; see `selectPage`.
            if (t.scope === 'by_note' && r[t.columns[0]!] === null) continue;
            for (const p of t.parents ?? []) {
              const value = progress.merged[p.table]?.[r[p.column] as string] ?? r[p.column];
              r[p.column] = value;
              if (value === null || value === undefined || p.onMissing === 'keep') continue;
              if (sql.first<{ hit: number }>(`SELECT 1 AS hit FROM ${p.table} WHERE id = ?1`, value as string)) continue;
              if (p.onMissing === 'unfile') {
                r[p.column] = null;
                unfiled += 1;
              } else {
                progress.skipped[t.name] = (progress.skipped[t.name] ?? 0) + 1;
                continue rows;
              }
            }
            const landed = sql.exec<{ n: number }>(insert, ...t.columns.map((c) => (r[c] ?? null) as string | number | null)).length;
            progress.inserted[t.name] = (progress.inserted[t.name] ?? 0) + landed;
            if (landed === 0 && t.mergeOn) {
              // Not inserted, and there is a row of this name: merge into it, unless the
              // row of this name is this row, already here from an earlier page.
              const existing = sql.first<{ id: string }>(`SELECT id FROM ${t.name} WHERE ${t.mergeOn}`, r['name'] as string);
              if (existing && existing.id !== r['id']) (progress.merged[t.name] ??= {})[r['id'] as string] = existing.id;
            }
          }
          progress.cursor = `${t.name}:${results[results.length - 1]!.rid}`;
          writeMeta(sql, META_PROGRESS, JSON.stringify(progress));
        });
        rowid = results[results.length - 1]!.rid;
      }
    }

    // The triggers built every count as the rows arrived; this proves it, and is the
    // only recount an object should ever need.
    const corrections = recount();

    // What landed against what D1 holds, table by table. Read at the end rather than the
    // start, since a count is a query the budget has to cover and the tables are still
    // being read. A mismatch is recorded with the cursor dropped, so a retry rescans
    // from the first row rather than verifying the same tail.
    for (const t of TABLES) {
      spend(`count:${t.name}`, 0);
      const expected = (await all<{ n: number }>(db.prepare(countSql(t)).bind(userId)))[0]?.n ?? 0;
      const inserted = progress.inserted[t.name] ?? 0;
      const skipped = progress.skipped[t.name] ?? 0;
      const merged = Object.keys(progress.merged[t.name] ?? {}).length;
      if (inserted + skipped + merged !== expected) {
        const reason = `${t.name}: ${inserted + skipped + merged} of ${expected} rows landed (${inserted} copied, ${skipped} skipped for a missing parent, ${merged} merged by name)`;
        sql.tx(() => {
          writeMeta(sql, META_MISMATCH, reason);
          writeMeta(sql, META_PROGRESS, JSON.stringify({ ...progress, cursor: null }));
        });
        // Unfrozen again: D1 is still this account's truth, and the operator fixes the
        // rows there. The one query the reserve keeps for this.
        if (opts.freeze) {
          spend('unfreeze', 0);
          await run(db.prepare(`UPDATE account_directory SET migrated_at = NULL WHERE user_id = ?1`).bind(userId));
        }
        console.error(`[store] copy mismatch user=${userId} ${reason}`);
        return { status: 'mismatch', reason, queries, d1RowsRead };
      }
    }

    // Finished, and said so where the runbook reads it. The one query the reserve keeps
    // for the end, in place of the unfreeze a mismatch would have needed.
    if (opts.freeze) {
      spend('copied', 0);
      await run(db.prepare(`UPDATE account_directory SET copied_at = COALESCE(copied_at, ?2) WHERE user_id = ?1`).bind(userId, Date.now()));
    }
    sql.tx(() => {
      markCopiedFromD1(sql);
      sql.exec('DELETE FROM _meta WHERE key IN (?1, ?2)', META_PROGRESS, META_MISMATCH);
    });
    const skipped = Object.values(progress.skipped).reduce((n, v) => n + v, 0);
    const merged = Object.values(progress.merged).reduce((n, m) => n + Object.keys(m).length, 0);
    const report = { status: 'done' as const, copied: progress.inserted, skipped, unfiled, merged, corrections, queries, d1RowsRead, ms: Date.now() - started, resumed };
    console.log(
      `[store] migrated user=${userId} notes=${report.copied['notes'] ?? 0} attachments=${report.copied['attachments'] ?? 0} texts=${report.copied['attachment_text'] ?? 0} skipped=${skipped} unfiled=${unfiled} merged=${merged} corrections=${corrections} queries=${queries} d1RowsRead=${d1RowsRead} resumed=${resumed} ms=${report.ms}`,
    );
    return report;
  } catch (err) {
    if (err instanceof Paused) {
      console.log(`[store] copy paused user=${userId} queries=${queries} d1RowsRead=${d1RowsRead} at=${err.at}`);
      return { status: 'paused', queries, d1RowsRead, at: err.at };
    }
    throw err;
  }
}
