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
const OPERATOR_SELECT = `SELECT d.*, u.email, u.name, COALESCE(d.last_active_at, d.created_at) AS active_at
         FROM account_directory d JOIN user u ON u.id = d.user_id`;

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
 * The list's two statements, as text, so `migrations.test.ts` can `EXPLAIN QUERY PLAN`
 * them against a database built from the migrations and pin that they take 0039's index
 * while the dump run's statements do not. Binds: `first` takes the limit; `withCursor`
 * takes the cursor's activity, its id and the limit.
 */
export const OPERATOR_PAGE_SQL = {
  first: `${OPERATOR_SELECT} WHERE d.deleted_at IS NULL ORDER BY COALESCE(d.last_active_at, d.created_at) DESC, d.user_id DESC LIMIT ?1`,
  withCursor: `${OPERATOR_SELECT}
        WHERE d.deleted_at IS NULL
          AND COALESCE(d.last_active_at, d.created_at) <= ?1
          AND (COALESCE(d.last_active_at, d.created_at), d.user_id) < (?1, ?2)
        ORDER BY COALESCE(d.last_active_at, d.created_at) DESC, d.user_id DESC LIMIT ?3`,
};

/**
 * The dump run's two statements (`dumpStores` in lib/backups.ts), as text, beside the
 * list's for the same reason: `migrations.test.ts` plans them against a database built
 * from the migrations and pins that 0039's index, which they could take if it were
 * partial, leaves them alone. Here rather than in backups.ts because that module reaches
 * the store client, which the node test cannot load. Binds: `due` takes the day's
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
 * `user` and the daily backup's record of each (migration 0037). Live only — a tombstoned row is the sweep's.
 *
 * Newest activity first, where activity is the newest write the sweep recorded, else the
 * account's creation: the order the page shows, so a page is the top of that order and
 * not an arbitrary slice of it. The first version walked the table by user id and sorted
 * on the client, which only works while the client reads every page; a list that scales
 * reads the first page and asks for the next. The cursor is the last row's activity and
 * id together (`<ms>:<user id>`), compared as one row value so the planner can seek to
 * it, and ties on activity — every account 0030 backfilled shares one `created_at` —
 * are broken by the id. Migration 0039's expression index is on exactly this spelling.
 * The first page is the top of the index and `LIMIT` rows; a later page seeks to the
 * cursor's activity, which takes a scalar bound on the leading expression beside the
 * row-value comparison — SQLite does not seek a DESC row-value range on its own, and with
 * the comparison alone the plan was a scan from the top on every page (found in review).
 * Two statements rather than one with `?1 IS NULL OR`, since the `OR` is what turned the
 * seek into a scan. Within one tied activity value the seek lands at the top of the tie
 * and the row-value comparison filters the ids at or above the cursor, so paging through
 * a large tie reads its earlier pages again; the accounts 0030 backfilled are one such
 * tie, and a few thousand rows of it is nothing. Being an expression index, and not a
 * partial one, no other statement on the table picks it up (AGENTS.md; the migration says
 * why not partial). `migrations.test.ts` pins the plans: `SEARCH d USING INDEX
 * idx_account_directory_activity (<expr><?)` for a page with a cursor, `SCAN d USING
 * INDEX …` for the first, and the dump run's two statements untouched by it.
 *
 * The cursor is a position in an order that moves: the sweep rewrites activity hourly.
 * An account that becomes active after a page was read sits above its cursor and is
 * not on the next page, until the list's five-minute refetch reads from the top again;
 * one whose activity went down (a wind-back) can appear on a later page a second time,
 * which the page dedupes by id. Both are accepted: the alternative is a snapshot of ids
 * held across pages, for a list an operator reads a few times a day.
 */
export async function listOperatorAccounts(db: D1Database, after = '', limit: number = OPERATOR_PAGE_SIZE): Promise<OperatorAccountsPage> {
  const cursor = parseCursor(after);
  const statement = cursor
    ? db.prepare(OPERATOR_PAGE_SQL.withCursor).bind(cursor.activeAt, cursor.userId, limit)
    : db.prepare(OPERATOR_PAGE_SQL.first).bind(limit);
  const { results } = await statement.all<OperatorRow & { active_at: number }>();
  const last = results[results.length - 1];
  return { accounts: results.map(toAccount), next: results.length === limit && last ? `${last.active_at}:${last.user_id}` : null };
}

/** `<ms>:<user id>` as `listOperatorAccounts` hands it out, or null for the first page or anything else. */
function parseCursor(after: string): { activeAt: number; userId: string } | null {
  const at = after.indexOf(':');
  if (at === -1) return null;
  const activeAt = Number(after.slice(0, at));
  const userId = after.slice(at + 1);
  return Number.isFinite(activeAt) && userId ? { activeAt, userId } : null;
}

/** One live account's row as the operator's list shows it, or null for an id the directory does not hold live. */
export async function operatorAccountRow(db: D1Database, userId: string): Promise<OperatorAccount | null> {
  const row = await db.prepare(`${OPERATOR_SELECT} WHERE d.user_id = ?1 AND d.deleted_at IS NULL`).bind(userId).first<OperatorRow>();
  return row ? toAccount(row) : null;
}
