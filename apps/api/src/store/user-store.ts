import { DurableObject } from 'cloudflare:workers';
import { appliedMigrations, migrate } from './migrate.js';
import { SCHEMA } from './schema/index.js';
import { instrumentedSql, type Sql } from './sql.js';

/**
 * What the object is allowed to see of the Worker's environment: nothing.
 *
 * `Pick<Env, never>` is deliberately empty rather than omitted, so the type is the place
 * to widen when the one-time copy from D1 lands (it needs `DB`, and nothing else ever
 * will). Naming `BLOBS`, `AI` or a secret here would be refused by review before it was
 * refused by the compiler, but the compiler refusing it is what makes rule 1 in AGENTS.md
 * — the object touches its SQLite and nothing else — a property of the code rather than
 * a habit.
 */
export type StoreEnv = Record<never, never>;

/** The `_meta` keys the object writes. Reserved names, kept in one place. */
const META = {
  /** The user this object belongs to: `ctx.id.name`, written on first wake, refused on a mismatch after. */
  userId: 'user_id',
} as const;

/** One row as SQLite hands it back: the four value types it has, by column name. */
export type Row = Record<string, SqlStorageValue>;

/** The tables `dumpPage` will page and `stats` counts. FTS tables are rebuilt from these, never dumped. */
export const DATA_TABLES = [
  'notebooks',
  'notebook_fields',
  'tags',
  'notes',
  'note_tags',
  'note_fields',
  'attachments',
  'attachment_text',
] as const;
export type DataTable = (typeof DATA_TABLES)[number];

/** What `stats` reports: the shape the ops route and the sweep read. */
export interface StoreStats {
  userId: string;
  /** Bytes the object's SQLite occupies, as the runtime reports it. */
  databaseSize: number;
  migrations: string[];
  counts: Record<DataTable, number>;
  /** True when `wipe` has run and nothing has woken the schema since: the object is empty storage. */
  wiped: boolean;
}

/**
 * One account's notes, in a SQLite database of their own.
 *
 * The object is the repository. Every route and MCP tool in the Worker reaches a user's
 * notes through a stub of this class, keyed by user id (`idFromName(userId)`), and every
 * statement then runs in-process against `ctx.storage.sql`. The Worker authenticates,
 * forwards, and does whatever leaves the building — R2 bytes, the language model, mail —
 * before or after the call. Nothing in this module, or in anything it imports, makes an
 * outbound request; a static test asserts it.
 *
 * The constructor is the migration runner. Under `blockConcurrencyWhile`, so nothing sees
 * a half-applied schema: each schema file the object has no record of is applied in one
 * transaction, and on every wake the object checks that foreign keys are enforced (the
 * engine's default, but the cascades depend on it) and that `_meta.user_id` is the name
 * it was created under. Every other wake is local reads only.
 *
 * A wiped object stays wiped until something asks for its notes. Account deletion calls
 * `wipe`, which drops everything and leaves the storage empty, so a deleted account
 * costs nothing; the next data call, if there ever is one, rebuilds the schema first.
 * `stats` on a wiped object reports zeros without rebuilding, which is what lets the
 * sweep confirm a deletion cheaply.
 */
export class UserStore extends DurableObject<StoreEnv> {
  readonly userId: string;
  private sql: Sql;
  private wiped = false;

  constructor(ctx: DurableObjectState, env: StoreEnv) {
    super(ctx, env);
    // Objects are only ever created with `idFromName(userId)`; a string id has no name and
    // would be an object nobody could tell whose it was. Refusing here keeps `_meta.user_id`
    // meaningful and makes the mistake loud at the one place it can be made.
    const name = ctx.id.name;
    if (!name) throw new Error('UserStore must be created with idFromName(userId)');
    this.userId = name;
    this.sql = instrumentedSql(ctx.storage, name);
    ctx.blockConcurrencyWhile(async () => {
      this.bootstrap();
    });
  }

  /**
   * Migrates, checks the engine, and claims the object for its user. Idempotent: on every
   * wake after the first it applies nothing and reads three rows.
   */
  private bootstrap(): void {
    migrate(this.ctx.storage, SCHEMA);

    // On by default for a SQLite-backed object (measured 2026-09-29), and the schema's
    // cascades rely on it: a purged note takes its files, text, tags and values with it.
    // Set rather than assumed, and checked rather than trusted, because the default is
    // the runtime's to change and nothing here would notice until a purge left orphans.
    const fk = this.sql.first<{ foreign_keys: number }>('PRAGMA foreign_keys');
    if (fk?.foreign_keys !== 1) {
      this.sql.exec('PRAGMA foreign_keys = ON');
      const again = this.sql.first<{ foreign_keys: number }>('PRAGMA foreign_keys');
      if (again?.foreign_keys !== 1) throw new Error('foreign keys could not be enabled');
    }

    // The database says whose it is, and disagrees with nobody. Written on first wake;
    // afterwards a mismatch means the object was reached under the wrong name, which is
    // the one bug the per-user design exists to make impossible, so it fails hard.
    const owner = this.sql.first<{ value: string }>('SELECT value FROM _meta WHERE key = ?1', META.userId);
    if (!owner) {
      this.sql.exec('INSERT INTO _meta (key, value) VALUES (?1, ?2)', META.userId, this.userId);
    } else if (owner.value !== this.userId) {
      throw new Error(`store belongs to another user: expected ${this.userId}, found ${owner.value}`);
    }
    this.wiped = false;
  }

  /** Rebuilds the schema after a `wipe`, the first time anything asks for data again. */
  private ready(): void {
    if (this.wiped) this.bootstrap();
  }

  // --- Operator surface ------------------------------------------------------------------

  /** Cheap liveness: wakes the object (and so runs any pending migration) and names it. */
  ping(): { userId: string } {
    return { userId: this.userId };
  }

  /** Row counts, size and schema version, for the ops route and the daily sweep. */
  stats(): StoreStats {
    const counts = Object.fromEntries(DATA_TABLES.map((t) => [t, 0])) as Record<DataTable, number>;
    if (this.wiped) {
      return { userId: this.userId, databaseSize: this.ctx.storage.sql.databaseSize, migrations: [], counts, wiped: true };
    }
    for (const table of DATA_TABLES) {
      counts[table] = this.sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
    }
    return {
      userId: this.userId,
      databaseSize: this.ctx.storage.sql.databaseSize,
      migrations: appliedMigrations(this.ctx.storage),
      counts,
      wiped: false,
    };
  }

  /**
   * Deletes everything: every table, the schema, the `_meta` row. For account deletion and
   * for the test fixtures' purge.
   *
   * The instance stays alive and empty. `ready()` rebuilds the schema if a data method is
   * called afterwards, so a wiped object that is reached again — a deletion that failed
   * further along and was retried, a test — behaves as a brand-new one rather than
   * throwing "no such table" until it is evicted.
   */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.wiped = true;
  }

  /**
   * Runs one SELECT for the operator and returns its rows, without any possibility of a
   * write reaching the disk.
   *
   * The guarantee is the transaction: the statement runs inside one that is always rolled
   * back, so even a query that turned out to write — a CTE with a DML tail, a misread — is
   * undone before this returns (rollback on throw is the runtime's, measured 2026-09-29).
   * The prefix check is belt and braces for the one thing a transaction cannot undo, a
   * PRAGMA that changes engine state, and for making the refusal an error the operator
   * reads rather than a silent no-op.
   *
   * Rows are capped because the result crosses RPC (32 MiB) and lands in a JSON response;
   * an operator wanting more pages with LIMIT/OFFSET like anyone else.
   */
  readOnlySql(query: string, binds: Array<string | number | null> = [], maxRows = 500): {
    rows: Row[];
    truncated: boolean;
    rowsRead: number;
  } {
    this.ready();
    const head = query.trimStart().slice(0, 8).toUpperCase();
    if (!/^(SELECT|WITH|EXPLAIN)\b/.test(head)) {
      throw new Error('readOnlySql runs SELECT, WITH or EXPLAIN statements only');
    }
    const before = this.sql.counters.rowsRead;
    let rows: Row[] = [];
    const ROLLBACK = Symbol('rollback');
    try {
      this.sql.tx(() => {
        rows = this.sql.exec<Row>(query, ...binds);
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    return {
      rows: rows.slice(0, maxRows),
      truncated: rows.length > maxRows,
      rowsRead: this.sql.counters.rowsRead - before,
    };
  }

  /**
   * One page of a table's rows, by rowid, for the dump route: the operator pages every
   * data table in `DATA_TABLES` order and writes them out with `schemaSql` at the top,
   * which is a file `sqlite3` can rebuild an account from. The FTS tables are not dumped;
   * their triggers refill them as the rows are re-inserted.
   */
  dumpPage(table: DataTable, afterRowid = 0, limit = 500): { rows: Row[]; nextRowid: number | null } {
    this.ready();
    if (!DATA_TABLES.includes(table)) throw new Error(`not a data table: ${table}`);
    const rows = this.sql.exec<Row & { _rowid: number }>(
      `SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`,
      afterRowid,
      limit,
    );
    const last = rows[rows.length - 1];
    return { rows, nextRowid: rows.length === limit && last ? last._rowid : null };
  }

  /** The CREATE statements the database holds, in creation order: the dump's first line. */
  schemaSql(): string[] {
    this.ready();
    return this.sql
      .exec<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid`)
      .map((r) => r.sql);
  }

  /** Rows read and written since the last reset: what a test bounds a query with. */
  counters(): { rowsRead: number; rowsWritten: number; statements: number } {
    return { ...this.sql.counters };
  }

  resetCounters(): void {
    this.sql.resetCounters();
  }
}
