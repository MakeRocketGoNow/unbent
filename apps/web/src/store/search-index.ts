import { FTS_TOKENIZE, NOTE_FTS_WEIGHTS } from '@unbent/shared';

/**
 * The index a device searches when it has no connection: four FTS5 tables in a SQLite
 * file of their own, beside the account's library in the origin-private file system.
 *
 * The same engine as the server's. The WASM build the library's persistence loads
 * (`wa-sqlite.wasm`) carries FTS5, bm25 and the porter stemmer, so the tables here are
 * declared as the account's store declares its own (`apps/api/src/store/schema`) — one
 * for a note's title and body, one for tag names, one for field values, one for the text
 * read out of files — and a search asks each the question the server asks. What the
 * server answers with joins, the caller answers from the library's rows (`search-local.ts`):
 * this file knows ids and text and nothing about notebooks or filters.
 *
 * A file of its own rather than tables in the library's, for two reasons. The library's
 * connection is the persistence layer's: it runs its transactions as a run of separate
 * statements on a queue this code cannot join, so a write of ours could land inside one
 * of its transactions and be rolled back with it. And a search of an archive is tens of
 * milliseconds of engine time; on the library's connection that is a save waiting behind
 * every keystroke in the search box. The price is a second engine instance, and that
 * the index can fall behind the rows — which it could anyway, and which `SearchSync`
 * exists to close.
 *
 * Everything here is derived: the notes come from the library and the files' text from
 * the server. So there are no migrations — a version that does not match is dropped and
 * built again.
 */

/** A database the index can run on: the browser's worker-backed handle, or a test's in-memory one. */
export interface SearchDb {
  execute<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<T>>;
  close?: () => Promise<void> | void;
}

/** What is indexed, and in the order a search ranks a match: what was written, then filed under, then filled in, then read by a scanner. */
export type Kind = 'note' | 'tag' | 'field' | 'file';
export const KINDS: readonly Kind[] = ['note', 'tag', 'field', 'file'];

interface Table {
  name: string;
  columns: string[];
  /** Which column a snippet is cut from. */
  snippet: number;
  /** The bm25 weighting, where the table has more than one column. */
  weights: string | null;
}

/** The server's `SEARCH_TIERS`, as tables here. A note's snippet comes from its body, as there. */
const TABLES: Record<Kind, Table> = {
  note: { name: 'notes_fts', columns: ['title', 'body'], snippet: 1, weights: NOTE_FTS_WEIGHTS },
  tag: { name: 'tags_fts', columns: ['name'], snippet: 0, weights: null },
  field: { name: 'fields_fts', columns: ['value_text'], snippet: 0, weights: null },
  file: { name: 'files_fts', columns: ['text'], snippet: 0, weights: null },
};

/** Bump when a table's shape or what goes into it changes; the index is then built again from nothing. */
export const SEARCH_INDEX_VERSION = 1;

/** One thing to index: its id among its kind, a stamp that changes when its text does, and the text, a string per column. */
export interface Entry {
  id: string;
  stamp: string;
  columns: string[];
}

export interface Candidate {
  id: string;
  rank: number;
}

/** How many notes' files are kept searchable because the note was opened here; see `opened`. */
export const RECENT_NOTES = 200;

/** Rows a write carries at most, so one statement's JSON stays a few megabytes. */
const WRITE_ROWS = 200;
const WRITE_BYTES = 2 * 1024 * 1024;

export class SearchIndex {
  private queue: Promise<unknown> = Promise.resolve();
  private prepared: Promise<void> | null = null;

  constructor(private readonly db: SearchDb) {}

  /** Creates the tables, or drops and recreates them when they are another version's. */
  ready(): Promise<void> {
    this.prepared ??= this.write(async () => {
      await this.db.execute(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      const [row] = await this.db.execute<{ value: string }>(`SELECT value FROM meta WHERE key = 'version'`);
      if (row?.value === String(SEARCH_INDEX_VERSION)) return;
      for (const t of Object.values(TABLES)) await this.db.execute(`DROP TABLE IF EXISTS ${t.name}`);
      await this.db.execute(`DROP TABLE IF EXISTS entries`);
      await this.db.execute(`DROP TABLE IF EXISTS opened`);
      await this.db.execute(`DELETE FROM meta`);
      /*
       * One row per thing indexed, of any kind. Its rowid is the FTS row's, which is what
       * lets an entry be replaced or removed by key: an FTS5 table finds a row by rowid or
       * by scanning, and ids here are strings. The stamp is how a pass tells what is
       * already indexed as it stands without reading any text back.
       */
      await this.db.execute(
        `CREATE TABLE entries (
           rowid INTEGER PRIMARY KEY,
           kind  TEXT NOT NULL,
           id    TEXT NOT NULL,
           stamp TEXT NOT NULL,
           UNIQUE (kind, id)
         )`,
      );
      for (const t of Object.values(TABLES)) {
        await this.db.execute(`CREATE VIRTUAL TABLE ${t.name} USING fts5(${t.columns.join(', ')}, tokenize='${FTS_TOKENIZE}')`);
      }
      /* The notes opened on this device, newest last to leave; their files' text is kept. */
      await this.db.execute(`CREATE TABLE opened (note_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
      await this.db.execute(`INSERT INTO meta (key, value) VALUES ('version', ?1)`, [String(SEARCH_INDEX_VERSION)]);
    });
    return this.prepared;
  }

  /**
   * One transaction, after any already asked for. The handle runs statements in the
   * order they are sent, so two writers interleaving would be one transaction with two
   * owners; everything that writes goes through here.
   */
  private write<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.db.execute('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        await this.db.execute('COMMIT');
        return result;
      } catch (err) {
        await this.db.execute('ROLLBACK').catch(() => {});
        throw err;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async meta(key: string): Promise<string | null> {
    await this.ready();
    const [row] = await this.db.execute<{ value: string }>(`SELECT value FROM meta WHERE key = ?1`, [key]);
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    await this.ready();
    await this.write(async () => {
      if (value === null) await this.db.execute(`DELETE FROM meta WHERE key = ?1`, [key]);
      else await this.db.execute(`INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, value]);
    });
  }

  /** Every entry of a kind with its stamp — or, given ids, those among them that are indexed. */
  async stamps(kind: Kind, ids?: string[]): Promise<Map<string, string>> {
    await this.ready();
    const rows = ids
      ? await this.db.execute<{ id: string; stamp: string }>(
          `SELECT id, stamp FROM entries WHERE kind = ?1 AND id IN (SELECT value FROM json_each(?2))`,
          [kind, JSON.stringify(ids)],
        )
      : await this.db.execute<{ id: string; stamp: string }>(`SELECT id, stamp FROM entries WHERE kind = ?1`, [kind]);
    return new Map(rows.map((r) => [r.id, r.stamp]));
  }

  /** Entries of a kind whose id starts with one of the prefixes: a note's field values, which are keyed note then field. */
  async stampsUnder(kind: Kind, prefixes: string[]): Promise<Map<string, string>> {
    await this.ready();
    const rows = await this.db.execute<{ id: string; stamp: string }>(
      `SELECT e.id AS id, e.stamp AS stamp
         FROM json_each(?2) p
         JOIN entries e ON e.kind = ?1 AND e.id >= p.value AND e.id < p.value || char(1114111)`,
      [kind, JSON.stringify(prefixes)],
    );
    return new Map(rows.map((r) => [r.id, r.stamp]));
  }

  /** How many of the given ids are indexed, for saying what a search covered. */
  async held(kind: Kind, ids: string[]): Promise<number> {
    await this.ready();
    const [row] = await this.db.execute<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entries WHERE kind = ?1 AND id IN (SELECT value FROM json_each(?2))`,
      [kind, JSON.stringify(ids)],
    );
    return row?.n ?? 0;
  }

  /**
   * Indexes entries, replacing any already held under the same id.
   *
   * Four statements a batch, whatever its size: every statement is a message to the
   * engine's worker and back, and an archive's first index is thirteen thousand notes,
   * so the rows travel as one JSON array and SQLite takes it apart (`json_each`).
   */
  async put(kind: Kind, entries: Entry[]): Promise<void> {
    await this.ready();
    const t = TABLES[kind];
    for (const batch of batches(entries)) {
      const ids = JSON.stringify(batch.map((e) => e.id));
      const rows = JSON.stringify(batch.map((e) => ({ id: e.id, stamp: e.stamp, c: e.columns })));
      await this.write(async () => {
        await this.remove(kind, ids);
        await this.db.execute(`INSERT INTO entries (kind, id, stamp) SELECT ?1, value ->> 'id', value ->> 'stamp' FROM json_each(?2)`, [kind, rows]);
        await this.db.execute(
          `INSERT INTO ${t.name} (rowid, ${t.columns.join(', ')})
           SELECT e.rowid, ${t.columns.map((_, i) => `j.value ->> '$.c[${i}]'`).join(', ')}
             FROM json_each(?2) j
             JOIN entries e ON e.kind = ?1 AND e.id = j.value ->> 'id'`,
          [kind, rows],
        );
      });
    }
  }

  async drop(kind: Kind, ids: string[]): Promise<void> {
    await this.ready();
    for (let i = 0; i < ids.length; i += 1000) {
      const run = JSON.stringify(ids.slice(i, i + 1000));
      await this.write(() => this.remove(kind, run));
    }
  }

  /** Inside a transaction: the FTS rows first, found through the entries that are about to go. */
  private async remove(kind: Kind, idsJson: string): Promise<void> {
    const t = TABLES[kind];
    await this.db.execute(
      `DELETE FROM ${t.name} WHERE rowid IN (SELECT rowid FROM entries WHERE kind = ?1 AND id IN (SELECT value FROM json_each(?2)))`,
      [kind, idsJson],
    );
    await this.db.execute(`DELETE FROM entries WHERE kind = ?1 AND id IN (SELECT value FROM json_each(?2))`, [kind, idsJson]);
  }

  /** Empties the index, keeping the list of notes opened here: what a library that starts over does. */
  async clear(): Promise<void> {
    await this.ready();
    await this.write(async () => {
      for (const t of Object.values(TABLES)) await this.db.execute(`DELETE FROM ${t.name}`);
      await this.db.execute(`DELETE FROM entries`);
      await this.db.execute(`DELETE FROM meta WHERE key <> 'version'`);
    });
  }

  /**
   * The entries of a kind matching an FTS query, best first, at most `limit` (all of
   * them when negative). Ids and ranks only: a snippet is cut from the stored text, which
   * for a file is a scan's worth, and a filtered search asks for every match before it
   * knows which fifty it will show (`snippets`).
   *
   * `rank MATCH 'bm25(…)'` is how the server weights a title over a body while still
   * reading the table in rank order; the same clause here gives the same numbers.
   */
  async candidates(kind: Kind, ftsQuery: string, limit: number): Promise<Candidate[]> {
    await this.ready();
    const t = TABLES[kind];
    const weighted = t.weights ? `AND ${t.name}.rank MATCH 'bm25(${t.weights})'` : '';
    const rows = await this.db.execute<Candidate>(
      `SELECT e.id AS id, ${t.name}.rank AS rank
         FROM ${t.name}
         JOIN entries e ON e.rowid = ${t.name}.rowid
        WHERE ${t.name} MATCH ?1 ${weighted}
        ORDER BY ${t.name}.rank
        LIMIT ?2`,
      [ftsQuery, limit],
    );
    return [...rows];
  }

  /** The snippet each of the given entries shows for a query, in the server's `<<`…`>>` marking. */
  async snippets(kind: Kind, ftsQuery: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    await this.ready();
    const t = TABLES[kind];
    const rows = await this.db.execute<{ id: string; snippet: string }>(
      `SELECT e.id AS id, snippet(${t.name}, ${t.snippet}, '<<', '>>', '…', 24) AS snippet
         FROM ${t.name}
         JOIN entries e ON e.rowid = ${t.name}.rowid
        WHERE ${t.name} MATCH ?1
          AND ${t.name}.rowid IN (SELECT rowid FROM entries WHERE kind = ?2 AND id IN (SELECT value FROM json_each(?3)))`,
      [ftsQuery, kind, JSON.stringify(ids)],
    );
    return new Map(rows.map((r) => [r.id, r.snippet]));
  }

  /**
   * Records that a note was opened on this device, and forgets the ones beyond the last
   * `RECENT_NOTES`. Opening a note is how someone says a document matters to them here
   * without keeping its whole notebook; its files' text is fetched and kept while it is
   * on this list.
   */
  async markOpened(noteId: string, at = Date.now()): Promise<void> {
    await this.ready();
    await this.write(async () => {
      await this.db.execute(`INSERT INTO opened (note_id, at) VALUES (?1, ?2) ON CONFLICT (note_id) DO UPDATE SET at = excluded.at`, [noteId, at]);
      await this.db.execute(`DELETE FROM opened WHERE note_id NOT IN (SELECT note_id FROM opened ORDER BY at DESC, note_id LIMIT ?1)`, [RECENT_NOTES]);
    });
  }

  async opened(): Promise<string[]> {
    await this.ready();
    return (await this.db.execute<{ note_id: string }>(`SELECT note_id FROM opened ORDER BY at DESC, note_id`)).map((r) => r.note_id);
  }

  /** Waits for the writes in hand and closes the database. */
  async close(): Promise<void> {
    await this.queue;
    await this.db.close?.();
  }
}

function* batches(entries: Entry[]): Generator<Entry[]> {
  let batch: Entry[] = [];
  let bytes = 0;
  for (const e of entries) {
    const size = e.columns.reduce((n, c) => n + c.length, 0);
    if (batch.length > 0 && (batch.length >= WRITE_ROWS || bytes + size > WRITE_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(e);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}
