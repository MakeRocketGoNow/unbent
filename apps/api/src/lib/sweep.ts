import { deleteKeys } from './blobs.js';
import { dropDirectoryRowStatement, listDirectory, recordDirectoryUsageStatement, type DirectoryRow } from './directory.js';
import { storeFor } from './store-client.js';
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
 *   - The directory's usage columns — bytes and notes per account, the cross-account view
 *     billing and limits read — are written here and nowhere on the request path.
 *   - An account whose deletion was interrupted between wiping the object and dropping the
 *     row, or whose `afterDelete` hook never ran, is finished here: a tombstoned row, or a
 *     row whose `user` row is gone, has its object wiped and, once the object reports
 *     itself empty, its row dropped.
 *   - The files an account has deleted leave R2 here, and nowhere else (MAK-171, part 1).
 *     Emptying the trash and deleting a file tombstone the object's key in the store
 *     instead of deleting it, so a store wound back finds its files; this walk asks each
 *     store for the keys past the thirty-five days (`DeletedBlobs`), deletes them from R2
 *     in one call, and tells the store to forget them.
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
 * `restart` starts the batch from the top of the directory instead of the cursor. The
 * deploy's pass sends it on its first call: the cursor is the cron's, and usually sits
 * partway through the directory, so a pass that resumed from it would end at the bottom
 * having never visited the accounts above it — and a migration that broke one of those
 * would go green. The cron never sends it, and carries on from wherever the pass left
 * the cursor.
 *
 * The walk starts by healing the directory. An account created between the directory
 * migration and the Worker that writes rows for new accounts, or whose row write failed,
 * has none, and would otherwise be invisible to everything here.
 *
 * One account's failure does not stop the batch; it is logged with the id and counted in
 * `failed`, and the next pass tries again. An account whose store asked to be called
 * again — the runtime's own transient failures carry `retryable` — is counted in
 * `deferred` rather than `failed`.
 */
export interface SweepReport {
  visited: number;
  wiped: number;
  dropped: number;
  /** Deleted files whose retention was up and whose objects this batch removed from R2. */
  blobsDeleted: number;
  /** Accounts with files due that this batch had no subrequests left to delete; the next walk of the directory takes them. */
  blobsDeferred: number;
  failed: string[];
  /** Accounts whose store asked to be called again; see `StoreUnavailable`. */
  deferred: string[];
  /** Whether this batch reached the end of the directory. */
  done: boolean;
  ms: number;
}

/**
 * Accounts per invocation. Each is at most two store calls — `sweepVisit`, or `wipe` and
 * `usage` for a deleted one. With the batch's own four D1 queries, twenty is forty-four
 * of the Free plan's fifty.
 */
export const BATCH = 20;

/**
 * What one invocation may make on the Free plan, and so what every instance's sweep is
 * sized to: every store call, D1 query and R2 call counts. Deleting an account's expired
 * files costs two more on top of its visit — the R2 delete and the store's `forgetBlobs`
 * — and a batch of twenty accounts that all had files due would be sixty-four. So the
 * expiry is budgeted: `mayExpire` is asked before each, against what the batch has spent
 * and the worst the accounts still ahead of it could cost, and an account that does not
 * fit is counted in `blobsDeferred` and asked again on the next walk of the directory —
 * which, with the cursor moving twenty accounts an hour, is later than the next hour; a
 * deletion that waits longer is the safe direction to err in. A live account
 * costs one, so slack grows as the batch proceeds: a batch of live accounts fits
 * thirteen expiries, late-weighted (pinned in sweep.test.ts). A deletion costs two and
 * asks for no expiry — a wiped store has no files — so the worst batch is forty-four.
 */
export const SUBREQUEST_BUDGET = 50;

/** The batch's own D1 queries: the heal, the cursor read, the page, and the final `batch` of writes. */
const D1_PER_BATCH = 4;

/** The most an account's visit can cost, before any expiry: `wipe` then `usage`. */
const WORST_PER_ACCOUNT = 2;

/**
 * Whether a batch that has made `spent` subrequests, with `ahead` accounts still to
 * visit, can afford the two an expiry costs and still finish the batch within the
 * budget whatever those accounts turn out to be. Pure, for the test.
 */
export function mayExpire(spent: number, ahead: number, budget = SUBREQUEST_BUDGET): boolean {
  return spent + 2 + ahead * WORST_PER_ACCOUNT <= budget;
}

const CURSOR_KEY = 'store_sweep_cursor';

async function readCursor(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT value FROM _unbent_meta WHERE key = ?1`).bind(CURSOR_KEY).first<{ value: string }>();
  return row?.value ?? '';
}

export async function sweepStores(
  env: Pick<Env, 'DB' | 'USER_STORE' | 'STORE_JURISDICTION' | 'STORE_SWEEP' | 'BLOBS'>,
  opts: { restart?: boolean } = {},
): Promise<SweepReport> {
  const started = Date.now();
  const report: SweepReport = { visited: 0, wiped: 0, dropped: 0, blobsDeleted: 0, blobsDeferred: 0, failed: [], deferred: [], done: false, ms: 0 };

  // A preview Worker shares the dev instance's D1 and its note stores (`script_name` in
  // wrangler.toml), so the directory and every object this walk would visit are dev's,
  // and dev's own sweep already walks them. A second walk from a preview would run a
  // PR's code over dev's accounts, move dev's cursor out from under it, and race it to
  // wipe and drop. Off by a var on the preview environment (wrangler.toml), and nowhere
  // else.
  if (env.STORE_SWEEP === '0') {
    console.log('[store] sweep skipped: this Worker may not write the shared directory (STORE_SWEEP=0)');
    return { ...report, done: true };
  }

  // Heal first: every user has a row, so every account is reachable from here.
  await env.DB.prepare(
    `INSERT INTO account_directory (user_id, created_at)
     SELECT id, unixepoch() * 1000 FROM user WHERE true
     ON CONFLICT(user_id) DO NOTHING`,
  ).run();

  const after = opts.restart ? '' : await readCursor(env.DB);
  const rows = await listDirectory(env.DB, after, BATCH);
  const writes: D1PreparedStatement[] = [];
  // The subrequests made so far, counted so the expiry can be budgeted; see `mayExpire`.
  // The D1 queries are all counted up front, including the `batch` at the end.
  const budget = { spent: D1_PER_BATCH };
  for (const [i, row] of rows.entries()) {
    report.visited += 1;
    try {
      await sweepOne(env, row, report, writes, budget, rows.length - i - 1);
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
    `[store] sweep visited=${report.visited} wiped=${report.wiped} dropped=${report.dropped} blobsDeleted=${report.blobsDeleted} blobsDeferred=${report.blobsDeferred} deferred=${report.deferred.length} failed=${report.failed.length} done=${report.done} ms=${report.ms}`,
  );
  return report;
}

/** The runtime's transient failures carry `retryable` as an own property, which RPC keeps. */
function isDeferral(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { retryable?: unknown }).retryable === true;
}

async function sweepOne(
  env: Pick<Env, 'DB' | 'USER_STORE' | 'STORE_JURISDICTION' | 'BLOBS'>,
  row: DirectoryRow & { userExists: boolean },
  report: SweepReport,
  writes: D1PreparedStatement[],
  budget: { spent: number },
  ahead: number,
): Promise<void> {
  const store = storeFor(env, row.userId);
  const gone = row.deletedAt !== null || !row.userExists;
  if (gone) {
    budget.spent += 1;
    await store.wipe();
    report.wiped += 1;
    // The row goes once the object is empty and the user row is too. A tombstone whose
    // user row is still there — a deletion that wiped the store and then failed to remove
    // the user — stays, and is wiped again each pass, because the heal above would
    // otherwise re-create a live row for an account that is empty. `stats` on a wiped
    // object reports without rebuilding the schema; anything else would leave a fresh
    // empty database behind for a deleted account.
    if (!row.userExists) {
      budget.spent += 1;
      if ((await store.usage()).wiped) {
        writes.push(dropDirectoryRowStatement(env.DB, row.userId));
        report.dropped += 1;
      }
    }
    return;
  }
  // Waking the object is the point: a pending migration runs in its constructor, and a
  // failure there surfaces here as this row's error. `sweepVisit`, not `stats`: this runs
  // every hour for every account, and must not scan a table. The visit also answers
  // which deleted files have waited their thirty-five days, so that the common case —
  // none — costs nothing beyond the call that was being made anyway.
  const now = Date.now();
  budget.spent += 1;
  const visit = await store.sweepVisit(now);
  writes.push(recordDirectoryUsageStatement(env.DB, row.userId, { storageBytes: visit.databaseSize, noteCount: visit.notes }));

  if (visit.expiredBlobs.length === 0) return;
  if (!mayExpire(budget.spent, ahead)) {
    report.blobsDeferred += 1;
    return;
  }
  // R2 first, then the store: a delete that lands and a forget that does not is asked for
  // again next visit, and deleting an absent object is a no-op. The reverse order would
  // leave an object in the bucket that nothing would ever ask about again. The keys are
  // at most one `delete()`'s worth, so this is one call (`deleteKeys` batches by the same
  // thousand); the same `now` goes to the store, so it forgets only what it said was due.
  budget.spent += 2;
  await deleteKeys(env.BLOBS, visit.expiredBlobs);
  await store.forgetBlobs(visit.expiredBlobs, now);
  report.blobsDeleted += visit.expiredBlobs.length;
}
