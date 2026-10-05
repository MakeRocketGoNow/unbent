/**
 * The files a store has let go of but R2 still holds (MAK-171, part 1).
 *
 * A store keeps thirty days of history and `POST /api/admin/store/restore` winds one back,
 * but the files were in R2 and R2 was not wound back: emptying the trash or deleting a
 * file removed the object the moment the row went, so a restored row could point at
 * nothing. Now the methods that delete an attachment row write its key here instead, in
 * the transaction that removes the row, and the hourly sweep deletes from R2 only what has
 * sat here for `DELETED_BLOB_RETENTION_MS` — thirty-five days, five more than the history
 * a restore can reach, so a store wound back to any moment it can be wound back to finds
 * the file still in the bucket. A restore winds this table back with the rows, which is
 * the point: a row that comes back has its tombstone taken away in the same move, and
 * nothing deletes its file.
 *
 * `r2_key` is the primary key because a key can come back. An upload names its file's id
 * (`X-Attachment-Id`), and the key is built from it, so a replayed upload after the first
 * copy was deleted writes the same key again; `AttachmentsStore.record` takes the
 * tombstone away when it records a row, and the probe it makes to do so is one read on
 * this index. The second index is the sweep's: "what has been here longer than the
 * retention" is a range on `deleted_at`, read from the index's first entry, so a store
 * with nothing due reads nothing — the sweep visits every account every hour, and a
 * query that scanned here would be the table scan AGENTS.md forbids a periodic job. Three
 * rows written per file deleted, and three more when it is forgotten.
 *
 * Not in the feed: a client holds no deleted files. Dumped with the data tables
 * (`DATA_TABLES`), so a store rebuilt from a dump knows which files it has still to let
 * go of — without them, every file deleted before the dump would stay in the bucket as
 * an orphan nobody's sweep would find.
 */
export default `
CREATE TABLE deleted_blobs (
  r2_key     TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX idx_deleted_blobs_due ON deleted_blobs(deleted_at);
`;
