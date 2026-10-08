import type { OperatorAccount, OperatorAccountsPage } from '@unbent/shared';
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
 * wrong for anything a user is shown about their own account — that comes from the
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
 * from, and it is only removed by `dropDirectoryRow` once the object reports empty. An
 * account with no row is never wiped by anything — see `sweepStores` — so this is also
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
 * exists — on the same query, so a batch of accounts costs one D1 call to list rather
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
 * for the first page), the search's `LIKE` pattern or null, and the limit.
 */
export const OPERATOR_PAGE_SQL = `${OPERATOR_SELECT}
        WHERE d.deleted_at IS NULL
          AND u.email > ?1
          AND (?2 IS NULL OR u.email LIKE ?2 ESCAPE '\\' OR u.name LIKE ?2 ESCAPE '\\')
        ORDER BY u.email LIMIT ?3`;

/**
 * The dump run's two statements (`dumpStores` in lib/backups.ts), as text, beside the
 * list's for the same reason: `migrations.test.ts` plans them against a database built
 * from the migrations and pins that they drive from the directory and find each user by
 * id, so the email index the list walks leaves them alone. Here rather than in backups.ts
 * because that module reaches the store client, which the node test cannot load. Binds: `due` takes the day's
 * midnight and the budget; `status` the stale threshold and the list cap, twice.
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
 * `user` and the daily backup's record of each (migration 0037). Live only — a
 * tombstoned row is the sweep's.
 *
 * By email, A to Z, and only those whose email or name holds `search` when there is one.
 * The list used to be ordered by activity, newest first, with an account that had never
 * written standing in by its creation: an order that moved every hour as the sweep
 * rewrote activity, read as two orders spliced together (a column of "3 hours ago" that
 * became "Made 18 hours ago" partway down), and gave an operator looking for one account
 * nowhere to look but the whole list. An address is where they look, and it stays put.
 *
 * Email is unique in `user`, so it is the cursor on its own: a page starts after the
 * last email the previous one ended on. The walk is `user`'s unique email index from that
 * email, with each account's directory row found by its key, and `LIMIT` stops it — a
 * page reads about fifty rows of each table however many accounts the instance holds. Emails sort as
 * stored, byte for byte; Better Auth lowercases an address when it makes an account, so that is alphabetical.
 *
 * A search is a substring of the email or the name, because the part of an address an
 * operator remembers is as often the domain as the start. It matches in either case for
 * ASCII letters only: `LIKE` folds no others, so "é" does not find "É". No index serves a
 * substring, so a search walks the same index and tests each row until it has a page: a
 * search that matches little reads every `user` row, and the directory only for the rows
 * that match. That is accepted: a row per account, for a page an operator opens a few
 * times a day. `%` and `_` in the search are escaped, so they match themselves.
 *
 * A row whose email changed between pages can appear twice or not at all, which the
 * page dedupes by id and the five-minute refetch corrects. One statement for the first
 * page and the next, since `email > ''` is a seek from the start of the index.
 */
export async function listOperatorAccounts(
  db: D1Database,
  after = '',
  limit: number = OPERATOR_PAGE_SIZE,
  search = '',
): Promise<OperatorAccountsPage> {
  const term = search.trim();
  const pattern = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const { results } = await db.prepare(OPERATOR_PAGE_SQL).bind(after, pattern, limit).all<OperatorRow>();
  const last = results[results.length - 1];
  return { accounts: results.map(toAccount), next: results.length === limit && last ? last.email : null };
}

/** One live account's row as the operator's list shows it, or null for an id the directory does not hold live. */
export async function operatorAccountRow(db: D1Database, userId: string): Promise<OperatorAccount | null> {
  const row = await db.prepare(`${OPERATOR_SELECT} WHERE d.user_id = ?1 AND d.deleted_at IS NULL`).bind(userId).first<OperatorRow>();
  return row ? toAccount(row) : null;
}
