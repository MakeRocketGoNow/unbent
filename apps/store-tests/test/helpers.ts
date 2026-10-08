import { env, runInDurableObject } from 'cloudflare:test';

/**
 * A stub for a store nothing else in the run has touched.
 *
 * Every test takes its store from here rather than naming one, because the plugin's
 * storage isolation does not reach SQLite-backed objects: a store written by one test is
 * still full in the next, whatever the config says (measured 2026-09-29). A random name
 * per call is the isolation, and it is a helper rather than a convention so a new test
 * cannot forget it.
 *
 * The name is what the object takes to be its user id, so it is also what its
 * `_meta.user_id` row will say.
 */
export function freshStore(label = 'test') {
  const userId = `${label}-${crypto.randomUUID()}`;
  return { userId, stub: env.USER_STORE.get(env.USER_STORE.idFromName(userId)) };
}

/** The feed's rows after `since`, oldest first: what a write recorded. */
export async function feedRows(stub: ReturnType<typeof freshStore>['stub'], since = 0) {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec<{ seq: number; entity: string; id: string; deleted: number }>(
        `SELECT seq, entity, id, deleted FROM changes WHERE seq > ?1 ORDER BY seq`,
        since,
      )
      .toArray()
      .map((r) => ({ entity: r.entity, id: r.id, ...(r.deleted ? { deleted: true } : {}) })),
  );
}

/** The counter now. */
export function feedSeq(stub: ReturnType<typeof freshStore>['stub']): Promise<number> {
  return runInDurableObject(stub, (_i, state) =>
    Number(state.storage.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'seq'`).toArray()[0]?.value ?? 0),
  );
}

/**
 * The restore history's table as migration 0041 makes it (without the copy from the
 * directory), for the suites that build their D1 by hand: the sweep deletes a gone
 * account's rows beside its directory row, so a directory without this table fails the
 * sweep's batch.
 */
export const RESTORES_DDL = [
  `CREATE TABLE IF NOT EXISTS restores (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, operator_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('moment', 'bookmark', 'load')), state TEXT NOT NULL CHECK (state IN ('started', 'applied', 'failed')), started_at INTEGER NOT NULL, applied_at INTEGER, to_at INTEGER, dump_key TEXT, before_key TEXT, undo TEXT, undoes INTEGER);`,
  `CREATE INDEX IF NOT EXISTS idx_restores_user ON restores (user_id);`,
];

/** Every tag row, counted or not: `listTags` leaves out tags with no live note. */
export function listAllTags(stub: ReturnType<typeof freshStore>['stub']) {
  return runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ id: string; name: string }>(`SELECT id, name FROM tags`).toArray());
}
