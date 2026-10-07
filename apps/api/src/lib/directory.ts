import type { OperatorAccount, OperatorAccountsPage } from '@unbent/shared';

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

export async function dropDirectoryRow(db: D1Database, userId: string): Promise<void> {
  await dropDirectoryRowStatement(db, userId).run();
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
  restore_at: number | null;
  restore_to_at: number | null;
  restore_undo: string | null;
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
  restore: r.restore_at === null || r.restore_to_at === null ? null : { at: r.restore_at, toAt: r.restore_to_at, undo: r.restore_undo },
});

/** The most accounts one page of the operator's list carries; the route clamps to it. */
export const OPERATOR_PAGE_MAX = 200;

/**
 * A page of live accounts for the operator page (MAK-171, part 5), with the email from
 * `user`, the daily backup's record of each (migration 0037) and the last wind-back
 * (0038). Live only — a tombstoned row is the sweep's.
 *
 * Newest activity first, where activity is the newest write the sweep recorded, else the
 * account's creation: the order the page shows, so a page is the top of that order and
 * not an arbitrary slice of it. The first version walked the table by user id and sorted
 * on the client, which only works while the client reads every page; a list that scales
 * reads the first page and asks for the next. The cursor is the last row's activity and
 * id together (`<ms>:<user id>`), a keyset, so a page is the rows past that pair and
 * never an offset that a row inserted meanwhile would shift. There is no index on the
 * expression, by the directory's rule (0037), so each page scans the live rows of the
 * directory — one row per account, not per note, so thousands at most, and read only
 * when an operator opens the list.
 */
export async function listOperatorAccounts(db: D1Database, after = '', limit = 50): Promise<OperatorAccountsPage> {
  const cursor = parseCursor(after);
  const { results } = await db
    .prepare(
      `${OPERATOR_SELECT}
        WHERE d.deleted_at IS NULL
          AND (?1 IS NULL OR COALESCE(d.last_active_at, d.created_at) < ?1 OR (COALESCE(d.last_active_at, d.created_at) = ?1 AND d.user_id < ?2))
        ORDER BY active_at DESC, d.user_id DESC LIMIT ?3`,
    )
    .bind(cursor?.activeAt ?? null, cursor?.userId ?? '', limit)
    .all<OperatorRow & { active_at: number }>();
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

/** One live account as the operator's list shows it, or null for an id the directory does not hold live. */
export async function operatorAccount(db: D1Database, userId: string): Promise<OperatorAccount | null> {
  const row = await db.prepare(`${OPERATOR_SELECT} WHERE d.user_id = ?1 AND d.deleted_at IS NULL`).bind(userId).first<OperatorRow>();
  return row ? toAccount(row) : null;
}

/**
 * Records a wind-back of the account's store to a moment, for the operator page to offer
 * its undo from (migration 0038). Only a wind-back to a moment is recorded, and a
 * restore to a bookmark clears the record (`clearRestore`): a bookmark restore is an
 * undo, and the one thing its own undo bookmark would reverse is the undo itself —
 * offered after a reload as "Undo the wind-back", pressing it would have reapplied the
 * wind-back the operator had just taken back (found in review). Recorded with a null
 * `undo` too, so the page can say the bookmark did not survive rather than nothing.
 * Called after the restore has been applied — the route clears the record before
 * scheduling one, so a restore that never gets here leaves nothing rather than an older
 * wind-back — and never allowed to fail the restore's answer: the bookmark is in the
 * answer and the Worker's log whether or not this row is written.
 *
 * One row, so only the latest wind-back is undoable from the page: wind back twice and
 * undo the second, and the first one's bookmark is in the Worker's log alone.
 */
export async function recordRestore(db: D1Database, userId: string, restore: { at: number; toAt: number; undo: string | null }): Promise<void> {
  await db
    .prepare(`UPDATE account_directory SET restore_at = ?2, restore_to_at = ?3, restore_undo = ?4 WHERE user_id = ?1`)
    .bind(userId, restore.at, restore.toAt, restore.undo)
    .run();
}

/**
 * Forgets the account's recorded wind-back, before every restore and every load (see
 * those routes) and so after a restore to a bookmark, which is what undoes one, and after
 * a load, whose own way back is the before-load dump it lists. Left in place, the record
 * would offer to wind back to a moment from before either, and the confirm would not say
 * that the undo, the newer wind-back or the loaded dump went with it.
 */
export async function clearRestore(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`UPDATE account_directory SET restore_at = NULL, restore_to_at = NULL, restore_undo = NULL WHERE user_id = ?1`).bind(userId).run();
}
