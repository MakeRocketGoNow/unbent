/**
 * The account directory: one D1 row per account, for what the control plane needs to
 * know about the per-account note stores without opening one. See migration 0030 for
 * why it exists and why it has no foreign key to `user`.
 *
 * Nothing here runs on the request path. A row is written when an account is created,
 * tombstoned when it is deleted, and otherwise touched only by the daily sweep, which
 * walks the directory and asks each object for its `stats`. The counts it carries are
 * therefore as fresh as the last sweep, which is right for a cross-account view and
 * wrong for anything a user is shown about their own account — that comes from the
 * object.
 */

export interface DirectoryRow {
  userId: string;
  createdAt: number;
  migratedAt: number | null;
  storageBytes: number;
  noteCount: number;
  lastActiveAt: number | null;
  deletedAt: number | null;
}

interface RawRow {
  user_id: string;
  created_at: number;
  migrated_at: number | null;
  storage_bytes: number;
  note_count: number;
  last_active_at: number | null;
  deleted_at: number | null;
}

const toRow = (r: RawRow): DirectoryRow => ({
  userId: r.user_id,
  createdAt: r.created_at,
  migratedAt: r.migrated_at,
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

export async function dropDirectoryRow(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM account_directory WHERE user_id = ?1`).bind(userId).run();
}

/** What the sweep writes back after asking an object for its stats. */
export async function recordDirectoryUsage(
  db: D1Database,
  userId: string,
  usage: { storageBytes: number; noteCount: number; migrated: boolean },
): Promise<void> {
  await db
    .prepare(
      `UPDATE account_directory
          SET storage_bytes = ?2, note_count = ?3,
              migrated_at = CASE WHEN ?4 THEN COALESCE(migrated_at, ?5) ELSE migrated_at END
        WHERE user_id = ?1`,
    )
    .bind(userId, usage.storageBytes, usage.noteCount, usage.migrated ? 1 : 0, Date.now())
    .run();
}

export async function directoryRow(db: D1Database, userId: string): Promise<DirectoryRow | null> {
  const row = await db.prepare(`SELECT * FROM account_directory WHERE user_id = ?1`).bind(userId).first<RawRow>();
  return row ? toRow(row) : null;
}

/** Every row, for the sweep. Paged by user id so an instance with many accounts is walked in bounded pieces. */
export async function listDirectory(db: D1Database, after = '', limit = 200): Promise<DirectoryRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM account_directory WHERE user_id > ?1 ORDER BY user_id LIMIT ?2`)
    .bind(after, limit)
    .all<RawRow>();
  return results.map(toRow);
}
