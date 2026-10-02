import type { Sql } from './sql.js';

/**
 * The change feed's writer: what every write transaction calls to say what it touched.
 *
 * The reader (`changesSince`, `snapshotPage`) is on `UserStore`; this is the half the
 * stores see. One instance per object, shared by `NotesStore` and `AttachmentsStore`,
 * because the counter is the object's: a note write and a file write interleaved must
 * come out in one order.
 *
 * Why rows here rather than "re-read everything newer than a timestamp": `updated_at` is
 * not moved by every write, deliberately — a restore from the trash keeps the note's date
 * so it does not jump to the top of the list, a tag rename changes what every note under
 * it shows without touching one — and a timestamp cannot carry a purge. A row per entity
 * touched, in the writing transaction, is complete by construction: if the write
 * committed, so did the row.
 */

/** What the feed names. A note covers its tags, fields and files; a notebook its field definitions. */
export type FeedEntity = 'note' | 'notebook' | 'tag' | 'attachment';

export interface Change {
  entity: FeedEntity;
  id: string;
  /** A tombstone: the entity is gone, not merely trashed. */
  deleted?: boolean | undefined;
}

/**
 * How much feed a store keeps. Enough that a device left in a drawer for a season, or an
 * archive-sized re-import, resumes from its cursor rather than starting over; little
 * enough that the table never becomes the biggest thing in the store. A cursor older than
 * what is kept gets `reset`, and the client hydrates again — the slow path, never a wrong
 * one.
 */
export const RETAIN_ROWS = 50_000;
export const RETAIN_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How many rows past the age window one write deletes. Bounded so a store that was idle
 * for a year does not pay for its whole feed on the first write back; the next writes
 * finish the job. Measured 2026-10-02: a batch costs about 500 rows read and written,
 * once; a write with nothing to prune costs one row read.
 */
export const PRUNE_BATCH = 500;

export class Feed {
  /** The last seq a write on this instance recorded and the object has not yet announced. */
  private unannounced: number | null = null;

  constructor(private readonly sql: Sql) {}

  /**
   * Appends one row per entity, numbered from `_meta.seq`, and prunes.
   *
   * Call inside the transaction that made the change, after the change, so the row and
   * the write commit or roll back together; private helpers may call it too, since it
   * opens no transaction of its own. Repeats within one call collapse to the last word,
   * so a method that files a note and then re-tags it records the note once.
   *
   * The counter is read, advanced by the number of rows, and written back once: one row
   * written per change and one per transaction (measured 2026-10-02 against the
   * alternative of letting the rowid count, which saved that one write and cost 40% more
   * time through `RETURNING`). An upsert rather than an UPDATE, so a store rebuilt after
   * a wipe — whose 0002 ran against an empty `_meta` — still counts from zero.
   *
   * Returns the last seq handed out, or null when there was nothing to record.
   */
  record(changes: Change[], now = Date.now()): number | null {
    const last = new Map<string, Change>();
    for (const c of changes) last.set(`${c.entity}:${c.id}`, c);
    if (last.size === 0) return null;

    let seq = this.seq();
    for (const c of last.values()) {
      this.sql.exec(
        `INSERT INTO changes (seq, entity, id, deleted, at) VALUES (?1, ?2, ?3, ?4, ?5)`,
        ++seq,
        c.entity,
        c.id,
        c.deleted ? 1 : 0,
        now,
      );
    }
    this.sql.exec(
      `INSERT INTO _meta (key, value) VALUES ('seq', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(seq),
    );
    this.prune(seq, now);
    this.unannounced = seq;
    return seq;
  }

  /**
   * Keeps the feed to `RETAIN_ROWS` and `RETAIN_MS`, reading nothing it does not delete.
   *
   * By count: seq is dense, so the rows older than the last fifty thousand are exactly
   * `seq <= latest - 50000`, a range on the primary key that is empty — and reads zero
   * rows — until the cap is reached, and one row a write after. By age: the oldest row
   * alone says whether anything is past the window (one read), and when it is, the next
   * batch of the key's prefix goes. Seq and `at` rise together, so an old row is always
   * at the front; `IN (SELECT … ORDER BY seq LIMIT 500)` read every old row to find the
   * five hundred (2,005 for 500 deleted, measured), where the range reads the batch.
   */
  private prune(latest: number, now: number): void {
    if (latest > RETAIN_ROWS) this.sql.exec(`DELETE FROM changes WHERE seq <= ?1`, latest - RETAIN_ROWS);
    const oldest = this.sql.first<{ seq: number; at: number }>(`SELECT seq, at FROM changes ORDER BY seq LIMIT 1`);
    if (oldest && oldest.at < now - RETAIN_MS) {
      this.sql.exec(
        `DELETE FROM changes WHERE seq >= ?1 AND seq < ?2 AND at < ?3`,
        oldest.seq,
        oldest.seq + PRUNE_BATCH,
        now - RETAIN_MS,
      );
    }
  }

  /** The counter now: the seq of the newest row, or 0 when nothing has ever been recorded. */
  seq(): number {
    return Number(this.sql.first<{ value: string }>(`SELECT value FROM _meta WHERE key = 'seq'`)?.value ?? 0);
  }

  /** The name of this history; see 0002-changes. */
  epoch(): string {
    return this.sql.first<{ value: string }>(`SELECT value FROM _meta WHERE key = 'feed_epoch'`)?.value ?? '';
  }

  /**
   * The seq to announce on the object's sockets, once, after the write's transaction has
   * returned — or null when nothing was recorded since the last announcement. Taken
   * after the transaction rather than sent inside it, so a write that rolled back
   * announces nothing… almost: `record` ran before the throw, so this is set and one
   * spurious nudge goes out. The client pulls, finds nothing new, and that is the whole
   * cost; the alternative, threading the outcome of every transaction back here, is not
   * worth a nudge a year.
   */
  takeAnnouncement(): number | null {
    const seq = this.unannounced;
    this.unannounced = null;
    return seq;
  }
}

// --- The reader's pure half ----------------------------------------------------------

/**
 * How many bytes of note bodies one feed or snapshot page carries before it is cut
 * short. The RPC ceiling is 32 MiB and bodies are capped at 1.8 MB each, so a hundred
 * notes of the biggest kind would pass it several times over; four leaves room for the
 * rest of the page around the bodies, and a page that is cut carries `more`, so the
 * client walks on. Measured: eight crosses in a few milliseconds, forty is refused.
 */
export const FEED_PAGE_BYTES = 4 * 1024 * 1024;

/** One row of the `changes` table, as the reader takes it. */
export interface FeedRow {
  seq: number;
  entity: FeedEntity;
  id: string;
  deleted: number;
}

/**
 * The last word per entity in a run of rows, in first-seen order. A note edited five
 * times in a page is carried once, as it now is; a purge after an edit is one tombstone.
 * (An edit after a purge cannot happen: the row is gone.)
 */
export function lastWordPerEntity(rows: FeedRow[]): Change[] {
  const last = new Map<string, Change>();
  for (const r of rows) {
    const key = `${r.entity}:${r.id}`;
    last.delete(key);
    last.set(key, { entity: r.entity, id: r.id, deleted: r.deleted === 1 });
  }
  return [...last.values()];
}

/**
 * Where to cut a page so its bodies stay under `budget`: the index of the first row that
 * overflows, charging each note once, or `rows.length` when nothing does. Never zero, so
 * a single oversized note still goes, alone. The rows kept are `rows.slice(0, cut)`,
 * and their last seq is the page's `next`.
 */
export function cutByBytes(rows: FeedRow[], bodyBytes: (noteId: string) => number, budget = FEED_PAGE_BYTES): number {
  let bytes = 0;
  const charged = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.entity !== 'note' || r.deleted === 1 || charged.has(r.id)) continue;
    charged.add(r.id);
    bytes += bodyBytes(r.id);
    if (bytes > budget && i > 0) return i;
  }
  return rows.length;
}
