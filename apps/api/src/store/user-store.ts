import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_NOTE_SORT,
  type FieldDef,
  type FieldScale,
  type FieldType,
  type FeedNote,
  type FeedPage,
  type FeedReset,
  type FieldValue,
  type Note,
  type NoteFieldsPatch,
  type NotebookDefinition,
  type SnapshotPage,
} from '@unbent/shared';
import { AttachmentsStore, type FileSummary } from './attachments.js';
import { DeletedBlobs } from './deleted-blobs.js';
import { cutByBytes, Feed, FEED_META, FEED_PAGE_BYTES, lastWordPerEntity, type FeedRow } from './feed.js';
import { classify, liftLiterals, scanStatements, statementKind, statementText, StoreLoading, tooLongToRun, type LoadMarker } from './load.js';
import { appliedMigrations, migrate } from './migrate.js';
import { NotesStore, type CountOptions, type ListOptions, type SearchFilters } from './notes.js';
import { cursorAfter, nextCursor } from './notes-shared.js';
import { restoreAbortReason, restoreRefusedReason } from './restore.js';
import { SCHEMA } from './schema/index.js';
import { instrumentedSql, type Sql } from './sql.js';
import { DATA_TABLES, DUMP_TABLES, type DataTable, type DumpTable } from './tables.js';

export { DATA_TABLES, DUMP_TABLES, type DataTable, type DumpTable };

/**
 * What the object is allowed to see of the Worker's environment: nothing. Naming `BLOBS`,
 * `AI`, `DB` or a secret here would be refused by review before it was refused by the
 * compiler, but the compiler refusing it is what makes rule 1 in AGENTS.md — the object
 * touches its SQLite and nothing else — a property of the code rather than a habit. It
 * carried `DB` for the one-time copy out of the shared tables at the cutover; that went
 * with the tables (migration 0036).
 */
export type StoreEnv = Record<never, never>;

/**
 * The `_meta` keys the object writes. Reserved names, kept in one place. Objects that
 * existed at the cutover also hold `migrated_from_d1`, the mark the one-time copy out of
 * the shared tables left; nothing reads or writes it now, and the schema file's comment
 * still names it because that file is never edited once applied.
 */
const META = {
  /** The user this object belongs to: `ctx.id.name`, written on first wake, refused on a mismatch after. */
  userId: 'user_id',
  /** The change feed's counter and epoch; see `FEED_META`, which the feed reads them by. */
  ...FEED_META,
} as const;

/**
 * The one key in the object's key-value storage, which `deleteAll` clears and `wipe` then
 * writes: that this object was wiped. Read before the schema is touched, so a deleted
 * account's object stays empty storage across an eviction rather than growing a schema
 * again on every wake, and `stats` and `usage` can confirm the deletion without
 * rebuilding anything. (At the cutover it was also what kept a wiped object from copying
 * its account back out of the shared tables; those are gone.)
 */
const WIPED_KEY = 'wiped';

/**
 * The other key in the object's key-value storage: that a dump is being loaded into this
 * object, and which load (`LoadMarker`). Written by `loadBegin` straight after the
 * `deleteAll` that empties the object, read before the schema is touched on every wake,
 * and removed by `loadFinish` last of all. While it is there the object has some of a
 * dump and none of a schema it would trust, and every data method refuses; see
 * `StoreLoading`. `deleteAll` takes it with everything else, so a `wipe` ends a load too.
 */
const LOADING_KEY = 'loading';

/** What a load holds in memory between pages: the partial statement a page ended in, and the decoder that joins a character split by one. */
interface LoadInFlight {
  id: string;
  decoder: TextDecoder;
  remainder: string;
}

/** What `loadFinish` answers: what was run, what the schema runner then applied, and the store as it is now. */
export interface LoadResult {
  statements: number;
  pages: number;
  /** Schema files the dump lacked, applied before the store answered anything. */
  migrated: string[];
  /** The feed's new epoch, so every device of the account starts over from a snapshot. */
  feedEpoch: string;
  /**
   * Rows whose foreign key points at nothing, which a dump read while the store was
   * written to can hold (`dumpSlice`). The dump loads anyway, as `sqlite3` would load it,
   * and the count is for the operator to weigh.
   */
  foreignKeyViolations: number;
  stats: StoreStats;
}

/** One row as SQLite hands it back: the four value types it has, by column name. */
export type Row = Record<string, SqlStorageValue>;


/** Where a dump got to: an index into `DUMP_TABLES`, and the last rowid written from that table. */
export interface DumpPosition {
  table: number;
  after: number;
}

/** A run of the dump's INSERT statements, encoded, and where the next run starts (null at the end). */
export interface DumpSlice {
  bytes: Uint8Array;
  rows: number;
  next: DumpPosition | null;
  /** On the last slice only: the feed's mark as that slice was read. See `dumpSlice`. */
  endMark?: string;
}

/**
 * What `dumpBegin` answers: the feed's mark, and either that it is the mark the caller
 * already has a dump of, or the schema's CREATE statements and the first slice.
 */
export type DumpStart = { mark: string; unchanged: true } | ({ mark: string; unchanged: false; schema: string[] } & DumpSlice);

/** What `stats` reports: the shape the ops route and the sweep read. */
export interface StoreStats {
  userId: string;
  /** Bytes the object's SQLite occupies, as the runtime reports it. */
  databaseSize: number;
  migrations: string[];
  counts: Record<DataTable, number>;
  /** True when `wipe` has run and nothing has woken the schema since: the object is empty storage. */
  wiped: boolean;
  /** Set while a dump is being loaded (`loadBegin`): the counts above are zero and the store refuses every data call. */
  loading: LoadMarker | null;
  /**
   * When the store was last written to, read from the store itself as `usage` reads it:
   * the newest change-feed row's time, or null for a store nothing has written yet. The
   * directory's `last_active_at` is this same value as of the last sweep, so on the
   * operator's account page it was up to an hour stale, or older for an account the
   * sweep had not reached — "three days ago" under a store with five hundred writes
   * made that morning (MAK-190). The page shows this one; the list keeps the sweep's.
   */
  lastWriteAt: number | null;
}

/**
 * What the sweep records, and nothing that costs a table scan: the size the runtime
 * reports and the one `note_counts` row. `stats` counts every table and is the operator's;
 * an hourly pass calling it on an archive-sized account would have read every row of the
 * account twenty-four times a day (found in review), against the same daily row budget
 * the shared database ran out of twice.
 */
export interface StoreUsage {
  databaseSize: number;
  /** Live and trashed notes together: what the account holds. */
  notes: number;
  /**
   * When the store was last written to: the newest change-feed row's time, which every
   * write records (`Feed.record`), or null for a store nothing has written yet. One row
   * off the table's primary key. The sweep records it in the directory as
   * `last_active_at`, which the operator page sorts and shows accounts by; until it did,
   * that column had no writer (found in review).
   */
  lastWriteAt: number | null;
  wiped: boolean;
}

/**
 * How many bytes of note bodies and file texts one export page carries before it is cut
 * short. An RPC result is capped at 32 MiB by the runtime, and a page of a hundred notes
 * whose scans each hold half a million characters of text would pass it; eight leaves
 * room for the rest of the page around the text. A page cut here comes back with a
 * cursor from its last row, so the client walks on as if the page had been full.
 */
export const EXPORT_PAGE_BYTES = 8 * 1024 * 1024;

/**
 * The same budget for a dump slice, in characters of the SQL it carries:
 * `attachment_text` rows are up to half a million characters each, and five hundred of
 * them would pass the RPC ceiling many times over.
 */
export const DUMP_PAGE_BYTES = 8 * 1024 * 1024;

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
 * it was created under. Every wake is local reads only.
 *
 * Every public method is one billable request to the object, so the surface has two
 * layers: the repository methods one for one, for the facade that keeps `NotesRepo`'s
 * and `AttachmentsRepo`'s signatures, and composites that answer what a route asks in
 * one call where it used to make two or three — a list with its count, a note with its
 * files, a notebook list with the unfiled count. Prefer adding to the second layer over
 * a second call in the same request.
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
  private feed: Feed;
  private notes: NotesStore;
  private attachments: AttachmentsStore;
  private deletedBlobs: DeletedBlobs;
  private wiped = false;
  private loading: LoadMarker | null = null;
  private loadInFlight: LoadInFlight | null = null;

  constructor(ctx: DurableObjectState, env: StoreEnv) {
    super(ctx, env);
    // Objects are only ever created with `idFromName(userId)`; a string id has no name and
    // would be an object nobody could tell whose it was. Refusing here keeps `_meta.user_id`
    // meaningful and makes the mistake loud at the one place it can be made.
    const name = ctx.id.name;
    if (!name) throw new Error('UserStore must be created with idFromName(userId)');
    this.userId = name;
    this.sql = instrumentedSql(ctx.storage, name);
    this.feed = new Feed(this.sql);
    // One, shared: the stores write it and the sweep's methods here read and clear it,
    // so "every row deletion tombstones" is a property of one object, not of three
    // agreeing.
    this.deletedBlobs = new DeletedBlobs(this.sql);
    this.notes = new NotesStore(this.sql, this.feed, this.deletedBlobs);
    this.attachments = new AttachmentsStore(this.sql, this.feed, this.deletedBlobs);
    ctx.blockConcurrencyWhile(async () => {
      // Pings on the feed's sockets are answered at the edge, without waking the object;
      // object-wide and idempotent, so set once here rather than on every handshake.
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
      // A wiped object wakes as it was left: empty, with no schema, and with the copy
      // from D1 never to run again. `ready()` rebuilds the schema if anything asks.
      if (ctx.storage.kv.get(WIPED_KEY) === true) {
        this.wiped = true;
        return;
      }
      // A load that did not finish wakes refusing: no schema is built, since the dump's
      // own is what should be there and the runner would create one ahead of it.
      const loading = ctx.storage.kv.get<LoadMarker>(LOADING_KEY);
      if (loading) {
        this.loading = loading;
        return;
      }
      this.bootstrap();
    });
  }

  /**
   * Migrates, checks the engine, and claims the object for its user. Idempotent: on every
   * wake after the first it applies nothing and reads three rows.
   */
  private bootstrap(): string[] {
    const applied = migrate(this.ctx.storage, SCHEMA);

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
    return applied;
  }

  /**
   * Rebuilds the schema after a `wipe`, the first time anything asks for data again. A
   * wiped object starts empty by design — the account was deleted, or a test fixture
   * purged.
   */
  private ready(): void {
    if (this.loading) throw new StoreLoading(this.loading);
    if (!this.wiped) return;
    this.bootstrap();
    this.ctx.storage.kv.delete(WIPED_KEY);
  }

  // --- Operator surface ------------------------------------------------------------------

  /** Cheap liveness: wakes the object (and so runs any pending migration) and names it. */
  ping(): { userId: string } {
    return { userId: this.userId };
  }

  /** Row counts, size and schema version, for the ops route and the sweep. */
  stats(): StoreStats {
    const counts = Object.fromEntries(DATA_TABLES.map((t) => [t, 0])) as Record<DataTable, number>;
    if (this.wiped || this.loading) {
      return { userId: this.userId, databaseSize: this.ctx.storage.sql.databaseSize, migrations: [], counts, wiped: this.wiped, loading: this.loading, lastWriteAt: null };
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
      loading: null,
      lastWriteAt: this.sql.first<{ at: number }>(`SELECT at FROM changes ORDER BY seq DESC LIMIT 1`)?.at ?? null,
    };
  }

  /** What the sweep records: a few rows per account, never a table scan. See `StoreUsage`. */
  usage(): StoreUsage {
    const databaseSize = this.ctx.storage.sql.databaseSize;
    // Unavailable rather than empty: the sweep defers on it and records nothing.
    if (this.loading) throw new StoreLoading(this.loading);
    if (this.wiped) return { databaseSize, notes: 0, lastWriteAt: null, wiped: true };
    const counts = this.sql.first<{ live: number; trashed: number }>(`SELECT live, trashed FROM note_counts WHERE id = 1`);
    const last = this.sql.first<{ at: number }>(`SELECT at FROM changes ORDER BY seq DESC LIMIT 1`);
    return {
      databaseSize,
      notes: (counts?.live ?? 0) + (counts?.trashed ?? 0),
      lastWriteAt: last?.at ?? null,
      wiped: false,
    };
  }

  /**
   * The sweep's one call on a live account: its usage, and the deleted files whose
   * thirty-five days are up as of `now` — at most `EXPIRED_BLOBS_PER_VISIT`, one R2
   * `delete()`'s worth. One call rather than two because every account is visited on
   * every walk of the directory and each call is a billable request, and the sweep's
   * batch is sized against the Free plan's fifty subrequests an invocation
   * (`lib/sweep.ts`). `now` is the Worker's,
   * and the same `now` goes to `forgetBlobs` afterwards, so the two agree on what was due.
   *
   * The read is a range on `idx_deleted_blobs_due`: an account with nothing due reads one
   * index entry at most, so this stays a periodic read that scans nothing. A wiped object
   * answers without rebuilding its schema, as `usage` does.
   */
  sweepVisit(now: number): StoreUsage & { expiredBlobs: string[] } {
    const usage = this.usage();
    if (usage.wiped) return { ...usage, expiredBlobs: [] };
    return { ...usage, expiredBlobs: this.deletedBlobs.expired(now) };
  }

  /**
   * The sweep's second call, after it has deleted `keys` from R2: drop their tombstones.
   * Only those still due as of `now` go; see `DeletedBlobs.forget`. Not a feed write — a
   * client holds no deleted files — so it does not go through `writing()`.
   */
  forgetBlobs(keys: string[], now: number): { forgotten: number } {
    this.ready();
    return this.sql.tx(() => ({ forgotten: this.deletedBlobs.forget(keys, now) }));
  }

  /**
   * Deletes everything: every table, the schema, the `_meta` row. For account deletion and
   * for the test fixtures' purge.
   *
   * The instance stays alive and empty, and stays that way across an eviction: the
   * marker written here is read before the schema is touched on the next wake. `ready()`
   * rebuilds the schema if a data method is called afterwards, so a wiped object that is
   * reached again — a deletion that failed further along and was retried, a test —
   * behaves as a brand-new one that starts empty rather than throwing "no such table".
   */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    // After `deleteAll`, so it is the one thing left; see `WIPED_KEY`.
    this.ctx.storage.kv.put(WIPED_KEY, true);
    this.wiped = true;
    this.loading = null;
    this.loadInFlight = null;
  }

  // --- Loading a dump ----------------------------------------------------------------------
  //
  // `POST /api/admin/store/load` (lib/load.ts) replaces this store with a dump from the
  // backups bucket, the file `dumpBegin` and `dumpSlice` write: the way back from a fault
  // noticed after the thirty days of history, and the last step of the runbook for
  // losing the whole Cloudflare account. Three calls, because the dump is too big for
  // one — an archive's is 31 MB of SQL and an RPC argument is capped at 32 MiB — and
  // because nothing can hold a transaction open across two calls to the object. Each page
  // is one transaction; the marker in key-value storage (`LOADING_KEY`) is what keeps a
  // store between pages, or abandoned between them, from answering as if it were whole.

  /**
   * Empties the object and marks it loading. Everything — tables, schema, `_meta`, the
   * wiped mark — goes, so the dump's own `CREATE`s and `_migrations` rows land in a clean
   * database, as they would under `sqlite3`.
   *
   * `undo` is the runtime's bookmark of the store as it was the instant before, for the
   * restore route to wind back to if the load was a mistake; null where the runtime keeps
   * no history (Miniflare), which is what the dump the route writes first is for. Taken
   * before anything is deleted, and a failure to take it stops the load before it starts.
   * `before` is that dump's key, kept here with the bookmark so a load started over on a
   * store that is already loading — the way out of a failed one — keeps the real ways
   * back: a bookmark taken now would be of the half-loaded store, and the route writes
   * no second dump of one (found in review).
   *
   * Between the `deleteAll` and the marker there is one await of storage. The runtime
   * commits a call's storage writes together up to an await on something that is not
   * storage, so the two land as one; a crash in that await would leave an empty object
   * with no marker, which the next wake would build a schema into, and the dump the
   * route wrote first is the answer to that as to any mistaken load.
   */
  async loadBegin(dump: { key: string; before: string | null }): Promise<{ loadId: string; undo: string | null; before: string | null }> {
    let undo: string | null;
    let before = dump.before;
    if (this.loading) {
      undo = this.loading.undo;
      before = this.loading.before ?? before;
    } else {
      try {
        undo = await this.ctx.storage.getCurrentBookmark();
      } catch (err) {
        if (!/does not implement point-in-time recovery/i.test(err instanceof Error ? err.message : String(err))) throw err;
        undo = null;
      }
      // Miniflare answers a bookmark of zeros rather than refusing (measured 2026-10-06);
      // nothing can be restored to it, so the answer must not offer it.
      if (undo !== null && /^[0-]+$/.test(undo)) undo = null;
    }
    await this.ctx.storage.deleteAll();
    const marker: LoadMarker = { id: crypto.randomUUID(), key: dump.key, startedAt: Date.now(), pages: 0, statements: 0, undo, before };
    this.ctx.storage.kv.put(LOADING_KEY, marker);
    this.loading = marker;
    this.wiped = false;
    // Fatal: a damaged byte in a dump stops the load rather than loading as U+FFFD
    // inside someone's note.
    this.loadInFlight = { id: marker.id, decoder: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }), remainder: '' };
    console.log(`[store] load begun user=${this.userId} key=${dump.key} undo=${undo ?? 'none'} before=${before ?? 'none'}`);
    return { loadId: marker.id, undo, before };
  }

  /**
   * Runs the whole statements of one page of the dump, cut anywhere, in one transaction;
   * the partial statement it ends in waits for the next page. Foreign keys are off for
   * the page, as the file asks (`PRAGMA foreign_keys = OFF` is its first statement, and a
   * dump read while the store was written to can hold a row whose parent was read before
   * it was there). Off at the start of the call and not back on at its end: the runtime
   * wraps a call's writes in a transaction of its own, inside which the pragma is a
   * no-op (measured 2026-10-06: `ON` after the page's inserts left it off, and
   * `bootstrap` then refused the store), so the one place it can be set is before the
   * call writes anything. `loadFinish` sets it on the same way, first thing.
   *
   * A page from any load but the one in flight is refused — after an eviction the
   * remainder is gone, and the only honest answer is to start the load again — and the
   * store stays loading either way.
   */
  loadPage(loadId: string, bytes: Uint8Array): { statements: number } {
    const load = this.inFlightLoad(loadId);
    this.ctx.storage.sql.exec('PRAGMA foreign_keys = OFF');
    try {
      const scan = scanStatements(load.remainder + load.decoder.decode(bytes, { stream: true }));
      const ran = this.runDumpStatements(scan.statements);
      load.remainder = scan.rest;
      this.recordLoad(ran, 1);
      return { statements: ran };
    } catch (err) {
      // The page's transaction rolled back, but the decoder has moved past its bytes, so
      // no page can follow this one: the load in flight ends, the marker stays, and the
      // only way on is a fresh `loadBegin`.
      this.loadInFlight = null;
      throw err;
    }
  }

  /**
   * Ends the load: the dump's last statement, then the checks that make the store one
   * this code can answer for, then the schema files the dump lacked, a new feed epoch,
   * and the marker's removal. Any check that fails leaves the marker in place: the store
   * keeps refusing, and the operator winds it back or loads again.
   *
   * The checks. The dump's `_meta.user_id` must be this object's: a dump is only ever
   * addressed under its own account by the route, so a mismatch is a file that is not a
   * dump of this account, and loading it would be one account's notes under another's
   * id and prefix. Its `_migrations` must name only schema files this code has, since the
   * code cannot run against a schema it does not know; an older dump is fine, and
   * `bootstrap` applies what it lacks here rather than on the next wake, so the store
   * never answers at the dump's version. Foreign keys are checked but not enforced; see
   * `LoadResult`.
   */
  loadFinish(loadId: string): LoadResult {
    const load = this.inFlightLoad(loadId);
    // Before any write of this call; see `loadPage`. What is left to run is the last
    // statement a page boundary cut, which the file's order puts after every data row
    // but one page's tail of them; a tail row that needed foreign keys off is a dump
    // that could not be loaded with `sqlite3` either, and the error names it.
    this.ctx.storage.sql.exec('PRAGMA foreign_keys = ON');
    const text = load.remainder + load.decoder.decode();
    const scan = scanStatements(text);
    if (statementText(scan.rest) !== '') throw new Error(`the dump ended inside a statement (${statementKind(scan.rest)}); the file is cut short`);
    const ran = this.runDumpStatements(scan.statements);
    this.recordLoad(ran, 0);
    load.remainder = '';

    const owner = this.sql.first<{ value: string }>(`SELECT value FROM _meta WHERE key = ?1`, META.userId);
    if (!owner) throw new Error('the dump has no _meta.user_id row; it is not a store dump');
    if (owner.value !== this.userId) throw new Error(`the dump is of account ${owner.value}, not ${this.userId}`);
    const known = new Set(SCHEMA.map((f) => f.name));
    const names = appliedMigrations(this.ctx.storage);
    if (names.length === 0) throw new Error('the dump records no schema files; it is not a store dump');
    const unknown = names.filter((n) => !known.has(n));
    if (unknown.length > 0) throw new Error(`the dump is from a newer schema than this code: ${unknown.join(', ')}`);

    const migrated = this.bootstrap();
    const violations = this.ctx.storage.sql.exec(`PRAGMA foreign_key_check`).toArray().length;
    const feedEpoch = this.newEpoch();
    this.ctx.storage.kv.delete(LOADING_KEY);
    const marker = this.loading!;
    this.loading = null;
    this.loadInFlight = null;
    console.log(
      `[store] load finished user=${this.userId} key=${marker.key} pages=${marker.pages} statements=${marker.statements} migrated=${migrated.join(',') || 'none'} fkViolations=${violations} epoch=${feedEpoch}`,
    );
    this.tell(this.feed.seq());
    return { statements: marker.statements, pages: marker.pages, migrated, feedEpoch, foreignKeyViolations: violations, stats: this.stats() };
  }

  private inFlightLoad(loadId: string): LoadInFlight {
    const load = this.loadInFlight;
    if (!this.loading || !load || load.id !== loadId || this.loading.id !== loadId) {
      throw new Error(
        this.loading
          ? `no load ${loadId} is in flight on this store; the one begun at ${new Date(this.loading.startedAt).toISOString()} was interrupted. Start the load again.`
          : `no load is in flight on this store`,
      );
    }
    return load;
  }

  /** The statements of a page that run, in one transaction with foreign keys off; how many ran. */
  private runDumpStatements(statements: string[]): number {
    const run = statements.filter((s) => {
      const kind = classify(s);
      if (kind === 'refuse') throw new Error(`the dump holds a statement a load does not run: ${statementKind(s)}`);
      return kind === 'run';
    });
    if (run.length === 0) return 0;
    this.sql.tx(() => {
      for (const statement of run) {
        // A row too long to run as text runs with its values bound; see `MAX_STATEMENT_BYTES`.
        if (!tooLongToRun(statement)) {
          this.sql.exec(statement);
        } else {
          const { sql, values } = liftLiterals(statementText(statement));
          this.sql.exec(sql, ...values);
        }
      }
    });
    return run.length;
  }

  private recordLoad(statements: number, pages: number): void {
    const marker = { ...this.loading!, pages: this.loading!.pages + pages, statements: this.loading!.statements + statements };
    this.ctx.storage.kv.put(LOADING_KEY, marker);
    this.loading = marker;
  }

  /**
   * What a restore to `target` would wind back to, without scheduling anything: the
   * bookmark a time resolves to, and the store as it is now. The operator's dry run, and
   * the way to find out that a time is outside the thirty days before anything is at stake.
   * One call for both, since each is a billable request.
   */
  async restorePreview(target: { at: number } | { bookmark: string }): Promise<{ bookmark: string; current: StoreStats }> {
    let bookmark: string;
    try {
      bookmark = 'bookmark' in target ? target.bookmark : await this.ctx.storage.getBookmarkForTime(target.at);
    } catch (err) {
      throw new Error(restoreRefusedReason(err));
    }
    return { bookmark, current: this.stats() };
  }

  /**
   * Winds the whole database back to `target` — a time in the last thirty days, or a
   * bookmark — and restarts the object so the restore happens. For a bad migration or a
   * bad edit; restoring another account's notes into this one is the export and import.
   *
   * Never returns. The runtime applies a restore when a session starts, so the object
   * aborts itself to start one, and the request in flight — this one — fails with the
   * abort's reason. That reason carries the bookmark of the store as it was just before
   * the restore (`restoreAbortReason`), which is the undo: restoring to it puts everything
   * back, the same way, for thirty days. It is logged here too, in case the message does
   * not survive the trip to the caller.
   *
   * One call that schedules and aborts, rather than one to schedule and a second to
   * restart. Between two calls the restore would be scheduled but not yet applied; if the
   * second never arrived, it would fire whenever the object next restarted — an eviction,
   * a deploy, days later — and wind back whatever had been written in between. Here
   * nothing awaits between scheduling and aborting, so no other request can land in the
   * gap either.
   *
   * Everything in the object's storage goes back together: the tables, the schema
   * version, `_meta`, the wiped mark in key-value storage. A restore to before a schema
   * file was applied is migrated again on the wake that follows. R2 is not the object's
   * and is untouched, so files uploaded after the restored time are orphans the
   * account's own blob sweep reclaims. Files deleted since come back whole: a deleted
   * file's object stays in the bucket for thirty-five days (`DeletedBlobs`), five more
   * than the history reaches, and its tombstone is wound back with the row that replaces
   * it, so nothing deletes the object afterwards.
   */
  async restoreTo(target: { at: number } | { bookmark: string }): Promise<void> {
    // A failure here is before anything is scheduled, and is marked so: the route answers
    // it as refused. Any other failure of this call is one whose outcome it cannot know.
    let bookmark: string;
    let undo: string;
    try {
      bookmark = 'bookmark' in target ? target.bookmark : await this.ctx.storage.getBookmarkForTime(target.at);
      undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    } catch (err) {
      throw new Error(restoreRefusedReason(err));
    }
    console.log(`[store] restore scheduled user=${this.userId} to=${bookmark} undo=${undo}`);
    this.ctx.abort(restoreAbortReason(bookmark, undo));
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
   * The result is capped, at `maxRows` rows and at `DUMP_PAGE_BYTES` of them, because it
   * crosses RPC (32 MiB) and lands in a JSON response; an operator wanting more pages
   * with LIMIT/OFFSET like anyone else. The cap is applied as the rows are read off the
   * raw cursor, not to a result already built: `SELECT * FROM attachment_text` on an
   * archive would otherwise pull every text into the object's memory before the first
   * five hundred were kept, and five hundred texts can pass the RPC ceiling on their own
   * (found in review). The one other query here that bypasses the seam's metering, for
   * that reason; what it read is counted off the cursor instead.
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
    const rows: Row[] = [];
    let truncated = false;
    let rowsRead = 0;
    const ROLLBACK = Symbol('rollback');
    try {
      this.sql.tx(() => {
        const cursor = this.ctx.storage.sql.exec<Row>(query, ...binds);
        let bytes = 0;
        for (const row of cursor) {
          for (const v of Object.values(row)) bytes += typeof v === 'string' ? v.length : v instanceof ArrayBuffer ? v.byteLength : 8;
          // Always at least one row, so a single oversized row can still be looked at.
          if (rows.length >= maxRows || (bytes > DUMP_PAGE_BYTES && rows.length > 0)) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        rowsRead = cursor.rowsRead;
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    return { rows, truncated, rowsRead };
  }

  /**
   * The start of a dump, in one call: the feed's counter as a `mark`, and — unless the
   * mark is `unless`, which is how the daily backup asks "has anything changed since the
   * dump I already have?" — the schema and the first slice of rows. An account that has
   * not changed costs the backup this call and nothing else; a small one that has is
   * dumped whole by it, since a slice crosses tables. See `lib/dump.ts`.
   *
   * The mark is the feed's epoch and seq together. The seq alone would not do: a restore
   * winds it back and the restore route gives the feed a new epoch, so a store wound back
   * and written to again can come to the same seq with different rows under it.
   */
  dumpBegin(unless: string | null = null): DumpStart {
    this.ready();
    const mark = this.dumpMark();
    if (mark === unless) return { mark, unchanged: true };
    return { mark, unchanged: false, schema: this.schemaSql(), ...this.dumpSlice({ table: 0, after: 0 }) };
  }

  /**
   * The dump's rows from `from` on, across tables in `DUMP_TABLES` order, until the slice
   * reaches `DUMP_PAGE_BYTES` of SQL text; `next` is where the following call starts, and
   * null once every table is done. One call per slice rather than per table, because
   * every call is a billable request and a subrequest of the Worker that makes it: a
   * per-table page made every dump at least fourteen calls, which is most of the Free
   * plan's fifty for an account with one note in it. An archive is about as many calls
   * as it has eight-megabyte slices.
   *
   * A slice is not a snapshot of the store with the one before it. Nothing can hold a
   * read open across two calls to the object, so a write between two slices lands in
   * whichever tables have not been read yet — and the gaps include a multipart upload's
   * parts, seconds rather than milliseconds. Such a file still loads, since it loads with
   * foreign keys off, which is why it must say so: the last slice carries the mark as it
   * is then (`endMark`), the file ends with both marks, and the backup records no mark
   * for a dump whose two differ, so the account is dumped again on the next day's run.
   */
  dumpSlice(from: DumpPosition): DumpSlice {
    this.ready();
    const lines: string[] = [];
    let chars = 0;
    for (let t = from.table; t < DUMP_TABLES.length; t++) {
      const after = t === from.table ? from.after : 0;
      const page = this.dumpTableOnto(DUMP_TABLES[t]!, after, DUMP_PAGE_BYTES - chars, lines);
      chars += page.chars;
      if (page.cut) return { bytes: encodeLines(lines), rows: lines.length, next: { table: t, after: page.last } };
    }
    return { bytes: encodeLines(lines), rows: lines.length, next: null, endMark: this.dumpMark() };
  }

  /** The feed's epoch and seq, as `dumpBegin` and the last slice report them. */
  private dumpMark(): string {
    return `${this.feed.epoch()}:${this.feed.seq()}`;
  }

  /**
   * Reads `table`'s rows after `after` by rowid onto `lines` as INSERT statements, and
   * stops before the row that would take the text past `budget` characters — unless
   * `lines` is still empty, or a single row larger than the budget could never be dumped.
   * `last` is the rowid of the last row taken (`after` when none was), and `cut` whether
   * the budget, not the table, ended the read.
   *
   * The rows are turned into SQL here rather than in the Worker because of where the CPU
   * is. A Worker invocation on the Free plan has ten milliseconds of it, and quoting
   * eight megabytes of text takes more than that; an object request has thirty seconds.
   * Encoded to bytes here too (`encodeLines`), for the same reason: a string crossing RPC
   * is decoded on the Worker's side and would be encoded again for the response, both
   * linear in the slice, where a byte array crosses as a copy and is written out as it is.
   *
   * The cut is by the statements' own length as they are made, off the raw cursor, row
   * by row, so it bounds the object's memory and not only the result — the result crosses
   * RPC, which is capped at 32 MiB. A character is at most three bytes of UTF-8 in a
   * statement, so eight million of them stay inside the cap. It is the one read here that
   * bypasses the `Sql` seam, for that row-by-row cut; its rows are added to the seam's
   * counters by hand, so the rows-read test sees a dump as it sees any other read. The
   * row the budget stopped at was read and is read again by the next call: one row per
   * slice, which is what that test allows over one read of every row.
   */
  private dumpTableOnto(table: DumpTable, after: number, budget: number, lines: string[]): { chars: number; last: number; cut: boolean } {
    const cursor = this.ctx.storage.sql.exec<Row & { _rowid: number }>(
      `SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid`,
      after,
    );
    let chars = 0;
    let last = after;
    let cut = false;
    for (const row of cursor) {
      const { _rowid, ...columns } = row;
      const names = Object.keys(columns);
      const line = `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((n) => sqlLiteral(columns[n])).join(', ')});`;
      if (chars + line.length > budget && lines.length > 0) {
        cut = true;
        break;
      }
      lines.push(line);
      chars += line.length + 1;
      last = _rowid;
    }
    this.sql.counters.rowsRead += cursor.rowsRead;
    this.sql.counters.statements += 1;
    return { chars, last, cut };
  }

  /**
   * The CREATE statements the database holds, in creation order, for the dump. Each FTS5
   * virtual table's shadow tables (`notes_fts_data`, `_idx`, `_docsize`, `_config`) are
   * left out: SQLite lists them in `sqlite_master` as ordinary tables, but they belong to
   * the virtual table, which creates them itself and refuses to if they already exist.
   */
  schemaSql(): string[] {
    this.ready();
    return this.sql
      .exec<{ sql: string }>(
        `SELECT sql FROM sqlite_master
          WHERE sql IS NOT NULL AND NOT (type = 'table' AND name GLOB '*_fts_*')
          ORDER BY rowid`,
      )
      .map((r) => r.sql);
  }

  /** Rows read and written since the last reset: what a test bounds a query with. */
  counters(): { rowsRead: number; rowsWritten: number; statements: number } {
    return { ...this.sql.counters };
  }

  resetCounters(): void {
    this.sql.resetCounters();
  }

  /**
   * Every write passes through here: the store's method, then the push.
   *
   * The push is the feed's last seq, sent on every socket attached to this object, after
   * the method — and so its transaction — has returned. A method that threw rolled its
   * transaction back before its feed rows were written, so there is nothing to announce
   * and the throw passes straight through. The sockets are told nothing but the number;
   * they pull the page themselves, which keeps the push an optimisation the feed is
   * complete without.
   */
  private writing<T>(fn: () => T): T {
    this.ready();
    const result = fn();
    this.announce();
    return result;
  }

  private announce(): void {
    const seq = this.feed.takeAnnouncement();
    if (seq !== null) this.tell(seq);
  }

  /** `{"seq": N}` to every socket: the one message the push ever sends. */
  private tell(seq: number): void {
    const message = JSON.stringify({ seq });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Closing under us; its close event is on its way.
      }
    }
  }

  // --- Notes: the repository, one for one -----------------------------------------------
  //
  // Each of these is `NotesStore`'s method of the same name, behind `ready()` — or, for a
  // write, behind `writing()`, which announces afterwards. They are spelled out rather
  // than proxied so the RPC surface is a list a reader can grep, the types cross the
  // boundary as written, and a method the object should not expose cannot leak through a
  // wildcard.

  list(opts: ListOptions) { this.ready(); return this.notes.list(opts); }
  listFull(opts: ListOptions) { this.ready(); return this.notes.listFull(opts); }
  count(opts: CountOptions = {}) { this.ready(); return this.notes.count(opts); }
  recountNotes() { return this.writing(() => this.notes.recountNotes()); }
  get(id: string, opts?: { includeTrashed?: boolean | undefined }) { this.ready(); return this.notes.get(id, opts); }
  create(input: Parameters<NotesStore['create']>[0]) { return this.writing(() => this.notes.create(input)); }
  duplicate(id: string, newId: string) { return this.writing(() => this.notes.duplicate(id, newId)); }
  createOrFind(input: Parameters<NotesStore['createOrFind']>[0]) { return this.writing(() => this.notes.createOrFind(input)); }
  duplicateOrFind(id: string, newId: string) { return this.writing(() => this.notes.duplicateOrFind(id, newId)); }
  update(id: string, patch: Parameters<NotesStore['update']>[1]) { return this.writing(() => this.notes.update(id, patch)); }
  appendToBody(id: string, markdown: string) { return this.writing(() => this.notes.appendToBody(id, markdown)); }
  listRevisions(id: string) { this.ready(); return this.notes.listRevisions(id); }
  getRevision(id: string, revisionId: number) { this.ready(); return this.notes.getRevision(id, revisionId); }
  clearRevisions(id: string) { this.ready(); return this.notes.clearRevisions(id); }
  restoreRevision(id: string, revisionId: number, ifUpdatedAt?: number) { return this.writing(() => this.notes.restoreRevision(id, revisionId, ifUpdatedAt)); }
  remove(id: string) { return this.writing(() => this.notes.remove(id)); }
  restore(id: string) { return this.writing(() => this.notes.restore(id)); }
  purgeOne(id: string) { return this.writing(() => this.notes.purgeOne(id)); }
  removeMany(ids: string[]) { return this.writing(() => this.notes.removeMany(ids)); }
  restoreMany(ids: string[]) { return this.writing(() => this.notes.restoreMany(ids)); }
  purgeMany(ids: string[]) { return this.writing(() => this.notes.purgeMany(ids)); }
  updateMany(ids: string[], patch: Parameters<NotesStore['updateMany']>[1]) { return this.writing(() => this.notes.updateMany(ids, patch)); }
  importNote(input: Parameters<NotesStore['importNote']>[0]) { return this.writing(() => this.notes.importNote(input)); }
  setBody(id: string, body: string) { return this.writing(() => this.notes.setBody(id, body)); }
  search(rawQuery: string, limit: number, filters: SearchFilters = {}, scopeDrivenSearchMax?: number) {
    this.ready();
    return this.notes.search(rawQuery, limit, filters, scopeDrivenSearchMax);
  }
  purge(scope: 'trashed' | 'all', limit?: number) { return this.writing(() => this.notes.purge(scope, limit)); }
  listTags() { this.ready(); return this.notes.listTags(); }
  tagCounts(filter: Parameters<NotesStore['tagCounts']>[0]) { this.ready(); return this.notes.tagCounts(filter); }
  notebookByName(name: string) { this.ready(); return this.sql.tx(() => this.notes.notebookByName(name)); }
  fieldTargets(ids: string[]) { this.ready(); return this.sql.tx(() => this.notes.fieldTargets(ids)); }
  sampleTitles(exclude: string, perGroup: number, tagLimit: number) { this.ready(); return this.notes.sampleTitles(exclude, perGroup, tagLimit); }
  renameTag(id: string, name: string, opts?: { merge?: boolean | undefined }) { return this.writing(() => this.notes.renameTag(id, name, opts)); }
  deleteTag(id: string) { return this.writing(() => this.notes.deleteTag(id)); }
  countUnfiledNotes() { this.ready(); return this.notes.countUnfiledNotes(); }
  listNotebooks() { this.ready(); return this.notes.listNotebooks(); }
  createNotebook(name: string) { return this.writing(() => this.notes.createNotebook(name)); }
  updateNotebook(id: string, patch: Parameters<NotesStore['updateNotebook']>[1]) { return this.writing(() => this.notes.updateNotebook(id, patch)); }
  deleteNotebook(id: string, opts?: { trashNotes?: boolean | undefined }) { return this.writing(() => this.notes.deleteNotebook(id, opts)); }
  listFields(notebookId: string, opts?: { counts?: boolean | undefined }) { this.ready(); return this.notes.listFields(notebookId, opts); }
  fieldById(id: string) { this.ready(); return this.notes.fieldById(id); }
  listAllFields() { this.ready(); return this.notes.listAllFields(); }
  createField(notebookId: string, input: { name: string; type: FieldType; options: string[]; scale?: FieldScale | null | undefined; currency?: string | null | undefined }) {
    return this.writing(() => this.notes.createField(notebookId, input));
  }
  updateField(notebookId: string, fieldId: string, patch: Parameters<NotesStore['updateField']>[2]) {
    return this.writing(() => this.notes.updateField(notebookId, fieldId, patch));
  }
  previewConversion(notebookId: string, fieldId: string, to: FieldType, toScale?: FieldScale | null | 'fit' | undefined) {
    this.ready();
    return this.notes.previewConversion(notebookId, fieldId, to, toScale);
  }
  reorderFields(notebookId: string, ids: string[]) { return this.writing(() => this.notes.reorderFields(notebookId, ids)); }
  deleteField(notebookId: string, fieldId: string) { return this.writing(() => this.notes.deleteField(notebookId, fieldId)); }
  countOptionUsage(notebookId: string, fieldId: string, option: string) { this.ready(); return this.notes.countOptionUsage(notebookId, fieldId, option); }
  removeFieldOption(notebookId: string, fieldId: string, option: string, clear: boolean) {
    return this.writing(() => this.notes.removeFieldOption(notebookId, fieldId, option, clear));
  }
  importNotebook(definition: NotebookDefinition, opts: { create?: boolean } = {}) { return this.writing(() => this.notes.importNotebook(definition, opts)); }

  // --- Attachments: the repository, one for one -----------------------------------------
  //
  // Prefixed where a name would collide with a note method's (`remove`) or read as one
  // out of context (`record`). `ownsNote` keeps its name for the facade's sake although
  // ownership is not what it checks any more; see `AttachmentsStore.noteIsLive`.

  resolveAttachment(noteId: string, filename: string, opts?: { includeTrashed?: boolean | undefined }) { this.ready(); return this.attachments.resolve(noteId, filename, opts); }
  listAttachments(noteId: string) { this.ready(); return this.attachments.listForNote(noteId); }
  ownsNote(noteId: string) { this.ready(); return this.attachments.noteIsLive(noteId); }
  availableFilename(noteId: string, desired: string) { this.ready(); return this.attachments.availableFilename(noteId, desired); }
  recordAttachment(input: Parameters<AttachmentsStore['record']>[0], opts?: Parameters<AttachmentsStore['record']>[1]) { return this.writing(() => this.attachments.record(input, opts)); }
  removeAttachment(noteId: string, filename: string) { return this.writing(() => this.attachments.remove(noteId, filename)); }
  recordText(input: Parameters<AttachmentsStore['recordText']>[0]) { return this.writing(() => this.attachments.recordText(input)); }
  copyText(fromAttachmentId: string, to: { attachmentId: string; noteId: string; filename: string }) {
    return this.writing(() => this.attachments.copyText(fromAttachmentId, to));
  }
  writeAssistantText(noteId: string, filename: string, text: string) {
    return this.writing(() => this.attachments.writeAssistantText(noteId, filename, text));
  }
  needingText(limit: number, noteId?: string) { this.ready(); return this.attachments.needingText(limit, noteId); }
  pendingTextCount(noteId?: string) { this.ready(); return this.attachments.pendingTextCount(noteId); }
  textFor(noteId: string, filename: string) { this.ready(); return this.attachments.textFor(noteId, filename); }
  textWithRead(noteId: string, filename: string, vision?: boolean) { this.ready(); return this.attachments.textWithRead(noteId, filename, vision); }
  textsForNote(noteId: string) { this.ready(); return this.attachments.textsForNote(noteId); }
  textsForNotes(noteIds: string[]) { this.ready(); return this.attachments.textsForNotes(noteIds); }
  textsById(ids: string[]) { this.ready(); return this.attachments.textsById(ids); }
  attachmentIdFor(noteId: string, filename: string) { this.ready(); return this.attachments.idFor(noteId, filename); }
  keysForNote(noteId: string) { this.ready(); return this.attachments.keysForNote(noteId); }
  allBlobKeys(afterRowid?: number, limit?: number) { this.ready(); return this.attachments.blobKeys(afterRowid, limit); }
  /** The keys awaiting deletion, paged by key, for the account's own blob sweep to count as referenced. */
  tombstonedBlobKeys(after?: string, limit?: number) { this.ready(); return this.deletedBlobs.keys(after, limit); }

  // --- Composites: what a route asks, in one request ------------------------------------

  /**
   * `GET /notes` and MCP's `list_notes`: the page and, on the first page, the total. With
   * `summaries`, also a line per file of each note on the page (`summariesForNotes`), keyed
   * by note id, in the same call — `list_notes` asks for it when an assistant is filling
   * fields from the files. `vision` is whether the instance has the vision model; see
   * `summarize`.
   */
  listPage(list: ListOptions, count: CountOptions | null, opts: { summaries?: boolean; vision?: boolean } = {}) {
    this.ready();
    return this.sql.tx(() => {
      const items = this.notes.list(list);
      // A compact row does not select its files, so it cannot say which notes have none:
      // every note on a compact page is asked about, rather than none of them.
      const withFiles = !opts.summaries
        ? []
        : list.compact
          ? items.map((n) => n.id)
          : items.filter((n) => n.attachments?.length).map((n) => n.id);
      // A first page that came up short has seen every match, so it is its own total.
      // That saves the count where it costs most: a filter no stored number answers — a
      // field value, a date range, notes with no tag — counts by walking every note in
      // scope, and when few match, the page has just walked the same notes to find them.
      // Both callers pass the count the page's own filters; one that counted something
      // else beside a page would have to stop taking this path.
      const whole = !list.cursor && items.length < list.limit;
      return {
        items,
        total: count ? (whole ? items.length : this.notes.count(count)) : null,
        ...(opts.summaries ? { summaries: this.attachments.summariesForNotes(withFiles, opts.vision) } : {}),
      };
    });
  }

  /**
   * `GET /search?rows=1`: the matches, each with the row the note list would draw for it,
   * so a table can show a search in its own columns. One call where the search and a
   * lookup of its notes would be two.
   */
  searchRows(rawQuery: string, limit: number, filters: SearchFilters = {}, scopeDrivenSearchMax?: number) {
    this.ready();
    const results = this.notes.search(rawQuery, limit, filters, scopeDrivenSearchMax);
    const rows = new Map(this.notes.summariesFor(results.map((r) => r.id)).map((n) => [n.id, n]));
    return results.flatMap((r) => {
      const note = rows.get(r.id);
      return note ? [{ ...r, note }] : [];
    });
  }

  /**
   * MCP's `search_notes` with a line per file of each match (`summariesForNotes`), keyed
   * by note id, in one call. A search result does not say whether its note has files, so
   * every match is asked about: an index probe for a note with none.
   */
  searchWithFiles(
    rawQuery: string,
    limit: number,
    filters: SearchFilters = {},
    scopeDrivenSearchMax?: number,
    opts: { vision?: boolean } = {},
  ) {
    this.ready();
    const results = this.notes.search(rawQuery, limit, filters, scopeDrivenSearchMax);
    return { results, summaries: this.attachments.summariesForNotes(results.map((r) => r.id), opts.vision) };
  }

  /**
   * `GET /export/notes`: whole notes, the texts held for their files, the total on the
   * first page, and the cursor to continue from.
   *
   * The cursor is computed here rather than by the route because the page can be cut
   * short: bodies and texts are added up as they go, and once they pass
   * `EXPORT_PAGE_BYTES` the rest of the page is dropped and the cursor points at the
   * last note kept. A short page from `nextCursor`'s point of view means "the end", so
   * a cut page has to carry its own; see `cursorAfter`.
   */
  exportPage(list: ListOptions, count: CountOptions | null) {
    this.ready();
    return this.sql.tx(() => {
      let notes = this.notes.listFull(list);
      const total = count ? this.notes.count(count) : null;
      const sort = list.sort ?? DEFAULT_NOTE_SORT;
      const full = notes.length === list.limit;

      const withFiles = notes.filter((n) => n.attachments?.length).map((n) => n.id);
      let texts = this.attachments.textsForNotes(withFiles);
      const textBytes = new Map<string, number>();
      for (const t of texts) textBytes.set(t.noteId, (textBytes.get(t.noteId) ?? 0) + t.text.length);

      let bytes = 0;
      let cut = -1;
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i]!;
        bytes += n.body.length + (textBytes.get(n.id) ?? 0);
        // Always at least one note, or a single oversized note could never be exported.
        if (bytes > EXPORT_PAGE_BYTES && i > 0) {
          cut = i;
          break;
        }
      }
      if (cut > 0) {
        notes = notes.slice(0, cut);
        const kept = new Set(notes.map((n) => n.id));
        texts = texts.filter((t) => kept.has(t.noteId));
      }

      const last = notes[notes.length - 1];
      const cursor =
        cut > 0 && last
          ? cursorAfter(last, { sort, trashed: list.trashed, sortField: list.sortField })
          : full
            ? nextCursor(notes, { limit: list.limit, sort, trashed: list.trashed, sortField: list.sortField })
            : null;
      return { notes, total, texts, cursor };
    });
  }

  /**
   * `GET /notes/:id` with its files, as the MCP `get_note` tool wants them: each with its
   * size, and what it says in brief (`summariesForNotes`), so an assistant learns what a
   * file is without a `get_attachment_text` per file. The summaries' own query carries
   * everything `listForNote` would, so it is the only read of the note's files.
   */
  getWithFiles(id: string, opts: { vision?: boolean } = {}): { note: Note; files: FileSummary[] } | null {
    this.ready();
    return this.sql.tx(() => {
      const note = this.notes.get(id);
      if (!note) return null;
      return { note, files: this.attachments.summariesForNotes([id], opts.vision)[id] ?? [] };
    });
  }

  /**
   * `GET /notes/:id/files`: the note's files, or null when there is no such note. A
   * trashed note's are listed, for the trash's read-only view of it; see `NotesStore.get`.
   * One call where the route used to make two, asking whether the note was there first.
   */
  filesForNote(noteId: string): ReturnType<AttachmentsStore['listForNote']> | null {
    this.ready();
    return this.sql.tx(() => (this.attachments.noteExists(noteId) ? this.attachments.listForNote(noteId) : null));
  }

  /** `GET /notebooks` and MCP `list_notebooks`: the notebooks, the unfiled count, and every field if asked. */
  notebooksOverview(opts: { fields?: boolean | undefined } = {}) {
    this.ready();
    return this.sql.tx(() => ({
      notebooks: this.notes.listNotebooks(),
      unfiled: this.notes.countUnfiledNotes(),
      ...(opts.fields ? { fields: this.notes.listAllFields() } : {}),
    }));
  }

  /** `GET /attachments/pending-text`: the next files and, when asked, how many remain. */
  pendingText(limit: number, noteId: string | undefined, counted: boolean) {
    this.ready();
    return this.sql.tx(() => ({
      files: this.attachments.needingText(limit, noteId),
      ...(counted ? { remaining: this.attachments.pendingTextCount(noteId) } : {}),
    }));
  }

  /**
   * The first half of `POST /notes/:id/autofill`: the note, and the files of its own that
   * are still to be read, capped. Null when there is no such live note.
   */
  autofillPrelude(id: string, ownFilesToRead: number) {
    this.ready();
    return this.sql.tx(() => {
      const note = this.notes.get(id);
      if (!note) return null;
      return {
        note,
        forText: this.attachments.needingText(ownFilesToRead, id),
        forVision: this.attachments.needingVision(ownFilesToRead, id),
      };
    });
  }

  /** The second half: everything the model is shown beside the note. */
  autofillContext(id: string, perGroup: number, tagLimit: number) {
    this.ready();
    return this.sql.tx(() => ({
      files: this.attachments.textsForNote(id),
      notebooks: this.notes.listNotebooks(),
      fields: this.notes.listAllFields(),
      examples: this.notes.sampleTitles(id, perGroup, tagLimit),
    }));
  }

  /**
   * `PUT /notes/:id/files` with an id of the client's: whether the note is live, and the
   * file already holding that id, if any. One call where `ownsNote` and a lookup would be
   * two; a replayed upload is answered from this alone.
   */
  uploadPrelude(noteId: string, attachmentId: string) {
    this.ready();
    return { live: this.attachments.noteIsLive(noteId), existing: this.attachments.byId(attachmentId) };
  }

  // --- Push ------------------------------------------------------------------------------

  /**
   * `GET /changes/socket`: the Worker checks the session and forwards the upgrade here
   * with `stub.fetch`, the one way a socket reaches an object (a WebSocket cannot cross
   * RPC; measured 2026-10-02). Accepted through the hibernation API, so a device that is
   * connected and idle costs the object nothing: it is evicted between events, the
   * socket stays open at the edge, and `getWebSockets()` on the next wake still lists it.
   * Pings are answered at the edge too (`setWebSocketAutoResponse`, set once in the
   * constructor), without a wake.
   *
   * The only thing ever sent is `{"seq": N}` after a write, from `announce`. Nothing is
   * read: the handler below ignores every message, so a client cannot ask the object
   * for anything over the socket — the feed is a GET, session-checked in the Worker. A
   * leaked socket therefore leaks that something changed, and nothing else.
   *
   * This is the one `fetch(` in `src/store/`: a handler, not a call. guards.test.ts
   * allows exactly this declaration and no other.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Incoming messages are not a protocol; see `fetch`. */
  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed from the other side.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      // Already closed.
    }
  }

  // --- The change feed ------------------------------------------------------------------

  /**
   * `GET /changes`: everything that changed after `since`, whole, in one call.
   *
   * The rows after the cursor are read off the primary key — only what the page returns
   * — then collapsed to the last word per entity and loaded whole: notes with their
   * tags, values and files, notebooks with their definitions, tags, files. Cut short
   * when the bodies pass `FEED_PAGE_BYTES`, with `next` at the last row kept, so a page
   * never nears the RPC ceiling; a page of a hundred changed notes reads about 860 rows
   * (measured 2026-10-02, bounded in the rows-read test).
   *
   * `reset` rather than a partial answer for a cursor the feed cannot serve: one from
   * another epoch than the store's, which a point-in-time restore makes of every cursor
   * (checked here when the client sends its epoch, so the rarest path does not depend on
   * every client comparing); one past the counter, the same restore seen by a client
   * that sent no epoch; or one before the oldest row kept, which pruning makes of a
   * device away too long.
   *
   * The byte cut is decided before a body is read. Sizes are one small row per candidate
   * (`bodyBytes`), so a page of hundreds of large notes costs the object a few hundred
   * integers, never hundreds of bodies at once.
   */
  changesSince(since: number, limit: number, clientEpoch?: string): FeedPage | FeedReset {
    this.ready();
    return this.sql.tx(() => {
      const seq = this.feed.seq();
      const epoch = this.feed.epoch();
      if (clientEpoch !== undefined && clientEpoch !== epoch) return { reset: true, seq, epoch };
      if (since > seq) return { reset: true, seq, epoch };
      const oldest = this.sql.first<{ seq: number }>(`SELECT seq FROM changes ORDER BY seq LIMIT 1`);
      if (oldest && since < oldest.seq - 1) return { reset: true, seq, epoch };

      const rows = this.sql.exec<FeedRow>(
        `SELECT seq, entity, id, deleted FROM changes WHERE seq > ?1 ORDER BY seq LIMIT ?2`,
        since,
        limit,
      );
      const full = rows.length === limit;

      // The cut decides which rows stay, and it is made on the bodies' sizes alone —
      // one small row per candidate — before any body is loaded. Loading every
      // candidate whole and cutting afterwards would have held up to five hundred
      // bodies of up to 1.8 MB each in the object at once, past its memory, on a page
      // that one large import is enough to produce; and a page that fails never
      // advances the cursor, so the account's feed would stay stuck on it.
      const wanted = lastWordPerEntity(rows);
      const sizes = this.notes.bodyBytes(wanted.filter((c) => c.entity === 'note' && !c.deleted).map((c) => c.id));
      const cut = cutByBytes(rows, (id) => sizes.get(id) ?? 0);
      const kept = rows.slice(0, cut);
      const changes = lastWordPerEntity(kept);

      const ids = (entity: FeedRow['entity'], deleted: boolean) =>
        changes.filter((c) => c.entity === entity && !!c.deleted === deleted).map((c) => c.id);
      const keptNoteIds = ids('note', false);
      const notes = new Map(this.notes.wholeNotes(keptNoteIds).map((n) => [n.id, n]));
      const files = this.attachments.filesForNotes(keptNoteIds);
      const feedNotes: FeedNote[] = keptNoteIds.flatMap((id) => {
        const note = notes.get(id);
        // Named by a row but not a note any more: purged by a later write than this page
        // reaches, whose tombstone the next page carries.
        return note ? [{ ...note, files: files.get(id) ?? [] }] : [];
      });

      return {
        reset: false,
        seq,
        epoch,
        next: kept.length > 0 ? kept[kept.length - 1]!.seq : since,
        more: cut < rows.length || full,
        notes: feedNotes,
        notebooks: this.notes.notebooksWhole(ids('notebook', false)),
        tags: this.notes.tagsWhole(ids('tag', false)),
        attachments: this.attachments.attachmentsWhole(ids('attachment', false)),
        tombstones: changes.filter((c) => c.deleted).map((c) => ({ entity: c.entity, id: c.id })),
      };
    });
  }

  /**
   * `GET /changes/snapshot`: a page of the whole library by note id, for a client with
   * no copy yet; see `SnapshotPage` for the contract. The first page carries the
   * notebooks, the tags and the total as well, and the `seq` every page reports is the
   * counter at the time, which the client stores before applying the first page.
   */
  snapshotPage(cursor: string | null, limit: number): SnapshotPage {
    this.ready();
    return this.sql.tx(() => {
      const seq = this.feed.seq();
      const epoch = this.feed.epoch();
      const ids = this.notes.idsAfter(cursor, limit);
      // Sizes first, bodies after the cut, as `changesSince` does and for the same reason.
      const sizes = this.notes.bodyBytes(ids);
      const rows: FeedRow[] = ids.map((id, i) => ({ seq: i, entity: 'note', id, deleted: 0 }));
      const cut = cutByBytes(rows, (id) => sizes.get(id) ?? 0, FEED_PAGE_BYTES);
      const kept = ids.slice(0, cut);
      const notes = new Map(this.notes.wholeNotes(kept).map((n) => [n.id, n]));
      const files = this.attachments.filesForNotes(kept);
      const page: SnapshotPage = {
        seq,
        epoch,
        notes: kept.flatMap((id) => {
          const note = notes.get(id);
          return note ? [{ ...note, files: files.get(id) ?? [] }] : [];
        }),
        next: cut < ids.length || ids.length === limit ? (kept[kept.length - 1] ?? null) : null,
      };
      if (cursor === null) {
        page.notebooks = this.notes.notebooksWhole(null);
        page.tags = this.notes.tagsWhole(null);
        page.total = this.notes.totalNotes();
      }
      return page;
    });
  }

  /**
   * Names a new history, after a point-in-time restore. The restore winds `_meta.seq`
   * back with everything else, and a client whose cursor sits in the rewound range would
   * read what is written again on top of it as if it had seen it. The restore route
   * calls this once the store is back; every client then sees an epoch it does not hold
   * and starts over. The one write on the object the feed does not record, since it is
   * the feed starting again — so the sockets are told by hand: most dropped on the
   * restore's restart, but one that reconnected first, and every one after the
   * hand-run `POST /admin/store/feed-epoch`, would otherwise keep the old history until
   * its next focus.
   */
  feedRestored(): { epoch: string } {
    this.ready();
    const epoch = this.newEpoch();
    this.tell(this.feed.seq());
    return { epoch };
  }

  /** Names a new history for the feed; see `feedRestored`. */
  private newEpoch(): string {
    const epoch = crypto.randomUUID().replace(/-/g, '');
    this.sql.exec(`INSERT INTO _meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, META.epoch, epoch);
    return epoch;
  }
}

/** A page of the dump's statements as the bytes the file holds: one a line, each line ended. */
function encodeLines(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.length ? `${lines.join('\n')}\n` : '');
}

/** One SQLite value as a literal in the dump. The four types the engine has, and nothing else. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return `X'${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Re-exported so the facade and the tests can name the option shapes without reaching
// into the store modules.
export type { CountOptions, ListOptions, SearchFilters };
export type { FieldDef, FieldValue, NoteFieldsPatch };
