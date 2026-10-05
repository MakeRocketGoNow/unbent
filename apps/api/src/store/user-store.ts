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
import { cutByBytes, Feed, FEED_META, FEED_PAGE_BYTES, lastWordPerEntity, type FeedRow } from './feed.js';
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

/** One row as SQLite hands it back: the four value types it has, by column name. */
export type Row = Record<string, SqlStorageValue>;


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
 * The same budget for a dump page: `attachment_text` rows are up to half a million
 * characters each, and five hundred of them would pass the RPC ceiling many times over.
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
    this.feed = new Feed(this.sql);
    this.notes = new NotesStore(this.sql, this.feed);
    this.attachments = new AttachmentsStore(this.sql, this.feed);
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

  /**
   * Rebuilds the schema after a `wipe`, the first time anything asks for data again. A
   * wiped object starts empty by design — the account was deleted, or a test fixture
   * purged.
   */
  private ready(): void {
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

  /** What the sweep records: a few rows per account, never a table scan. See `StoreUsage`. */
  usage(): StoreUsage {
    const databaseSize = this.ctx.storage.sql.databaseSize;
    if (this.wiped) return { databaseSize, notes: 0, wiped: true };
    const counts = this.sql.first<{ live: number; trashed: number }>(`SELECT live, trashed FROM note_counts WHERE id = 1`);
    return {
      databaseSize,
      notes: (counts?.live ?? 0) + (counts?.trashed ?? 0),
      wiped: false,
    };
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
   * account's own blob sweep reclaims, and files deleted since come back as rows pointing
   * at nothing.
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
   * One page of a table's rows, by rowid, as INSERT statements for the dump route: the
   * operator pages every table in `DUMP_TABLES` order and writes the pages out between
   * the schema's tables and its triggers, which is a file `sqlite3` rebuilds an account
   * from. The FTS tables are not dumped; the file rebuilds them from the rows at the end.
   *
   * The rows are turned into SQL here rather than in the Worker because of where the CPU
   * is. A Worker invocation on the Free plan has ten milliseconds of it, and quoting
   * eight megabytes of text takes more than that; an object request has thirty seconds.
   * Encoded to bytes here too, for the same reason: a string crossing RPC is decoded on
   * the Worker's side and would be encoded again for the response, both linear in the
   * page, where a byte array crosses as a copy and is written out as it is.
   *
   * A page is at most `limit` rows and, past the first row, at most `DUMP_PAGE_BYTES` of
   * them: the result crosses RPC, which is capped at 32 MiB, and a page of scans' texts
   * would pass that at five hundred rows. The cut is by the rows' own sizes as they are
   * read — off the raw cursor, row by row, so the cut bounds the object's memory and not
   * only the result, and the caller may ask for thousands of rows a page and get as many
   * as fit. That matters because every page is one store call, and an invocation has
   * fifty on Free: a dump of an archive-sized account has to be a dozen pages, not a
   * hundred. The one query here that bypasses the `Sql` seam's metering, for that reason.
   */
  dumpPage(table: DumpTable, afterRowid = 0, limit = 5000): { bytes: Uint8Array; rows: number; nextRowid: number | null } {
    this.ready();
    if (!DUMP_TABLES.includes(table)) throw new Error(`not a data table: ${table}`);
    const cursor = this.ctx.storage.sql.exec<Row & { _rowid: number }>(
      `SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`,
      afterRowid,
      limit,
    );
    const lines: string[] = [];
    let bytes = 0;
    let cut = false;
    let last: number | null = null;
    for (const row of cursor) {
      for (const v of Object.values(row)) bytes += typeof v === 'string' ? v.length : v instanceof ArrayBuffer ? v.byteLength : 8;
      // Always at least one row, or a single oversized row could never be dumped.
      if (bytes > DUMP_PAGE_BYTES && lines.length > 0) {
        cut = true;
        break;
      }
      const { _rowid, ...columns } = row;
      last = _rowid;
      const names = Object.keys(columns);
      lines.push(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((n) => sqlLiteral(columns[n])).join(', ')});`);
    }
    // More may follow when the page was cut, or was full; a short page that was not cut
    // is the end of the table.
    return {
      bytes: new TextEncoder().encode(lines.length ? `${lines.join('\n')}\n` : ''),
      rows: lines.length,
      nextRowid: (cut || lines.length === limit) && last !== null ? last : null,
    };
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
  needingText(limit: number, noteId?: string) { this.ready(); return this.attachments.needingText(limit, noteId); }
  needingVision(limit: number, noteId?: string) { this.ready(); return this.attachments.needingVision(limit, noteId); }
  visionPending(noteId?: string) { this.ready(); return this.attachments.visionPending(noteId); }
  pendingTextCount(noteId?: string) { this.ready(); return this.attachments.pendingTextCount(noteId); }
  textFor(noteId: string, filename: string) { this.ready(); return this.attachments.textFor(noteId, filename); }
  textsForNote(noteId: string) { this.ready(); return this.attachments.textsForNote(noteId); }
  textsForNotes(noteIds: string[]) { this.ready(); return this.attachments.textsForNotes(noteIds); }
  textsById(ids: string[]) { this.ready(); return this.attachments.textsById(ids); }
  attachmentIdFor(noteId: string, filename: string) { this.ready(); return this.attachments.idFor(noteId, filename); }
  keysForNote(noteId: string) { this.ready(); return this.attachments.keysForNote(noteId); }
  allBlobKeys(afterRowid?: number, limit?: number) { this.ready(); return this.attachments.blobKeys(afterRowid, limit); }

  // --- Composites: what a route asks, in one request ------------------------------------

  /**
   * `GET /notes` and MCP's `list_notes`: the page and, on the first page, the total. With
   * `summaries`, also a line per file of each note on the page (`summariesForNotes`), keyed
   * by note id, in the same call — `list_notes` asks for it when an assistant is filling
   * fields from the files.
   */
  listPage(list: ListOptions, count: CountOptions | null, opts: { summaries?: boolean } = {}) {
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
        ...(opts.summaries ? { summaries: this.attachments.summariesForNotes(withFiles) } : {}),
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
  getWithFiles(id: string): { note: Note; files: FileSummary[] } | null {
    this.ready();
    return this.sql.tx(() => {
      const note = this.notes.get(id);
      if (!note) return null;
      return { note, files: this.attachments.summariesForNotes([id])[id] ?? [] };
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

  /**
   * What MCP's `read_attachment` asks before it reads: whether the note is live, the text
   * the file already has, and the note's files still waiting for either reader.
   */
  attachmentReadPrelude(noteId: string, filename: string, filesPerNote: number) {
    this.ready();
    return this.sql.tx(() => {
      if (!this.attachments.noteIsLive(noteId)) return null;
      return {
        text: this.attachments.textFor(noteId, filename),
        forText: this.attachments.needingText(filesPerNote, noteId),
        forVision: this.attachments.needingVision(filesPerNote, noteId),
      };
    });
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
    const epoch = crypto.randomUUID().replace(/-/g, '');
    this.sql.exec(`INSERT INTO _meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, META.epoch, epoch);
    this.tell(this.feed.seq());
    return { epoch };
  }
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
