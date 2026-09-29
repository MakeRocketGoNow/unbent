import { dropDirectoryRow, listDirectory, recordDirectoryUsage, type DirectoryRow } from './directory.js';
import { storeFor } from './store-client.js';
import type { Env } from '../types.js';

/**
 * The daily walk over every account's note store.
 *
 * Objects are lazy: one wakes when a request names it, and otherwise sits with whatever
 * schema and rows it last had. Three things depend on someone waking each of them on a
 * schedule rather than waiting for its owner:
 *
 *   - A schema file appended to `SCHEMA` is applied on an object's next wake. Without this
 *     walk, a migration that fails for one account is found by that account's owner, from
 *     a broken page, whenever they next open the app. With it, every object is woken
 *     within a day of a deploy and a failure is a line in the log with the user id on it.
 *     The same walk is what runs the one-time copy from D1 for every account after the
 *     cutover, so nobody's first open after it pays for the copy.
 *   - The directory's usage columns — bytes and notes per account, the cross-account view
 *     billing and limits read — are written here and nowhere on the request path.
 *   - An account whose deletion was interrupted between wiping the object and dropping the
 *     row, or whose `afterDelete` hook never ran, is finished here: a tombstoned row, or a
 *     row whose `user` row is gone, has its object wiped and, once the object reports
 *     itself empty, its row dropped.
 *
 * A row with no tombstone and a live user is never wiped, whatever its object holds. That
 * is the one invariant this must keep: the directory is the only thing that can turn a
 * wipe on, and only by saying the account is gone.
 *
 * One account's failure does not stop the walk; it is logged with the id and counted in
 * `failed`, and the next day's walk tries again. Run by the cron in index.ts and, on
 * demand after a deploy, by `POST /api/admin/store/sweep`.
 */
export interface SweepReport {
  visited: number;
  /** Accounts whose object reported the copy from D1 done. */
  migrated: number;
  wiped: number;
  dropped: number;
  failed: string[];
  ms: number;
}

async function userExists(db: D1Database, userId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS hit FROM user WHERE id = ?1`).bind(userId).first()) !== null;
}

export async function sweepStores(env: Pick<Env, 'DB' | 'USER_STORE' | 'STORE_JURISDICTION'>): Promise<SweepReport> {
  const started = Date.now();
  const report: SweepReport = { visited: 0, migrated: 0, wiped: 0, dropped: 0, failed: [], ms: 0 };
  let after = '';
  for (;;) {
    const rows = await listDirectory(env.DB, after);
    if (rows.length === 0) break;
    for (const row of rows) {
      report.visited += 1;
      try {
        await sweepOne(env, row, report);
      } catch (err) {
        console.error(`[store] sweep failed for user=${row.userId}:`, err);
        report.failed.push(row.userId);
      }
    }
    after = rows[rows.length - 1]!.userId;
  }
  report.ms = Date.now() - started;
  console.log(
    `[store] sweep visited=${report.visited} migrated=${report.migrated} wiped=${report.wiped} dropped=${report.dropped} failed=${report.failed.length} ms=${report.ms}`,
  );
  return report;
}

async function sweepOne(env: Pick<Env, 'DB' | 'USER_STORE' | 'STORE_JURISDICTION'>, row: DirectoryRow, report: SweepReport): Promise<void> {
  const store = storeFor(env, row.userId);
  const gone = row.deletedAt !== null || !(await userExists(env.DB, row.userId));
  if (gone) {
    await store.wipe();
    report.wiped += 1;
    // `stats` on a wiped object reports without rebuilding the schema; anything else
    // would leave a fresh empty database behind for a deleted account.
    if ((await store.stats()).wiped) {
      await dropDirectoryRow(env.DB, row.userId);
      report.dropped += 1;
    }
    return;
  }
  // Waking the object is the point: a pending migration or the copy from D1 runs in its
  // constructor, and a failure there surfaces here as this row's error.
  const stats = await store.stats();
  await recordDirectoryUsage(env.DB, row.userId, {
    storageBytes: stats.databaseSize,
    noteCount: stats.counts.notes,
    migrated: stats.migratedFromD1,
  });
  if (stats.migratedFromD1) report.migrated += 1;
}
