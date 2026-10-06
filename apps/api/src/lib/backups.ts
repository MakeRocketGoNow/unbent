import { beginDump } from './dump.js';
import { storeFor } from './store-client.js';
import { isDeferral, SUBREQUEST_BUDGET } from './sweep.js';
import type { Env } from '../types.js';

/**
 * The daily dumps into the backups bucket (MAK-171, part 2): every account whose store
 * has changed since its last dump is dumped, as the same SQL file the operator's dump
 * route writes (`lib/dump.ts`), to `stores/<user>/<YYYY-MM-DD>.sql`. A scheduled GitHub
 * Action copies the bucket to a second Cloudflare account each night (part 3), and a
 * dump is what part 4 loads to put an account back. The bucket's lifecycle rule deletes
 * a dump fourteen days after it was written; the second account keeps its copy ninety.
 *
 * Opt-in, by the binding. With no `BACKUPS` bound, which is every instance but
 * unbent.app's production and dev, the run returns before it makes a single call, so the
 * cron at :47 costs a fork nothing. A self-hoster arranges their own backups, and the
 * README says that on Workers Free a large account may not fit one invocation's dump.
 *
 * What is due, and why it is tried at most once a day. The directory records each
 * account's last dump (migration 0037), and the run takes the accounts not yet tried
 * since midnight UTC, never-tried first, then the longest waiting. So the first run after
 * midnight starts the day's pass and each hourly run continues it, and a key's date is
 * one per account per day by construction: a dump is never written twice to one key,
 * which matters because the second account's copy of `stores/` is under a retention lock
 * and refuses an overwrite. A failure is recorded and waits for tomorrow, rather than
 * being retried every hour ahead of everyone else; a transient one, which the runtime
 * marks `retryable`, is left untried and comes back on the next run.
 *
 * Only accounts that changed, and every account at least weekly. The store answers its
 * feed's mark first (`dumpBegin`), and when that is the mark of the newest dump the
 * account costs this run one call and is recorded as checked. But a dump nobody replaces
 * is deleted by the lifecycle rule after fourteen days, and the second account's copy
 * after ninety, so an account nobody touched would end up with no dump anywhere — the
 * one a whole-account restore would need. So an account whose newest dump is
 * `REFRESH_MS` old is dumped whatever its mark: always one inside the fourteen days on
 * this account, and a fresh key for the mirror to copy within its ninety. Decided with
 * the operator on 2026-10-05, after the plan's "only accounts that changed" turned out
 * to leave exactly the idle accounts unprotected.
 *
 * The budget. Every store call, D1 query and R2 call counts against an invocation's
 * subrequests, fifty on Workers Free, and this keeps to that even on unbent.app, which
 * is on Paid — the sweep's budget at :17 is a separate invocation's, so the two never
 * compete. The run's own cost is three: the query for the accounts due, the `batch` that
 * records them and reads the status back, and the status file. An unchanged account is
 * one store call; a small changed one is that call and one `put`; an archive of 31 MB is
 * about five slices, a multipart upload's create, four parts and its completion. A dump
 * that would pass the budget is stopped and its upload aborted, with one call held back
 * for the abort. If the dump had the whole budget to itself it can never fit, and is
 * recorded as failed, so it is in the status and is tried again tomorrow rather than in
 * every run; otherwise the run stops there, and the next one, an hour later, starts with
 * that account and the whole budget. There is no cursor across runs: a dump is whole in
 * one invocation or not written.
 *
 * Each run ends by writing `status/dumps.json` to the bucket, for the Action to fail on
 * (part 3) and the operator page to show (part 5): when this ran, what it did, and which
 * accounts have failed or are stale.
 */
export interface DumpReport {
  /** Accounts dumped this run, and the bytes written for them. */
  dumped: number;
  bytes: number;
  /** Accounts whose newest dump was still current. */
  unchanged: number;
  failed: string[];
  /** Accounts left for a later run: a transient store failure, or the budget ran out. */
  deferred: string[];
  /** Whether every account due was reached. */
  done: boolean;
  subrequests: number;
  ms: number;
}

/** What the run writes to `status/dumps.json`. */
export interface DumpStatus {
  ranAt: string;
  run: Omit<DumpReport, 'failed' | 'deferred'> & { failed: number; deferred: number };
  /** Live accounts in the directory. */
  accounts: number;
  /** Accounts whose last attempt failed, with the error, at most `STATUS_LIST` of them. */
  failing: Array<{ userId: string; error: string; triedAt: string | null }>;
  failingCount: number;
  /**
   * Accounts no run has found current in `STALE_MS`: checked longer ago than that, or
   * never and created longer ago than that. At most `STATUS_LIST` of them.
   */
  stale: string[];
  staleCount: number;
  staleAfterHours: number;
}

/** How old an account's newest dump may be before it is written again unchanged; see above. */
export const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an account may go without a run finding its dump current before the status
 * calls it stale: the issue's forty-eight hours, which is two days' passes. The Action
 * fails the night's run on any stale account.
 */
export const STALE_MS = 48 * 60 * 60 * 1000;

/**
 * Bytes of each part of a multipart upload but the last. R2 wants at least five MiB, and
 * every part but the last the same size, which cutting the stream into exact parts gives
 * whatever the slices' sizes. Eight, the size of a slice, so a 31 MB dump is four parts.
 */
export const PART_BYTES = 8 * 1024 * 1024;

/** The run's own subrequests: the query for what is due, the closing `batch`, and the status file. */
const FIXED_COST = 3;

/** Names listed in the status for failing and stale accounts, at most; the counts are whole. */
const STATUS_LIST = 50;

/** Characters of an error kept in the directory. */
const ERROR_LENGTH = 500;

/** A dump stopped because the invocation could not afford its next call. */
class OutOfSubrequests extends Error {}

/**
 * The subrequests the run may still make, with `held` kept back for aborting an open
 * upload. `take(reserve)` refuses a call that would leave fewer than `reserve` behind it:
 * the call that opens an upload takes one, so the abort it may need is affordable from
 * the moment the upload exists (an open that took the last call left nothing to abort
 * with, found in review).
 */
class Budget {
  spent = FIXED_COST;
  held = 0;
  constructor(readonly limit: number) {}
  take(reserve = 0): void {
    if (this.spent + 1 + this.held + reserve > this.limit) throw new OutOfSubrequests();
    this.spent += 1;
  }
  get left(): number {
    return this.limit - this.spent;
  }
}

/** The day a dump is filed under: its UTC date, which is also the run's day. */
export function dumpKey(userId: string, now: number): string {
  return `stores/${userId}/${new Date(now).toISOString().slice(0, 10)}.sql`;
}

export const STATUS_KEY = 'status/dumps.json';

interface DueRow {
  user_id: string;
  dump_at: number | null;
  dump_mark: string | null;
}

export async function dumpStores(
  env: Pick<Env, 'DB' | 'USER_STORE' | 'STORE_JURISDICTION' | 'BACKUPS'>,
  opts: { budget?: number; now?: number; partBytes?: number } = {},
): Promise<DumpReport | null> {
  const bucket = env.BACKUPS;
  if (!bucket) return null;
  const started = Date.now();
  const now = opts.now ?? started;
  const budget = new Budget(opts.budget ?? SUBREQUEST_BUDGET);
  const report: DumpReport = { dumped: 0, bytes: 0, unchanged: 0, failed: [], deferred: [], done: false, subrequests: 0, ms: 0 };

  // Live accounts only: a tombstoned row or a missing user is the sweep's to finish, and
  // waking either store would rebuild a schema for an account that is gone.
  const midnight = Math.floor(now / 86_400_000) * 86_400_000;
  const { results: due } = await env.DB.prepare(
    `SELECT d.user_id, d.dump_at, d.dump_mark
       FROM account_directory d JOIN user u ON u.id = d.user_id
      WHERE d.deleted_at IS NULL AND (d.dump_tried_at IS NULL OR d.dump_tried_at < ?1)
      ORDER BY d.dump_tried_at IS NOT NULL, d.dump_tried_at, d.user_id
      LIMIT ?2`,
  )
    .bind(midnight, budget.left)
    .all<DueRow>();

  const writes: D1PreparedStatement[] = [];
  let reached = 0;
  for (const row of due) {
    // An account costs at least its `dumpBegin` and, if it changed, one `put`.
    if (budget.left < 2) break;
    reached += 1;
    const whole = budget.spent === FIXED_COST;
    try {
      const outcome = await dumpOne(env, bucket, row, now, budget, opts.partBytes ?? PART_BYTES);
      if (outcome.unchanged) {
        report.unchanged += 1;
        writes.push(
          env.DB.prepare(`UPDATE account_directory SET dump_checked_at = ?2, dump_tried_at = ?2, dump_error = NULL WHERE user_id = ?1`).bind(row.user_id, now),
        );
      } else {
        report.dumped += 1;
        report.bytes += outcome.bytes;
        writes.push(
          env.DB.prepare(
            `UPDATE account_directory
                SET dump_at = ?2, dump_bytes = ?3, dump_mark = ?4, dump_checked_at = ?2, dump_tried_at = ?2, dump_error = NULL
              WHERE user_id = ?1`,
          ).bind(row.user_id, now, outcome.bytes, outcome.mark),
        );
      }
    } catch (err) {
      if (err instanceof OutOfSubrequests && !whole) {
        // Someone ahead of it spent part of the budget; the next run starts with it.
        report.deferred.push(row.user_id);
        reached -= 1;
        break;
      }
      if (isDeferral(err)) {
        report.deferred.push(row.user_id);
        continue;
      }
      const message =
        err instanceof OutOfSubrequests
          ? `The dump needs more than the ${budget.limit} subrequests one invocation may make.`
          : err instanceof Error
            ? err.message
            : String(err);
      console.error(`[backup] dump failed for user=${row.user_id}:`, err);
      report.failed.push(row.user_id);
      writes.push(
        env.DB.prepare(`UPDATE account_directory SET dump_tried_at = ?2, dump_error = ?3 WHERE user_id = ?1`).bind(row.user_id, now, message.slice(0, ERROR_LENGTH)),
      );
    }
  }
  // Every account due was reached when the query came back short of its limit and the
  // loop got through all of it.
  report.done = reached === due.length && due.length < Math.max(0, budget.limit - FIXED_COST);

  // The writes, then the status read back in the same call, so it says what this run did.
  const stale = now - STALE_MS;
  const statusQuery = env.DB.prepare(
    `SELECT COUNT(*) AS accounts,
            COUNT(d.dump_error) AS failing_count,
            SUM(COALESCE(d.dump_checked_at, d.created_at) < ?1) AS stale_count,
            json_group_array(json_object('userId', d.user_id, 'error', d.dump_error, 'triedAt', d.dump_tried_at))
              FILTER (WHERE d.dump_error IS NOT NULL) AS failing,
            json_group_array(d.user_id) FILTER (WHERE COALESCE(d.dump_checked_at, d.created_at) < ?1) AS stale
       FROM account_directory d JOIN user u ON u.id = d.user_id
      WHERE d.deleted_at IS NULL`,
  ).bind(stale);
  const results = await env.DB.batch<StatusRow>([...writes, statusQuery]);
  const summary = results[results.length - 1]!.results[0]!;

  report.subrequests = budget.spent;
  report.ms = Date.now() - started;
  const status: DumpStatus = {
    ranAt: new Date(now).toISOString(),
    run: { ...report, failed: report.failed.length, deferred: report.deferred.length },
    accounts: summary.accounts,
    failing: (JSON.parse(summary.failing ?? '[]') as Array<{ userId: string; error: string; triedAt: number | null }>)
      .slice(0, STATUS_LIST)
      .map((f) => ({ ...f, triedAt: f.triedAt === null ? null : new Date(f.triedAt).toISOString() })),
    failingCount: summary.failing_count,
    stale: (JSON.parse(summary.stale ?? '[]') as string[]).slice(0, STATUS_LIST),
    staleCount: summary.stale_count ?? 0,
    staleAfterHours: STALE_MS / 3_600_000,
  };
  await bucket.put(STATUS_KEY, JSON.stringify(status, null, 2), { httpMetadata: { contentType: 'application/json' } });

  console.log(
    `[backup] dumps dumped=${report.dumped} unchanged=${report.unchanged} failed=${report.failed.length} deferred=${report.deferred.length} bytes=${report.bytes} done=${report.done} subrequests=${report.subrequests} ms=${report.ms}`,
  );
  return report;
}

interface StatusRow {
  accounts: number;
  failing_count: number;
  stale_count: number | null;
  failing: string | null;
  stale: string | null;
}

/**
 * One account: its mark, and unless that is the newest dump's and the dump is younger
 * than `REFRESH_MS`, its dump streamed into the bucket.
 */
async function dumpOne(
  env: Pick<Env, 'USER_STORE' | 'STORE_JURISDICTION'>,
  bucket: R2Bucket,
  row: DueRow,
  now: number,
  budget: Budget,
  partBytes: number,
): Promise<{ unchanged: true } | { unchanged: false; mark: string; bytes: number }> {
  const fresh = row.dump_at !== null && row.dump_at > now - REFRESH_MS;
  budget.take();
  const dump = await beginDump(storeFor(env, row.user_id), row.user_id, {
    unless: fresh ? row.dump_mark : null,
    beforeSlice: () => budget.take(),
  });
  if (!dump.chunks) return { unchanged: true };
  const bytes = await upload(bucket, dumpKey(row.user_id, now), dump.chunks, budget, partBytes);
  return { unchanged: false, mark: dump.mark, bytes };
}

/**
 * Writes `chunks` to `key` as they arrive, and returns the bytes written. R2 needs to
 * know an object's length before a single `put` of a stream, and a dump's is not known
 * until it ends, so a dump that fits in one part is gathered and put whole, and a bigger
 * one goes up as a multipart upload in parts of exactly `partBytes`: one part held in
 * memory at a time, plus the slice being cut, never the file. An upload that fails or
 * runs out of budget is aborted, with the call for that held back from the moment it
 * opens, so no half-written dump is left to be completed by nothing.
 */
async function upload(bucket: R2Bucket, key: string, chunks: AsyncGenerator<Uint8Array>, budget: Budget, partBytes: number): Promise<number> {
  const httpMetadata = { contentType: 'application/sql; charset=utf-8' };
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let total = 0;
  let multipart: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];
  try {
    for await (const chunk of chunks) {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      total += chunk.byteLength;
      while (pendingBytes >= partBytes) {
        if (!multipart) {
          budget.take(1);
          multipart = await bucket.createMultipartUpload(key, { httpMetadata });
          budget.held = 1;
        }
        const part = join(pending, partBytes);
        pending = rest(pending, partBytes);
        pendingBytes -= partBytes;
        budget.take();
        parts.push(await multipart.uploadPart(parts.length + 1, part));
      }
    }
    const last = join(pending, pendingBytes);
    if (!multipart) {
      budget.take();
      await bucket.put(key, last, { httpMetadata });
      return total;
    }
    if (last.byteLength > 0) {
      budget.take();
      parts.push(await multipart.uploadPart(parts.length + 1, last));
    }
    budget.take();
    await multipart.complete(parts);
    budget.held = 0;
    return total;
  } catch (err) {
    if (multipart) {
      budget.held = 0;
      budget.spent += 1;
      await multipart.abort().catch((abortErr: unknown) => console.error(`[backup] abort failed for ${key}:`, abortErr));
    }
    await chunks.return(undefined);
    throw err;
  }
}

/** The first `length` bytes of `chunks`, as one array. */
function join(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    if (at >= length) break;
    const take = Math.min(chunk.byteLength, length - at);
    out.set(take === chunk.byteLength ? chunk : chunk.subarray(0, take), at);
    at += take;
  }
  return out;
}

/** What is left of `chunks` after the first `length` bytes. */
function rest(chunks: Uint8Array[], length: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let skip = length;
  for (const chunk of chunks) {
    if (skip >= chunk.byteLength) {
      skip -= chunk.byteLength;
      continue;
    }
    out.push(skip > 0 ? chunk.subarray(skip) : chunk);
    skip = 0;
  }
  return out;
}
