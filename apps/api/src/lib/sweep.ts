import { dropDirectoryRowStatement, listDirectory, recordDirectoryUsageStatement, type DirectoryRow } from './directory.js';
import { storeFor } from './store-client.js';
import type { StoreUsage } from '../store/user-store.js';
import type { Env } from '../types.js';

/**
 * The walk over every account's note store, a batch at a time.
 *
 * Objects are lazy: one wakes when a request names it, and otherwise sits with whatever
 * schema and rows it last had. Three things depend on someone waking each of them on a
 * schedule rather than waiting for its owner:
 *
 *   - A schema file appended to `SCHEMA` is applied on an object's next wake. Without this
 *     walk, a migration that fails for one account is found by that account's owner, from
 *     a broken page, whenever they next open the app. With it, every object is woken
 *     within a day of a deploy and a failure is a line in the log with the user id on it.
 *   - The one-time copy from D1 runs here, for every account whose object says it has
 *     not run yet. Nothing on the request path reads D1 for notes, so an account that
 *     predates the cutover has its rows only once this walk, or the operator's route,
 *     has copied them; the runbook runs the walk the minute the deploy lands.
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
 * One invocation walks `BATCH` accounts, not all of them. Every call to a store and every
 * D1 query counts against the subrequests an invocation may make — fifty on Workers Free
 * — and an account costs one or two store calls, so a walk over more than a few dozen has
 * to span invocations. Where it got to is kept in D1 (`_unbent_meta`), each invocation
 * continues from there, and a batch that comes up short is the end of a pass: the next
 * invocation starts from the top. The cron in wrangler.toml runs hourly, so a pass over
 * an instance with a few hundred accounts completes within the day; the operator's route
 * runs one batch per call and says whether the pass is done, so a runbook loops on it.
 * The D1 side is kept to a handful of queries per batch: the page is one, its users'
 * existence rides on a join, and the writes go out as one `batch`.
 *
 * The walk starts by healing the directory. An account created between the directory
 * migration and the Worker that writes rows for new accounts, or whose row write failed,
 * has none, and would otherwise be invisible to everything here.
 *
 * One account's failure does not stop the batch; it is logged with the id and counted in
 * `failed`, and the next pass tries again. An account whose copy paused at its query
 * budget is counted in `deferred` rather than `failed`, since the next pass, or the
 * operator's route, continues it; one whose copy could not be verified is named in
 * `mismatched` every pass until the operator deals with it.
 */
export interface SweepReport {
  visited: number;
  /** Accounts whose object reported the copy from D1 done. */
  migrated: number;
  /** Accounts this batch copied from D1. */
  copied: number;
  /** Accounts whose copy failed verification; the operator's `sql` route is how to look, `copy` with `retry` the way on. */
  mismatched: string[];
  wiped: number;
  dropped: number;
  failed: string[];
  /** Accounts whose copy paused at its budget, or whose store asked to be called again. */
  deferred: string[];
  /** Whether this batch reached the end of the directory. */
  done: boolean;
  ms: number;
}

/**
 * Accounts per invocation. Each is at most two store calls — `usage` and, for an account
 * not yet copied, `copyFromD1`, or `wipe` and `usage` for a deleted one — and the D1
 * queries the copy itself makes are the object's, not this invocation's. With the
 * batch's own four D1 queries, twenty is forty-four of the Free plan's fifty.
 */
export const BATCH = 20;

const CURSOR_KEY = 'store_sweep_cursor';

async function readCursor(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT value FROM _unbent_meta WHERE key = ?1`).bind(CURSOR_KEY).first<{ value: string }>();
  return row?.value ?? '';
}

export async function sweepStores(env: Pick<Env, 'DB' | 'USER_STORE' | 'STORE_JURISDICTION' | 'STORE_FREEZE_D1'>): Promise<SweepReport> {
  const started = Date.now();
  const report: SweepReport = { visited: 0, migrated: 0, copied: 0, mismatched: [], wiped: 0, dropped: 0, failed: [], deferred: [], done: false, ms: 0 };

  // A preview Worker shares the dev instance's D1 but has objects of its own, empty
  // copies at best, so nothing this walk could learn there is worth writing to dev's
  // directory — and most of what it writes would be wrong: it would drop dev's row for
  // an account gone on dev after wiping the preview's object rather than dev's, leaving
  // dev's object with no row and so nothing that could ever wipe it; it would move dev's
  // cursor; and it would freeze accounts dev is still writing. The flag that says a
  // preview may not write the freeze mark says it may not write the directory at all.
  if (env.STORE_FREEZE_D1 === '0') {
    console.log('[store] sweep skipped: this Worker may not write the shared directory (STORE_FREEZE_D1=0)');
    return { ...report, done: true };
  }

  // Heal first: every user has a row, so every account is reachable from here.
  await env.DB.prepare(
    `INSERT INTO account_directory (user_id, created_at)
     SELECT id, unixepoch() * 1000 FROM user WHERE true
     ON CONFLICT(user_id) DO NOTHING`,
  ).run();

  const after = await readCursor(env.DB);
  const rows = await listDirectory(env.DB, after, BATCH);
  const writes: D1PreparedStatement[] = [];
  for (const row of rows) {
    report.visited += 1;
    try {
      await sweepOne(env, row, report, writes);
    } catch (err) {
      if (isDeferral(err)) {
        report.deferred.push(row.userId);
        continue;
      }
      console.error(`[store] sweep failed for user=${row.userId}:`, err);
      report.failed.push(row.userId);
    }
  }

  report.done = rows.length < BATCH;
  const next = report.done ? '' : rows[rows.length - 1]!.userId;
  writes.push(
    env.DB.prepare(`INSERT INTO _unbent_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(CURSOR_KEY, next),
  );
  await env.DB.batch(writes);

  report.ms = Date.now() - started;
  console.log(
    `[store] sweep visited=${report.visited} migrated=${report.migrated} copied=${report.copied} mismatched=${report.mismatched.length} wiped=${report.wiped} dropped=${report.dropped} deferred=${report.deferred.length} failed=${report.failed.length} done=${report.done} ms=${report.ms}`,
  );
  return report;
}

/** The runtime's transient failures carry `retryable` as an own property, which RPC keeps. */
function isDeferral(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { retryable?: unknown }).retryable === true;
}

async function sweepOne(
  env: Pick<Env, 'DB' | 'USER_STORE' | 'STORE_JURISDICTION' | 'STORE_FREEZE_D1'>,
  row: DirectoryRow & { userExists: boolean },
  report: SweepReport,
  writes: D1PreparedStatement[],
): Promise<void> {
  const store = storeFor(env, row.userId);
  const gone = row.deletedAt !== null || !row.userExists;
  if (gone) {
    await store.wipe();
    report.wiped += 1;
    // The row goes once the object is empty and the user row is too. A tombstone whose
    // user row is still there — a deletion that wiped the store and then failed to remove
    // the user — stays, and is wiped again each pass, because the heal above would
    // otherwise re-create a live row for an account that is empty. `stats` on a wiped
    // object reports without rebuilding the schema; anything else would leave a fresh
    // empty database behind for a deleted account.
    if (!row.userExists && (await store.usage()).wiped) {
      writes.push(dropDirectoryRowStatement(env.DB, row.userId));
      report.dropped += 1;
    }
    return;
  }
  // Waking the object is the point: a pending migration runs in its constructor, and a
  // failure there surfaces here as this row's error. `usage`, not `stats`: this runs
  // every hour for every account, and must not scan a table.
  let usage: StoreUsage = await store.usage();
  if (!usage.migratedFromD1) {
    // Not copied yet: an account from before the cutover the walk has not reached, or
    // a new one, whose copy finds nothing and marks it. One call; the object spends its
    // own query budget on D1 and answers `paused` if it runs out, and the next pass
    // continues from where it committed.
    const copy = await store.copyFromD1();
    usage = copy.usage;
    if (copy.status === 'done') {
      report.copied += 1;
    } else if (copy.status === 'paused') {
      report.deferred.push(row.userId);
    } else if (copy.status === 'mismatch') {
      console.error(`[store] copy mismatch for user=${row.userId}: ${copy.reason}; inspect with the sql route, then copy with retry`);
      report.mismatched.push(row.userId);
    }
  }
  writes.push(
    recordDirectoryUsageStatement(env.DB, row.userId, {
      storageBytes: usage.databaseSize,
      noteCount: usage.notes,
      copied: usage.migratedFromD1,
    }),
  );
  if (usage.migratedFromD1) report.migrated += 1;
}
