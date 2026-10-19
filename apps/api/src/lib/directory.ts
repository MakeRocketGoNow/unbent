import type { OperatorAccount, OperatorAccountsPage, OperatorSort, OperatorSortDir } from '@unbent/shared';
import { OPERATOR_PAGE_SIZE } from '@unbent/shared';
import { dropRestoresStatement } from './restores.js';

/**
 * The account directory: one D1 row per account, for what the control plane needs to
 * know about the per-account note stores without opening one. See migration 0030 for
 * why it exists and why it has no foreign key to `user`.
 *
 * Nothing here runs on the request path. A row is written when an account is created,
 * tombstoned when it is deleted, and otherwise touched only by the sweep, which walks
 * the directory and asks each object for its `usage` (never `stats`, which counts every
 * table). The counts it carries are
 * therefore as fresh as the last sweep, which is right for a cross-account view and
 * wrong for anything a user is shown about their own account: that comes from the
 * object.
 */

export interface DirectoryRow {
  userId: string;
  createdAt: number;
  /**
   * The cutover's record, written by nothing now: when the account's rows in the shared
   * tables were frozen, and when they were verified copied into its store. Null for an
   * account made since.
   */
  migratedAt: number | null;
  copiedAt: number | null;
  storageBytes: number;
  noteCount: number;
  lastActiveAt: number | null;
  deletedAt: number | null;
}

interface RawRow {
  user_id: string;
  created_at: number;
  migrated_at: number | null;
  copied_at: number | null;
  storage_bytes: number;
  note_count: number;
  last_active_at: number | null;
  deleted_at: number | null;
}

const toRow = (r: RawRow): DirectoryRow => ({
  userId: r.user_id,
  createdAt: r.created_at,
  migratedAt: r.migrated_at,
  copiedAt: r.copied_at,
  storageBytes: r.storage_bytes,
  noteCount: r.note_count,
  lastActiveAt: r.last_active_at,
  deletedAt: r.deleted_at,
});

/** Records an account. Idempotent, so a hook that fires twice does no harm. */
export async function ensureDirectoryRow(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(`INSERT INTO account_directory (user_id, created_at) VALUES (?1, ?2) ON CONFLICT(user_id) DO NOTHING`)
    .bind(userId, Date.now())
    .run();
}

/**
 * Marks an account deleted. The row stays: it is what the sweep retries the object wipe
 * from, and it is only removed by the sweep once the object reports empty and the
 * account's files are gone from R2, and not before `LATE_WRITES_MS` has passed. An
 * account with no row is never wiped by anything (see `sweepStores`), so this is also
 * the only thing that can turn a wipe on for an account.
 */
export async function tombstoneDirectoryRow(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO account_directory (user_id, created_at, deleted_at) VALUES (?1, ?2, ?2)
       ON CONFLICT(user_id) DO UPDATE SET deleted_at = COALESCE(account_directory.deleted_at, excluded.deleted_at)`,
    )
    .bind(userId, Date.now())
    .run();
}

/**
 * The sweep's tombstone, as a statement it batches, for a row whose `user` row is gone
 * and which never got one: the deletion's last step failed, or never ran. The time is
 * the sweep's, later than the deletion's, which only makes the wait before the row is
 * dropped (`LATE_WRITES_MS` in `sweep.ts`) longer than it had to be. An existing
 * tombstone is never moved.
 */
export function tombstoneDirectoryRowStatement(db: D1Database, userId: string, at: number): D1PreparedStatement {
  return db.prepare(`UPDATE account_directory SET deleted_at = ?2 WHERE user_id = ?1 AND deleted_at IS NULL`).bind(userId, at);
}

/** The delete as a statement, so the sweep can batch a page of them into one query. */
export function dropDirectoryRowStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM account_directory WHERE user_id = ?1`).bind(userId);
}

/** The row and the account's restore history with it (`dropRestoresStatement` says why). */
export async function dropDirectoryRow(db: D1Database, userId: string): Promise<void> {
  await db.batch([dropDirectoryRowStatement(db, userId), dropRestoresStatement(db, userId)]);
}

/**
 * What the sweep writes back after asking an object for its usage, as a statement it
 * batches. `lastActiveAt` is the store's newest write, kept here so a view across
 * accounts can sort by it without waking every store; null leaves the column as it was.
 */
export function recordDirectoryUsageStatement(
  db: D1Database,
  userId: string,
  usage: { storageBytes: number; noteCount: number; lastActiveAt: number | null },
): D1PreparedStatement {
  return db
    .prepare(`UPDATE account_directory SET storage_bytes = ?2, note_count = ?3, last_active_at = COALESCE(?4, last_active_at) WHERE user_id = ?1`)
    .bind(userId, usage.storageBytes, usage.noteCount, usage.lastActiveAt);
}

export async function directoryRow(db: D1Database, userId: string): Promise<DirectoryRow | null> {
  const row = await db.prepare(`SELECT * FROM account_directory WHERE user_id = ?1`).bind(userId).first<RawRow>();
  return row ? toRow(row) : null;
}

/**
 * A page of rows for the sweep, by user id, each saying whether its `user` row still
 * exists, on the same query, so a batch of accounts costs one D1 call to list rather
 * than one per account to check.
 */
export async function listDirectory(
  db: D1Database,
  after = '',
  limit = 200,
): Promise<Array<DirectoryRow & { userExists: boolean }>> {
  const { results } = await db
    .prepare(
      `SELECT d.*, (u.id IS NOT NULL) AS user_exists
         FROM account_directory d LEFT JOIN user u ON u.id = d.user_id
        WHERE d.user_id > ?1 ORDER BY d.user_id LIMIT ?2`,
    )
    .bind(after, limit)
    .all<RawRow & { user_exists: number }>();
  return results.map((r) => ({ ...toRow(r), userExists: r.user_exists === 1 }));
}

interface OperatorRow extends RawRow {
  email: string;
  name: string | null;
  dump_at: number | null;
  dump_bytes: number | null;
  dump_checked_at: number | null;
  dump_tried_at: number | null;
  dump_error: string | null;
}

/** The columns the operator's view of an account joins and reads; see `toAccount`. */
const OPERATOR_SELECT = `SELECT d.*, u.email, u.name
         FROM user u JOIN account_directory d ON d.user_id = u.id`;

const toAccount = (r: OperatorRow): OperatorAccount => ({
  userId: r.user_id,
  email: r.email,
  name: r.name,
  createdAt: r.created_at,
  noteCount: r.note_count,
  storageBytes: r.storage_bytes,
  lastActiveAt: r.last_active_at,
  dump: { at: r.dump_at, bytes: r.dump_bytes, checkedAt: r.dump_checked_at, triedAt: r.dump_tried_at, error: r.dump_error },
});

/**
 * The list's statement, as text, so `migrations.test.ts` can `EXPLAIN QUERY PLAN` it
 * against a database built from the migrations and pin that it walks `user`'s email
 * index and finds each directory row by its key. Binds: the email to start after (`''`
 * for the first page), the search lowercased or null, and the limit.
 */
export const OPERATOR_PAGE_SQL = `${OPERATOR_SELECT}
        WHERE d.deleted_at IS NULL
          AND u.email > ?1
          AND (?2 IS NULL OR instr(lower(u.email), ?2) > 0 OR instr(lower(u.name), ?2) > 0)
        ORDER BY u.email LIMIT ?3`;

/**
 * Each sort but the address's, as the expression the rows are ordered by. Never null, so
 * a page's last value can be the next page's cursor and compared with `<` and `=`: the
 * two that can be null (an account that has never written, or never been dumped) take a
 * value past every real one in whichever direction is asked for, so they are last both
 * ways. Last, not first, because a column of "Never" at the top of "newest first" would
 * push every answer to the question below the fold.
 */
const SORT_KEY: Record<Exclude<OperatorSort, 'email'>, Record<OperatorSortDir, string>> = {
  created: { asc: 'd.created_at', desc: 'd.created_at' },
  notes: { asc: 'd.note_count', desc: 'd.note_count' },
  size: { asc: 'd.storage_bytes', desc: 'd.storage_bytes' },
  active: { asc: `COALESCE(d.last_active_at, ${Number.MAX_SAFE_INTEGER})`, desc: 'COALESCE(d.last_active_at, -1)' },
  dump: { asc: `COALESCE(d.dump_at, ${Number.MAX_SAFE_INTEGER})`, desc: 'COALESCE(d.dump_at, -1)' },
};

/**
 * The list's statement in any other order than the default, as text for the same reason
 * `OPERATOR_PAGE_SQL` is. Built from the fixed pieces above and nothing the request
 * says. Binds as that statement's: the cursor's email (`''` when there is none), the
 * search or null, the limit; and, after the first page of a sort by a column, the
 * cursor's value as `?4`.
 *
 * Ties go by email A to Z in either direction, so the many accounts with no notes read as
 * an address book, not one backwards; that is why the cursor is the value and the email,
 * and the comparison is spelt out rather than a row value's `<`.
 */
export function operatorPageSql(sort: OperatorSort, dir: OperatorSortDir, cursor: boolean): string {
  const filter = `d.deleted_at IS NULL
          AND (?2 IS NULL OR instr(lower(u.email), ?2) > 0 OR instr(lower(u.name), ?2) > 0)`;
  if (sort === 'email') {
    if (dir === 'asc') return OPERATOR_PAGE_SQL;
    // The first page names no `?1` and is bound `''` all the same: a parameter is in range
    // up to the highest one named, so every first page binds the same three.
    return `${OPERATOR_SELECT}
        WHERE ${filter}${cursor ? '\n          AND u.email < ?1' : ''}
        ORDER BY u.email DESC LIMIT ?3`;
  }
  const key = SORT_KEY[sort][dir];
  const op = dir === 'asc' ? '>' : '<';
  return `SELECT d.*, u.email, u.name, ${key} AS sort_key
         FROM user u JOIN account_directory d ON d.user_id = u.id
        WHERE ${filter}${cursor ? `
          AND (${key} ${op} ?4 OR (${key} = ?4 AND u.email > ?1))` : ''}
        ORDER BY ${key} ${dir.toUpperCase()}, u.email LIMIT ?3`;
}

/** A cursor `listOperatorAccounts` did not write, which the route answers 400. */
export class OperatorCursorError extends Error {}

/**
 * The dump run's two statements (`dumpStores` in lib/backups.ts), as text, beside the
 * list's for the same reason: `migrations.test.ts` plans them against a database built
 * from the migrations and pins that they drive from the directory and find each user by
 * id, so the email index the list walks leaves them alone. Here rather than in backups.ts
 * because that module reaches the store client, which the node test cannot load. Binds:
 * `due` takes the day's midnight and the budget; `status` the stale threshold and the
 * list cap, twice.
 */
export const DUMP_SQL = {
  due: `SELECT d.user_id, d.dump_at, d.dump_mark
       FROM account_directory d JOIN user u ON u.id = d.user_id
      WHERE d.deleted_at IS NULL AND (d.dump_tried_at IS NULL OR d.dump_tried_at < ?1)
      ORDER BY d.dump_error IS NOT NULL, d.dump_tried_at IS NOT NULL, d.dump_tried_at, d.user_id
      LIMIT ?2`,
  status: `WITH live AS (
       SELECT d.user_id, d.dump_error, d.dump_tried_at, COALESCE(d.dump_checked_at, d.created_at) < ?1 AS stale
         FROM account_directory d JOIN user u ON u.id = d.user_id
        WHERE d.deleted_at IS NULL)
     SELECT (SELECT COUNT(*) FROM live) AS accounts,
            (SELECT COUNT(*) FROM live WHERE dump_error IS NOT NULL) AS failing_count,
            (SELECT COUNT(*) FROM live WHERE stale) AS stale_count,
            (SELECT json_group_array(json_object('userId', user_id, 'error', dump_error, 'triedAt', dump_tried_at))
               FROM (SELECT * FROM live WHERE dump_error IS NOT NULL ORDER BY dump_tried_at DESC, user_id LIMIT ?2)) AS failing,
            (SELECT json_group_array(user_id)
               FROM (SELECT user_id FROM live WHERE stale ORDER BY user_id LIMIT ?2)) AS stale`,
};

/**
 * A page of live accounts for the operator page (MAK-171, part 5), with the email from
 * `user` and the daily backup's record of each (migration 0037). Live only: a
 * tombstoned row is the sweep's.
 *
 * By email, A to Z, unless `sort` says otherwise, and only those whose email or name
 * holds `search` when there is one. The default was once the only order, ordered by
 * activity before that: an order that moved every hour as the sweep rewrote activity,
 * and read as two orders spliced together (a column of "3 hours ago" that became "Made
 * 18 hours ago" partway down). An address is where an operator looks for one account,
 * and it stays put, so it is still what the page opens on; the other columns sort when
 * their header is pressed, for the questions an address cannot answer (who joined this
 * week, whose store is largest, whose dump is oldest).
 *
 * By email, the email is the cursor on its own (unique in `user`): a page starts after
 * the last email the previous one ended on. The walk is `user`'s unique email index from
 * that email, with each account's directory row found by its key, and `LIMIT` stops it:
 * a page reads about fifty rows of each table however many accounts the instance holds.
 * Emails sort as stored, byte for byte; Better Auth lowercases an address when it makes
 * an account, so that is alphabetical. Backwards, the same index is walked from its end.
 *
 * By any other column, the cursor is the last row's value and email (`value:email`; the
 * value is an integer, so the first colon is the one between them), and no index serves
 * the order: every live row is read and sorted for each page. That is a row per account
 * of each table, the same as a search that matches little already costs, for a page an
 * operator opens a few times a day. An index per column was the alternative, and each
 * one on this table changes the plans of the sweep's and the dump run's statements too
 * (see `migrations.test.ts`); worth it when an instance has enough accounts to notice.
 *
 * A search is a substring of the email or the name, because the part of an address an
 * operator remembers is as often the domain as the start. It is `instr` over `lower`, not
 * `LIKE`: D1 refuses a `LIKE` pattern over fifty bytes, which a pasted address passes
 * (found in review, as a 500), and `instr` has no pattern, so `%` and `_` are only
 * themselves. It matches in either case for ASCII letters only, since SQLite's `lower`
 * folds no others: "é" does not find "É", and the search is lowered the same way so that
 * an "É" typed still finds itself. No index serves a substring, so a search walks the same
 * index and tests each row until it has a page: a search that matches little reads every
 * `user` row, and the directory only for the rows that match.
 *
 * A row whose email or sorted value changed between pages can appear twice or not at
 * all, which the page dedupes by id and the five-minute refetch corrects.
 */
export async function listOperatorAccounts(
  db: D1Database,
  after = '',
  limit: number = OPERATOR_PAGE_SIZE,
  search = '',
  sort: OperatorSort = 'email',
  dir: OperatorSortDir = 'asc',
): Promise<OperatorAccountsPage> {
  const term = search.trim();
  // ASCII letters only, as SQLite's `lower` does to the columns it is compared with.
  const needle = term ? term.replace(/[A-Z]/g, (c) => c.toLowerCase()) : null;
  if (sort === 'email') {
    const { results } = await db.prepare(operatorPageSql(sort, dir, after !== '')).bind(after, needle, limit).all<OperatorRow>();
    const last = results[results.length - 1];
    return { accounts: results.map(toAccount), next: results.length === limit && last ? last.email : null };
  }
  let binds: unknown[] = ['', needle, limit];
  if (after) {
    const colon = after.indexOf(':');
    const value = Number(after.slice(0, colon));
    if (colon < 1 || !Number.isSafeInteger(value)) throw new OperatorCursorError('Not a cursor this list wrote');
    binds = [after.slice(colon + 1), needle, limit, value];
  }
  const { results } = await db
    .prepare(operatorPageSql(sort, dir, after !== ''))
    .bind(...binds)
    .all<OperatorRow & { sort_key: number }>();
  const last = results[results.length - 1];
  return { accounts: results.map(toAccount), next: results.length === limit && last ? `${last.sort_key}:${last.email}` : null };
}

/** One live account's row as the operator's list shows it, or null for an id the directory does not hold live. */
export async function operatorAccountRow(db: D1Database, userId: string): Promise<OperatorAccount | null> {
  const row = await db.prepare(`${OPERATOR_SELECT} WHERE d.user_id = ?1 AND d.deleted_at IS NULL`).bind(userId).first<OperatorRow>();
  return row ? toAccount(row) : null;
}
