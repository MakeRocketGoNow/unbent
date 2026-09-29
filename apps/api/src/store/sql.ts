/**
 * The one seam between the store's SQL and the engine that runs it.
 *
 * Everything in `notes.ts` and `attachments.ts` reads and writes through this interface
 * and nothing else — no `ctx.storage`, no `D1Database`. Two reasons, one for each side of
 * the seam. Inside the object it is where every statement is metered: the runtime reports
 * rows read and written per cursor, and this is the single place that can see them all,
 * log the expensive ones, and add them up for a test that wants to bound a query. Outside
 * the object it is what a unit test fakes: a `Sql` that answers a SELECT with canned rows
 * and runs `tx` inline lets the purge paging be tested for the race it exists to survive,
 * without a Worker.
 *
 * It is also the only lock-in surface. The SQL text is SQLite; the actor plumbing is in
 * user-store.ts; this is the adapter between them, and moving the store to another SQLite
 * host would mean rewriting this file and not the ones that use it.
 */

/** A bound value: what SQLite accepts. `undefined` is normalised to NULL before binding. */
export type Bind = string | number | boolean | null | undefined | ArrayBuffer | Uint8Array;

export interface Sql {
  /**
   * Runs one statement and returns every row it produced.
   *
   * The cursor is consumed whole rather than returned. Row counts are only final once a
   * cursor has been read to its end, so metering needs the rows in hand — and every caller
   * wanted the array anyway, or a `RETURNING` count, which is the array's length. A
   * statement with nothing to return gives `[]`.
   */
  exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...binds: Bind[]): T[];
  /** The first row or null. `[0] ?? null`, written once so a missing row is `null` and never `undefined`. */
  first<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...binds: Bind[]): T | null;
  /**
   * Runs `fn` in one transaction, rolled back if it throws.
   *
   * Public store methods open one; private helpers never do. The runtime nests
   * transactions with savepoint semantics (measured 2026-09-29), so a public method that
   * calls another — `create` → `get`, `duplicate` → `create` — commits once, at the
   * outermost boundary, and a throw anywhere inside unwinds all of it.
   */
  tx<T>(fn: () => T): T;
  /** Rows read and written since the counters were last reset, for tests and the ops routes. */
  readonly counters: { rowsRead: number; rowsWritten: number; statements: number };
  resetCounters(): void;
}

/**
 * A statement that read more rows than this is logged with its counts. Two thousand is a
 * page of fifty notes with their tags, fields and files built, several times over — the
 * biggest honest read the app makes — so anything past it is worth a line.
 */
export const LOG_ROWS_READ_THRESHOLD = 2000;

/**
 * The `Sql` the object runs on: `ctx.storage.sql` with every statement metered.
 *
 * The log line names the user, because a slow query on one account is what the line is
 * for, and the first 120 characters of the statement, which is enough to find it in the
 * source and short enough that a body bound into an INSERT never reaches the log. It
 * replaces `wrangler d1 insights`: the object has no console, and this is the accounting.
 */
export function instrumentedSql(
  storage: DurableObjectStorage,
  userId: string,
  threshold = LOG_ROWS_READ_THRESHOLD,
): Sql {
  const raw = storage.sql;
  const counters = { rowsRead: 0, rowsWritten: 0, statements: 0 };
  const exec = <T extends Record<string, unknown>>(query: string, ...binds: Bind[]): T[] => {
    const started = Date.now();
    const cursor = raw.exec(query, ...binds.map((b) => (b === undefined ? null : b)));
    const rows = cursor.toArray() as T[];
    const { rowsRead, rowsWritten } = cursor;
    counters.rowsRead += rowsRead;
    counters.rowsWritten += rowsWritten;
    counters.statements += 1;
    if (rowsRead > threshold) {
      console.warn(
        `[store] user=${userId} rowsRead=${rowsRead} rowsWritten=${rowsWritten} ms=${Date.now() - started} sql=${query.replace(/\s+/g, ' ').trim().slice(0, 120)}`,
      );
    }
    return rows;
  };
  return {
    exec,
    first: <T extends Record<string, unknown>>(query: string, ...binds: Bind[]) => exec<T>(query, ...binds)[0] ?? null,
    tx: (fn) => storage.transactionSync(fn),
    counters,
    resetCounters() {
      counters.rowsRead = 0;
      counters.rowsWritten = 0;
      counters.statements = 0;
    },
  };
}
