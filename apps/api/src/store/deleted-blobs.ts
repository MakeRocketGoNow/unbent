import { placeholders, runs } from './notes-shared.js';
import type { Sql } from './sql.js';

/**
 * How long a deleted file's object stays in R2 after its row has gone: thirty-five days.
 * Five more than the thirty a store can be wound back over, so that a store restored to
 * any moment in its history finds every file that moment's rows name still in the bucket.
 * The number is stated in the README ("Deleting notes", "Winding a store back"); change
 * it here and there together. Part 1 of MAK-171.
 */
export const DELETED_BLOB_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

/**
 * Keys one sweep visit takes from a store at most: what one R2 `delete()` accepts, so the
 * Worker deletes them in a single call and the visit stays at two store calls and one R2
 * call. A store with more past the retention gives up the rest on later visits.
 */
export const EXPIRED_BLOBS_PER_VISIT = 1000;

/**
 * The files a store has let go of but R2 still holds (schema 0005): the rows the trash's
 * purge and a file's delete leave behind instead of deleting the object, and the hourly
 * sweep's view of which have waited long enough.
 *
 * Private helpers in the sense `Sql.tx` means: `tombstone` and `revive` run inside the
 * transaction of the write that deletes or records the row, so a key is tombstoned if and
 * only if its row went, and `expired` and `forget` are called from the object's own
 * methods, which open theirs. Nothing here records in the change feed: a client holds no
 * deleted files.
 *
 * What the object never does is delete the object itself — the store touches its SQLite
 * and nothing else (AGENTS.md, rule 1). It says which keys are due; the Worker's sweep
 * deletes them and then calls `forget`. A key the Worker deleted and failed to tell the
 * store about is asked for again on the next visit, and deleting an absent object is a
 * no-op in R2, so the two calls need no transaction between them.
 */
export class DeletedBlobs {
  constructor(private readonly sql: Sql) {}

  /**
   * Marks `keys` as deleted at `at`. Called with the keys of the attachment rows the
   * calling transaction has just deleted, and only those — the purge methods match keys to
   * the notes they actually removed (`keysOfDeletedNotes`), and that discipline is what
   * makes a tombstone mean "the row is gone".
   *
   * A key already here has its clock restarted rather than kept: the later deletion is
   * the one the retention counts from. It cannot happen in practice — `revive` takes a
   * tombstone away when its key is recorded again — but if it did, keeping the older
   * date would let the sweep delete a file sooner than thirty-five days after its row
   * went, and that is the one direction this table must never err in.
   */
  tombstone(keys: string[], at: number): void {
    if (keys.length === 0) return;
    for (const run of runs([...new Set(keys)])) {
      this.sql.exec(
        `INSERT INTO deleted_blobs (r2_key, deleted_at)
         VALUES ${run.map((_, i) => `(?${i + 2}, ?1)`).join(', ')}
         ON CONFLICT(r2_key) DO UPDATE SET deleted_at = excluded.deleted_at`,
        at,
        ...run,
      );
    }
  }

  /**
   * Takes the tombstone off a key that is a live file again. Called when an attachment row
   * is recorded, because a key is built from the file's id and an upload can name its id:
   * a replayed upload whose first copy was since deleted writes the same key, and without
   * this the sweep would delete the new file's object thirty-five days after the old row
   * went, with the new row still pointing at it. A probe by primary key; nothing written
   * for the usual upload, whose key was never here.
   */
  revive(key: string): void {
    this.sql.exec(`DELETE FROM deleted_blobs WHERE r2_key = ?1`, key);
  }

  /**
   * The keys that have waited the retention out as of `now`, oldest first, at most `limit`
   * of them. A range on `idx_deleted_blobs_due` read from its first entry: a store with
   * nothing due reads one index entry at most, which is what lets the sweep ask every
   * account on every walk of the directory (twenty accounts an hour, `lib/sweep.ts`).
   */
  expired(now: number, limit = EXPIRED_BLOBS_PER_VISIT): string[] {
    return this.sql
      .exec<{ r2_key: string }>(
        `SELECT r2_key FROM deleted_blobs WHERE deleted_at <= ?1 ORDER BY deleted_at LIMIT ?2`,
        now - DELETED_BLOB_RETENTION_MS,
        limit,
      )
      .map((r) => r.r2_key);
  }

  /**
   * Drops the tombstones of `keys` the Worker has deleted from R2, and only those still
   * due as of `now` — the same `now` the Worker asked `expired` with. A key deleted and
   * uploaded and deleted again between the two calls has a newer tombstone, which must
   * stay: its object is in the bucket again and owes the person the full retention.
   * Returns how many went.
   *
   * One race is accepted rather than closed: a replayed upload that revives a key
   * between the sweep's `expired` and its R2 delete puts an object the sweep then
   * deletes, with the row live and no tombstone left for this guard to see. It takes an
   * upload replayed thirty-five days after its first copy was deleted, landing in the
   * milliseconds between two calls of one sweep; closing it would mean the store
   * arbitrating R2 deletes, which rule 1 forbids. Named so nobody relies on this method
   * for it.
   */
  forget(keys: string[], now: number): number {
    let forgotten = 0;
    for (const run of runs([...new Set(keys)])) {
      forgotten += this.sql.exec<{ r2_key: string }>(
        `DELETE FROM deleted_blobs
          WHERE deleted_at <= ?1 AND r2_key IN (${placeholders(2, run.length)})
          RETURNING r2_key`,
        now - DELETED_BLOB_RETENTION_MS,
        ...run,
      ).length;
    }
    return forgotten;
  }

  /**
   * A page of every tombstoned key, by key, for the account's own blob sweep
   * (`POST /api/admin/gc-blobs`), which must count a file awaiting deletion as referenced
   * or it would delete it the moment the trash was emptied — exactly what this table
   * exists to stop. Paged like `AttachmentsStore.blobKeys`, by the primary key rather than
   * the rowid so the cursor is a key the caller already has; the sweep walks until `next`
   * is null.
   */
  keys(after = '', limit = 1000): { keys: string[]; next: string | null } {
    const rows = this.sql.exec<{ r2_key: string }>(
      `SELECT r2_key FROM deleted_blobs WHERE r2_key > ?1 ORDER BY r2_key LIMIT ?2`,
      after,
      limit,
    );
    const last = rows[rows.length - 1];
    return { keys: rows.map((r) => r.r2_key), next: rows.length === limit && last ? last.r2_key : null };
  }
}
