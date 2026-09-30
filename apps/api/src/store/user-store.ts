import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_NOTE_SORT,
  type FieldDef,
  type FieldScale,
  type FieldType,
  type FieldValue,
  type Note,
  type NoteFieldsPatch,
  type NotebookDefinition,
} from '@unbent/shared';
import { AttachmentsStore } from './attachments.js';
import { copiedFromD1, copyFromD1, copyMismatch, markCopiedFromD1, type CopyOptions, type CopyResult } from './copy-from-d1.js';
import { appliedMigrations, migrate } from './migrate.js';
import { NotesStore, type CountOptions, type ListOptions, type SearchFilters } from './notes.js';
import { cursorAfter, nextCursor } from './notes-shared.js';
import { SCHEMA } from './schema/index.js';
import { instrumentedSql, type Sql } from './sql.js';
import { DATA_TABLES, DUMP_TABLES, type DataTable, type DumpTable } from './tables.js';

export { DATA_TABLES, DUMP_TABLES, type DataTable, type DumpTable };

/**
 * What the object is allowed to see of the Worker's environment: the D1 database, for the
 * one-time copy of an account's rows (`copy-from-d1.ts`), and nothing else.
 *
 * `DB` leaves when the copy does, and then this is `Record<never, never>`. Naming `BLOBS`,
 * `AI` or a secret here would be refused by review before it was refused by the compiler,
 * but the compiler refusing it is what makes rule 1 in AGENTS.md — the object touches its
 * SQLite and nothing else — a property of the code rather than a habit.
 */
export type StoreEnv = {
  DB: D1Database;
  /**
   * `"0"` on the pull-request previews, which share the dev instance's D1 while dev still
   * runs `main`: a preview's copy must not write `migrated_at` there, or the freeze would
   * refuse that account's writes on dev until the merge. See wrangler.toml.
   */
  STORE_FREEZE_D1?: string;
};

/** The `_meta` keys the object writes. Reserved names, kept in one place. */
const META = {
  /** The user this object belongs to: `ctx.id.name`, written on first wake, refused on a mismatch after. */
  userId: 'user_id',
} as const;

/**
 * The one key in the object's key-value storage, which `deleteAll` clears and `wipe` then
 * writes: that this object was wiped. It is what stops a wiped object copying its account
 * back from D1 on its next wake — `deleteAll` takes the `_meta` row that says the copy has
 * run, and without this a deletion that failed after the wipe would bring the account back
 * as it was at the cutover, with its files already gone from R2 (found in review). Read
 * before the schema is touched, so a wiped object stays empty storage until something
 * asks for its notes.
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
  /** Whether the one-time copy from D1 has run (or was found unnecessary). What the sweep writes to the directory. */
  migratedFromD1: boolean;
  /** Why the copy's last verification failed, while it waits for the operator; see `copyFromD1`. */
  copyMismatch: string | null;
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
  migratedFromD1: boolean;
  wiped: boolean;
}

/** What `copyFromD1` answers: the copy's own result, with the usage the sweep records. */
export type StoreCopyResult = CopyResult & { usage: StoreUsage };

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
 * it was created under. Every wake is local reads only: nothing here reaches D1 until
 * something calls `copyFromD1`.
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
    this.notes = new NotesStore(this.sql);
    this.attachments = new AttachmentsStore(this.sql);
    ctx.blockConcurrencyWhile(async () => {
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
   * purged — so the copy from D1 is marked done rather than run.
   */
  private ready(): void {
    if (!this.wiped) return;
    this.bootstrap();
    markCopiedFromD1(this.sql);
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
      return { userId: this.userId, databaseSize: this.ctx.storage.sql.databaseSize, migrations: [], counts, wiped: true, migratedFromD1: true, copyMismatch: null };
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
      migratedFromD1: copiedFromD1(this.sql),
      copyMismatch: copyMismatch(this.sql),
    };
  }

  /** What the sweep records: a few rows per account, never a table scan. See `StoreUsage`. */
  usage(): StoreUsage {
    const databaseSize = this.ctx.storage.sql.databaseSize;
    if (this.wiped) return { databaseSize, notes: 0, migratedFromD1: true, wiped: true };
    const counts = this.sql.first<{ live: number; trashed: number }>(`SELECT live, trashed FROM note_counts WHERE id = 1`);
    return {
      databaseSize,
      notes: (counts?.live ?? 0) + (counts?.trashed ?? 0),
      migratedFromD1: copiedFromD1(this.sql),
      wiped: false,
    };
  }

  /**
   * Runs, or continues, the one-time copy of this account's rows from D1; see
   * copy-from-d1.ts for what it promises and what it answers. The sweep calls it for
   * every account not yet copied, and the operator's route for one; nothing else does,
   * and in particular no wake. The answer carries the usage the sweep would otherwise
   * have to ask for in a second call, whatever the copy did.
   *
   * Under `blockConcurrencyWhile`, so two callers cannot interleave — the sweep and the
   * operator at once would each count the pages the other inserted as its own — and so
   * nothing reads the account between two of its pages. The callback swallows its error
   * and rethrows it outside the block: a throw *inside* one resets the object, and a
   * reset discards writes the runtime has not yet confirmed (measured 2026-09-30), which
   * could take the committed cursor with it.
   */
  async copyFromD1(opts: Pick<CopyOptions, 'retry' | 'budget'> = {}): Promise<StoreCopyResult> {
    // A wiped object answers without rebuilding its schema, as `stats` and `usage` do:
    // the operator's route accepts any account the directory names, tombstoned ones
    // included, and a deleted account must not get an empty database back from a typo.
    if (this.wiped) return { status: 'already', usage: this.usage() };
    this.ready();
    let outcome: CopyResult | Error | undefined;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        outcome = await copyFromD1(this.sql, this.env.DB, this.userId, () => this.notes.recountNotes(), {
          freeze: this.env.STORE_FREEZE_D1 !== '0',
          retry: opts.retry,
          budget: opts.budget,
        });
      } catch (err) {
        outcome = err instanceof Error ? err : new Error(String(err));
      }
    });
    if (outcome instanceof Error) throw outcome;
    return { ...outcome!, usage: this.usage() };
  }

  /**
   * Deletes everything: every table, the schema, the `_meta` row. For account deletion and
   * for the test fixtures' purge.
   *
   * The instance stays alive and empty, and stays that way across an eviction: the
   * marker written here is read before the schema is touched on the next wake. `ready()`
   * rebuilds the schema if a data method is called afterwards, so a wiped object that is
   * reached again — a deletion that failed further along and was retried, a test —
   * behaves as a brand-new one that starts empty rather than copying its old rows back
   * from D1 or throwing "no such table".
   */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    // After `deleteAll`, so it is the one thing left; see `WIPED_KEY`.
    this.ctx.storage.kv.put(WIPED_KEY, true);
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

  // --- Notes: the repository, one for one -----------------------------------------------
  //
  // Each of these is `NotesStore`'s method of the same name, behind `ready()`. They are
  // spelled out rather than proxied so the RPC surface is a list a reader can grep, the
  // types cross the boundary as written, and a method the object should not expose cannot
  // leak through a wildcard.

  list(opts: ListOptions) { this.ready(); return this.notes.list(opts); }
  listFull(opts: ListOptions) { this.ready(); return this.notes.listFull(opts); }
  count(opts: CountOptions = {}) { this.ready(); return this.notes.count(opts); }
  recountNotes() { this.ready(); return this.notes.recountNotes(); }
  get(id: string) { this.ready(); return this.notes.get(id); }
  create(input: Parameters<NotesStore['create']>[0]) { this.ready(); return this.notes.create(input); }
  duplicate(id: string, newId: string) { this.ready(); return this.notes.duplicate(id, newId); }
  update(id: string, patch: Parameters<NotesStore['update']>[1]) { this.ready(); return this.notes.update(id, patch); }
  appendToBody(id: string, markdown: string) { this.ready(); return this.notes.appendToBody(id, markdown); }
  remove(id: string) { this.ready(); return this.notes.remove(id); }
  restore(id: string) { this.ready(); return this.notes.restore(id); }
  purgeOne(id: string) { this.ready(); return this.notes.purgeOne(id); }
  removeMany(ids: string[]) { this.ready(); return this.notes.removeMany(ids); }
  restoreMany(ids: string[]) { this.ready(); return this.notes.restoreMany(ids); }
  purgeMany(ids: string[]) { this.ready(); return this.notes.purgeMany(ids); }
  updateMany(ids: string[], patch: Parameters<NotesStore['updateMany']>[1]) { this.ready(); return this.notes.updateMany(ids, patch); }
  importNote(input: Parameters<NotesStore['importNote']>[0]) { this.ready(); return this.notes.importNote(input); }
  setBody(id: string, body: string) { this.ready(); return this.notes.setBody(id, body); }
  search(rawQuery: string, limit: number, filters: SearchFilters = {}, scopeDrivenSearchMax?: number) {
    this.ready();
    return this.notes.search(rawQuery, limit, filters, scopeDrivenSearchMax);
  }
  purge(scope: 'trashed' | 'all', limit?: number) { this.ready(); return this.notes.purge(scope, limit); }
  listTags() { this.ready(); return this.notes.listTags(); }
  sampleTitles(exclude: string, perGroup: number, tagLimit: number) { this.ready(); return this.notes.sampleTitles(exclude, perGroup, tagLimit); }
  renameTag(id: string, name: string, opts?: { merge?: boolean | undefined }) { this.ready(); return this.notes.renameTag(id, name, opts); }
  deleteTag(id: string) { this.ready(); return this.notes.deleteTag(id); }
  countUnfiledNotes() { this.ready(); return this.notes.countUnfiledNotes(); }
  listNotebooks() { this.ready(); return this.notes.listNotebooks(); }
  createNotebook(name: string) { this.ready(); return this.notes.createNotebook(name); }
  updateNotebook(id: string, patch: Parameters<NotesStore['updateNotebook']>[1]) { this.ready(); return this.notes.updateNotebook(id, patch); }
  deleteNotebook(id: string, opts?: { trashNotes?: boolean | undefined }) { this.ready(); return this.notes.deleteNotebook(id, opts); }
  listFields(notebookId: string, opts?: { counts?: boolean | undefined }) { this.ready(); return this.notes.listFields(notebookId, opts); }
  fieldById(id: string) { this.ready(); return this.notes.fieldById(id); }
  listAllFields() { this.ready(); return this.notes.listAllFields(); }
  createField(notebookId: string, input: { name: string; type: FieldType; options: string[]; scale?: FieldScale | null | undefined; currency?: string | null | undefined }) {
    this.ready();
    return this.notes.createField(notebookId, input);
  }
  updateField(notebookId: string, fieldId: string, patch: Parameters<NotesStore['updateField']>[2]) {
    this.ready();
    return this.notes.updateField(notebookId, fieldId, patch);
  }
  previewConversion(notebookId: string, fieldId: string, to: FieldType, toScale?: FieldScale | null | undefined) {
    this.ready();
    return this.notes.previewConversion(notebookId, fieldId, to, toScale);
  }
  reorderFields(notebookId: string, ids: string[]) { this.ready(); return this.notes.reorderFields(notebookId, ids); }
  deleteField(notebookId: string, fieldId: string) { this.ready(); return this.notes.deleteField(notebookId, fieldId); }
  countOptionUsage(notebookId: string, fieldId: string, option: string) { this.ready(); return this.notes.countOptionUsage(notebookId, fieldId, option); }
  removeFieldOption(notebookId: string, fieldId: string, option: string, clear: boolean) {
    this.ready();
    return this.notes.removeFieldOption(notebookId, fieldId, option, clear);
  }
  importNotebook(definition: NotebookDefinition) { this.ready(); return this.notes.importNotebook(definition); }

  // --- Attachments: the repository, one for one -----------------------------------------
  //
  // Prefixed where a name would collide with a note method's (`remove`) or read as one
  // out of context (`record`). `ownsNote` keeps its name for the facade's sake although
  // ownership is not what it checks any more; see `AttachmentsStore.noteIsLive`.

  resolveAttachment(noteId: string, filename: string) { this.ready(); return this.attachments.resolve(noteId, filename); }
  listAttachments(noteId: string) { this.ready(); return this.attachments.listForNote(noteId); }
  ownsNote(noteId: string) { this.ready(); return this.attachments.noteIsLive(noteId); }
  availableFilename(noteId: string, desired: string) { this.ready(); return this.attachments.availableFilename(noteId, desired); }
  recordAttachment(input: Parameters<AttachmentsStore['record']>[0]) { this.ready(); return this.attachments.record(input); }
  removeAttachment(noteId: string, filename: string) { this.ready(); return this.attachments.remove(noteId, filename); }
  recordText(input: Parameters<AttachmentsStore['recordText']>[0]) { this.ready(); return this.attachments.recordText(input); }
  copyText(fromAttachmentId: string, to: { attachmentId: string; noteId: string; filename: string }) {
    this.ready();
    return this.attachments.copyText(fromAttachmentId, to);
  }
  needingText(limit: number, noteId?: string) { this.ready(); return this.attachments.needingText(limit, noteId); }
  needingVision(limit: number, noteId?: string) { this.ready(); return this.attachments.needingVision(limit, noteId); }
  visionPending(noteId?: string) { this.ready(); return this.attachments.visionPending(noteId); }
  pendingTextCount(noteId?: string) { this.ready(); return this.attachments.pendingTextCount(noteId); }
  textFor(noteId: string, filename: string) { this.ready(); return this.attachments.textFor(noteId, filename); }
  textsForNote(noteId: string) { this.ready(); return this.attachments.textsForNote(noteId); }
  textsForNotes(noteIds: string[]) { this.ready(); return this.attachments.textsForNotes(noteIds); }
  attachmentIdFor(noteId: string, filename: string) { this.ready(); return this.attachments.idFor(noteId, filename); }
  keysForNote(noteId: string) { this.ready(); return this.attachments.keysForNote(noteId); }
  allBlobKeys(afterRowid?: number, limit?: number) { this.ready(); return this.attachments.blobKeys(afterRowid, limit); }

  // --- Composites: what a route asks, in one request ------------------------------------

  /** `GET /notes`: the page and, on the first page, the total. */
  listPage(list: ListOptions, count: CountOptions | null) {
    this.ready();
    return this.sql.tx(() => ({
      items: this.notes.list(list),
      total: count ? this.notes.count(count) : null,
    }));
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

  /** `GET /notes/:id` with its files, as the MCP `get_note` tool wants them. */
  getWithFiles(id: string): { note: Note; files: ReturnType<AttachmentsStore['listForNote']> } | null {
    this.ready();
    return this.sql.tx(() => {
      const note = this.notes.get(id);
      if (!note) return null;
      return { note, files: this.attachments.listForNote(id) };
    });
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
export type { CopyResult };
