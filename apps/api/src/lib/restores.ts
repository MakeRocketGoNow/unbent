import type { StoreRestore, StoreRestores } from '@unbent/shared';
import { RESTORES_LISTED } from '@unbent/shared';

/**
 * The history of what was done to each account's store from the operator page: every
 * wind-back, every restore to a bookmark and every load, with the operator who asked
 * (migration 0041, MAK-198). It replaced the one wind-back 0038 kept on the directory row.
 *
 * Written by the restore and load routes in a fixed order, and the order is the point: a
 * row is started before the store is touched, finished once the store answers, and
 * deleted only when the runtime refused before anything was scheduled. A restore that
 * never answers therefore leaves its row as the newest, `started`, and the page offers no
 * undo from beneath it: the older row's bookmark is from before this restore too, and
 * pressing it would throw this one away under a confirm that says nothing of it. That
 * was 0038's reason for clearing its record before a restore rather than after (found in
 * review then), and a started row is the same rule kept in a list.
 *
 * None of it may fail the action it records. Every call is caught and logged by the
 * route; the bookmark is in the route's answer and the Worker's log whatever happens here.
 */

/**
 * The reads, as text, so `migrations.test.ts` can `EXPLAIN QUERY PLAN` them against a
 * database built from the migrations and pin that each takes 0041's index. Binds: `list`
 * takes the account and the limit; `undone` the account and the bookmark; `newest` the
 * account.
 */
export const RESTORES_SQL = {
  list: `SELECT r.id, r.kind, r.state, r.started_at, r.applied_at, r.to_at, r.dump_key, r.before_key, r.undo, r.undoes,
              r.operator_id, u.email AS operator_email
         FROM restores r LEFT JOIN user u ON u.id = r.operator_id
        WHERE r.user_id = ?1 ORDER BY r.id DESC LIMIT ?2`,
  undone: `SELECT id FROM restores WHERE user_id = ?1 AND undo = ?2 ORDER BY id DESC LIMIT 1`,
  /** The account's newest row's id, as `startRestore` checks it; 0 for none. */
  newest: `SELECT COALESCE(MAX(id), 0) FROM restores WHERE user_id = ?1`,
};

interface RawRestore {
  id: number;
  kind: StoreRestore['kind'];
  state: StoreRestore['state'];
  started_at: number;
  applied_at: number | null;
  to_at: number | null;
  dump_key: string | null;
  before_key: string | null;
  undo: string | null;
  undoes: number | null;
  operator_id: string | null;
  operator_email: string | null;
}

/**
 * A restore or load about to touch the store. `undoes` is the row whose bookmark a
 * restore to a bookmark is going back to, from `undoneRow`. Answers the new row's id.
 *
 * `ifNewest` is the id of the row the caller took to be the account's newest, and the
 * row is written only while it still is; null is the answer when it is not. The page
 * sends it with an undo from the history, because the bookmark it offers is right only
 * while nothing has happened since: a second operator's wind-back in between would be
 * thrown away by the press, under a confirm that never named it (found in review). In
 * the insert itself, not a read before it, so two requests cannot both pass. Without it,
 * as from the API by hand, the row is written whatever the history holds.
 */
export async function startRestore(
  db: D1Database,
  row: { userId: string; operatorId: string; kind: StoreRestore['kind']; toAt?: number; dump?: string; undoes?: number | null; ifNewest?: number },
): Promise<number | null> {
  const inserted = await db
    .prepare(
      `INSERT INTO restores (user_id, operator_id, kind, state, started_at, to_at, dump_key, undoes)
       SELECT ?1, ?2, ?3, 'started', ?4, ?5, ?6, ?7
        WHERE ?8 IS NULL OR (${RESTORES_SQL.newest}) = ?8
       RETURNING id`,
    )
    .bind(row.userId, row.operatorId, row.kind, Date.now(), row.toAt ?? null, row.dump ?? null, row.undoes ?? null, row.ifNewest ?? null)
    .first<{ id: number }>();
  return inserted?.id ?? null;
}

/**
 * What the store answered. `applied` stamps `appliedAt`, from which the bookmark's thirty
 * days are counted. A load calls this twice: once its bookmark is taken (`undo` and
 * `before`, still `started`), and again with how it ended, so a load that stops partway
 * keeps the way back it began with.
 */
export async function settleRestore(
  db: D1Database,
  id: number,
  settled: { state: StoreRestore['state']; undo?: string | null; before?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE restores
          SET state = ?2,
              applied_at = CASE WHEN ?2 = 'applied' THEN ?3 ELSE applied_at END,
              undo = COALESCE(?4, undo),
              before_key = COALESCE(?5, before_key)
        WHERE id = ?1`,
    )
    .bind(id, settled.state, Date.now(), settled.undo ?? null, settled.before ?? null)
    .run();
}

/** A restore the runtime refused before scheduling anything: nothing happened, so nothing is recorded. */
export async function dropRestore(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM restores WHERE id = ?1`).bind(id).run();
}

/**
 * The newest of the account's rows whose bookmark is `bookmark`, which a restore to that
 * bookmark undoes, or null for one the history does not hold — written by hand from the
 * log, or older than the list. Newest, since a load started over keeps the first
 * attempt's bookmark and so two rows can share one.
 */
export async function undoneRow(db: D1Database, userId: string, bookmark: string): Promise<number | null> {
  const row = await db
    .prepare(RESTORES_SQL.undone)
    .bind(userId, bookmark)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/**
 * The account's newest `RESTORES_LISTED` rows, with each operator's email where the user
 * row is still there. One past the limit is read to answer `more`.
 */
export async function listRestores(db: D1Database, userId: string): Promise<StoreRestores> {
  const { results } = await db
    .prepare(RESTORES_SQL.list)
    .bind(userId, RESTORES_LISTED + 1)
    .all<RawRestore>();
  const rows = results.slice(0, RESTORES_LISTED);
  // An undo is always newer than what it undid, so a listed row's undo is listed too.
  const undoneBy = new Map(rows.filter((r) => r.undoes !== null).map((r) => [r.undoes!, r.id]));
  return {
    restores: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      startedAt: r.started_at,
      appliedAt: r.applied_at,
      toAt: r.to_at,
      dump: r.dump_key,
      before: r.before_key,
      undo: r.undo,
      undoes: r.undoes,
      undoneBy: undoneBy.get(r.id) ?? null,
      operator: r.operator_id === null ? null : { id: r.operator_id, email: r.operator_email },
    })),
    more: results.length > RESTORES_LISTED,
  };
}

/**
 * The delete of an account's rows, as a statement the sweep batches beside the directory
 * row's own: the history goes when the account is gone from D1, with nothing left of a
 * deleted account but its id in the log.
 */
export function dropRestoresStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM restores WHERE user_id = ?1`).bind(userId);
}
