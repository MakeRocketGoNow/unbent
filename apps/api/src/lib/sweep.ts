import { SESSION_CACHE_SECONDS } from './account-deletion.js';
import { deleteKeys, deleteUserBlobsPage } from './blobs.js';
import {
  dropDirectoryRowStatement,
  listDirectory,
  recordDirectoryUsageStatement,
  tombstoneDirectoryRowStatement,
  type DirectoryRow,
} from './directory.js';
import { dropRestoresStatement } from './restores.js';
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
 *     itself empty and nothing is left under its prefix in R2, its row dropped. Not
 *     before `LATE_WRITES_MS`, because a session open at the deletion can still write
 *     for a while after it, and the row is the only thing that names what it wrote.
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
  /** Accounts with files due that this batch had no subrequests left to delete; they are near the front of the next walk's slots. */
  blobsDeferred: number;
  /** Files found under a deleted account's prefix, written after its deletion swept it, and deleted from R2 by this batch. */
  lateBlobsDeleted: number;
  /** Deleted accounts ready to be finished that this batch had no subrequests left for; their rows stay until a walk has some. */
  dropsDeferred: number;
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
 * of the Free plan's fifty. A deleted account's files, the R2 half of finishing it, are
 * not in that count: they are budgeted with the expiries, below.
 */
export const BATCH = 20;

/**
 * What one invocation may make on the Free plan, and so what every instance's sweep is
 * sized to: every store call, D1 query and R2 call counts. Deleting an account's expired
 * files costs two more on top of its visit — the R2 delete and the store's `forgetBlobs`
 * — and a batch of twenty accounts that all had files due would be sixty-four. So the
 * expiry is budgeted, and runs after every account has been visited, when what the
 * batch has spent is known exactly: what is left buys `pickAffordable` as many accounts
 * as fit, and the rest are counted in `blobsDeferred` and asked again on the next walk
 * of the directory — which, with the cursor moving twenty accounts an hour, is later
 * than the next hour. A batch of live accounts spends twenty-four on its visits and fits
 * thirteen expiries (pinned in sweep.test.ts).
 *
 * Finishing a deleted account is budgeted the same way and goes first: one page of its
 * prefix, a list and a delete, then its row. A deleted account is rare and its row is
 * waiting on this; an expiry has already waited thirty-five days and loses nothing by
 * waiting one walk more. A batch that is all deletions spends forty-four on wipes and
 * `usage` and finishes three. Not `deleteUserBlobs`, which would be right for a page or
 * two of late files and is two calls a thousand with no ceiling: an account deleted
 * before this walk existed, or whose deletion failed at R2, can still hold an archive
 * under its prefix, and one page a walk drains it without spending a batch on it.
 *
 * Which accounts get the slots rotates with the hour. A batch whose page is the same
 * twenty accounts every walk — and it is, since the directory order and the cursor's
 * steps are stable — would otherwise put off the same accounts on every walk, and a
 * large trash takes several visits to drain at a thousand keys each, so "later" could
 * have been "never" for an account that always came last. Reserving two subrequests for
 * every account still ahead, the first design, was worse: it fixed the losers to the
 * same positions on the page (found in review).
 */
export const SUBREQUEST_BUDGET = 50;

/** The batch's own D1 queries: the heal, the cursor read, the page, and the final `batch` of writes. */
const D1_PER_BATCH = 4;

/** The R2 delete and the store's `forgetBlobs`: what one account's expiry costs on top of its visit. */
export const EXPIRY_COST = 2;

/** One page of a deleted account's prefix, `deleteUserBlobsPage`'s list and delete: what finishing it costs on top of its visit. */
export const FINISH_COST = 2;

/**
 * How long after a deletion's tombstone its row is kept before the sweep may finish it:
 * the session cookie cache's lifetime, during which a session open at the deletion still
 * writes, and half an hour more for a request it admitted at the last moment to finish —
 * an upload of a large scan over a phone's radio takes minutes. Once it has passed,
 * nothing can add to the store or the prefix again, so what the sweep finds is all there
 * will ever be. Waiting costs a deleted account a wipe each walk until then; finishing
 * early would drop the row while something could still write under it, and nothing
 * would ever look there again.
 */
export const LATE_WRITES_MS = SESSION_CACHE_SECONDS * 1000 + 30 * 60_000;

/**
 * Which of the accounts `due` some work costing `cost` subrequests each this batch can
 * afford, given what it has `spent` of its budget so far: as many as fit, taken in order
 * from a start that moves with `hour`, so an account put off this walk is near the front
 * on the next. Pure, for the test.
 */
export function pickAffordable<T>(due: T[], spent: number, hour: number, cost: number, budget = SUBREQUEST_BUDGET): T[] {
  const slots = Math.max(0, Math.floor((budget - spent) / cost));
  if (due.length === 0 || slots === 0) return [];
  const start = ((hour % due.length) + due.length) % due.length;
  return Array.from({ length: Math.min(slots, due.length) }, (_, i) => due[(start + i) % due.length]!);
}

const CURSOR_KEY = 'store_sweep_cursor';

async function readCursor(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT value FROM _unbent_meta WHERE key = ?1`).bind(CURSOR_KEY).first<{ value: string }>();
  return row?.value ?? '';
}

export async function sweepStores(
  env: Pick<Env, 'DB' | 'USER_STORE' | 'STORE_JURISDICTION' | 'STORE_SWEEP' | 'BLOBS'>,
  /**
   * `spent`: subrequests the invocation has already made before the walk — the lapse
   * mail's (lib/plan-mail.ts), which runs ahead of it in the cron's one invocation.
   * Counted against the same budget, so a mail-heavy hour defers a few expiries rather
   * than running the walk's tail past Free's fifty.
   */
  opts: { restart?: boolean; spent?: number } = {},
): Promise<SweepReport> {
  const started = Date.now();
  const report: SweepReport = {
    visited: 0,
    wiped: 0,
    dropped: 0,
    blobsDeleted: 0,
    blobsDeferred: 0,
    lateBlobsDeleted: 0,
    dropsDeferred: 0,
    failed: [],
    deferred: [],
    done: false,
    ms: 0,
  };

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
  // The subrequests made so far, counted so the expiry can be budgeted; see
  // `SUBREQUEST_BUDGET`. The D1 queries are all counted up front, including the `batch`
  // at the end. `now` is one moment for the whole batch, asked of every store and given
  // back to each on the forget, so a store forgets only what it said was due.
  const budget = { spent: D1_PER_BATCH + (opts.spent ?? 0) };
  const now = Date.now();
  const due: Array<{ userId: string; keys: string[] }> = [];
  const finishing: string[] = [];
  for (const row of rows) {
    report.visited += 1;
    try {
      const expired = await sweepOne(env, row, report, writes, budget, now, finishing);
      if (expired.length > 0) due.push({ userId: row.userId, keys: expired });
    } catch (err) {
      if (isDeferral(err)) {
        report.deferred.push(row.userId);
        continue;
      }
      console.error(`[store] sweep failed for user=${row.userId}:`, err);
      report.failed.push(row.userId);
    }
  }

  // Deleted accounts whose store is empty and whose late writes are over: one page of
  // what is under the prefix, and the row once a page comes back with nothing after it.
  // R2 before the row, for the reason `account-deletion.ts` gives for files before the
  // user: the row is the only thing left that names the prefix. A page that leaves more
  // keeps the row, and the next walk takes the next page.
  const hour = Math.floor(now / 3_600_000);
  const finish = pickAffordable(finishing, budget.spent, hour, FINISH_COST);
  report.dropsDeferred = finishing.length - finish.length;
  for (const userId of finish) {
    budget.spent += FINISH_COST;
    try {
      const { deleted, more } = await deleteUserBlobsPage(env.BLOBS, userId);
      report.lateBlobsDeleted += deleted;
      if (deleted > 0) console.log(`[store] sweep deleted ${deleted} late files of deleted user=${userId}${more ? ', more to come' : ''}`);
      if (more) continue;
      writes.push(dropDirectoryRowStatement(env.DB, userId), dropRestoresStatement(env.DB, userId));
      report.dropped += 1;
    } catch (err) {
      console.error(`[store] sweep could not finish deleted user=${userId}:`, err);
      report.failed.push(userId);
    }
  }

  // The expiries, with what is left. R2 first, then the store: a delete that lands and
  // a forget that does not is asked for again on the next visit, and deleting an absent
  // object is a no-op; the reverse order would leave an object in the bucket that
  // nothing would ever ask about again. The keys are at most one `delete()`'s worth per
  // account, so each is one R2 call (`deleteKeys` batches by the same thousand).
  const chosen = pickAffordable(due, budget.spent, hour, EXPIRY_COST);
  report.blobsDeferred = due.length - chosen.length;
  for (const { userId, keys } of chosen) {
    budget.spent += EXPIRY_COST;
    try {
      await deleteKeys(env.BLOBS, keys);
      await storeFor(env, userId).forgetBlobs(keys, now);
      report.blobsDeleted += keys.length;
    } catch (err) {
      if (isDeferral(err)) {
        report.deferred.push(userId);
        continue;
      }
      console.error(`[store] blob expiry failed for user=${userId}:`, err);
      report.failed.push(userId);
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
    `[store] sweep visited=${report.visited} wiped=${report.wiped} dropped=${report.dropped} blobsDeleted=${report.blobsDeleted} blobsDeferred=${report.blobsDeferred} lateBlobsDeleted=${report.lateBlobsDeleted} dropsDeferred=${report.dropsDeferred} deferred=${report.deferred.length} failed=${report.failed.length} done=${report.done} ms=${report.ms}`,
  );
  return report;
}

/** The runtime's transient failures carry `retryable` as an own property, which RPC keeps. */
export function isDeferral(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { retryable?: unknown }).retryable === true;
}

/**
 * One account's visit. Returns the keys of its files whose retention is up, which the
 * caller expires once it knows what the batch can afford; an empty list for a deleted
 * account, which instead goes on `finishing` once it is ready for its row to go, for the
 * caller to sweep its prefix and drop the row as the budget allows.
 */
async function sweepOne(
  env: Pick<Env, 'DB' | 'USER_STORE' | 'STORE_JURISDICTION'>,
  row: DirectoryRow & { userExists: boolean },
  report: SweepReport,
  writes: D1PreparedStatement[],
  budget: { spent: number },
  now: number,
  finishing: string[],
): Promise<string[]> {
  const store = storeFor(env, row.userId);
  const gone = row.deletedAt !== null || !row.userExists;
  if (gone) {
    budget.spent += 1;
    await store.wipe();
    report.wiped += 1;
    // The row goes once the object is empty and the user row is too. A tombstone whose
    // user row is still there — a deletion that wiped the store and then failed to remove
    // the user — stays, and is wiped again each pass, because the heal above would
    // otherwise re-create a live row for an account that is empty.
    if (row.userExists) return [];
    // Not before the late writes are over (`LATE_WRITES_MS`), which are measured from the
    // tombstone. A row with none — the deletion's last step never ran — gets one now, and
    // waits from there: later than the deletion, so longer than it needed, never shorter.
    if (row.deletedAt === null) {
      writes.push(tombstoneDirectoryRowStatement(env.DB, row.userId, now));
      return [];
    }
    if (now - row.deletedAt < LATE_WRITES_MS) return [];
    // `usage` on a wiped object reports without rebuilding the schema; anything else
    // would leave a fresh empty database behind for a deleted account.
    budget.spent += 1;
    if ((await store.usage()).wiped) finishing.push(row.userId);
    return [];
  }
  // Waking the object is the point: a pending migration runs in its constructor, and a
  // failure there surfaces here as this row's error. `sweepVisit`, not `stats`: this runs
  // for every account on every walk, and must not scan a table. The visit also answers
  // which deleted files have waited their thirty-five days, so that the common case —
  // none — costs nothing beyond the call that was being made anyway.
  budget.spent += 1;
  const visit = await store.sweepVisit(now);
  writes.push(recordDirectoryUsageStatement(env.DB, row.userId, { storageBytes: visit.databaseSize, noteCount: visit.notes, lastActiveAt: visit.lastWriteAt }));
  return visit.expiredBlobs;
}
