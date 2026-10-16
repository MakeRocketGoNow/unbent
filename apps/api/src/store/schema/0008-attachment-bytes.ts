/**
 * How many bytes of files the account holds, kept on the one `note_counts` row (MAK-108).
 *
 * The plan sells storage by the block (10 GB, and 25 GB more for each add-on), and a
 * quota that nothing can measure against is no quota. `attachments.size` is on every row
 * already; what was missing was the sum without reading every row, which an upload
 * cannot afford on an archive of four thousand files and the hourly sweep may not do at
 * all (AGENTS.md, "Nothing periodic may scan a table"). So the sum is a column on the
 * totals row, kept by triggers the way `live` and `trashed` are: a row arriving adds its
 * size, a row going (deleted by name, or by the cascade when a note is purged) takes
 * it back. Backfilled once here, which reads the table once per object on its next wake.
 *
 * `size` is written once, by `AttachmentsStore.record`, from what R2 reported, and never
 * updated; the update trigger is for a method that one day does, so the total cannot
 * drift from a path this file could not foresee. `recountNotes` rebuilds it with the
 * other counts if it ever does.
 *
 * Trashed notes' files count: they are in the bucket until the trash is emptied, and the
 * quota is about the bucket. Not in the feed (a client holds no total) and dumped with
 * the row (`DUMP_TABLES`), before the triggers, so a load keeps it as it was.
 */
export default `
ALTER TABLE note_counts ADD COLUMN attachment_bytes INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO note_counts (id) SELECT 1 WHERE EXISTS (SELECT 1 FROM attachments);
UPDATE note_counts SET attachment_bytes = (SELECT COALESCE(SUM(size), 0) FROM attachments) WHERE id = 1;

CREATE TRIGGER attachments_bytes_ai AFTER INSERT ON attachments BEGIN
  INSERT OR IGNORE INTO note_counts (id) VALUES (1);
  UPDATE note_counts SET attachment_bytes = attachment_bytes + NEW.size WHERE id = 1;
END;

CREATE TRIGGER attachments_bytes_au AFTER UPDATE OF size ON attachments
WHEN OLD.size <> NEW.size
BEGIN
  UPDATE note_counts SET attachment_bytes = attachment_bytes - OLD.size + NEW.size WHERE id = 1;
END;

CREATE TRIGGER attachments_bytes_ad AFTER DELETE ON attachments BEGIN
  UPDATE note_counts SET attachment_bytes = attachment_bytes - OLD.size WHERE id = 1;
END;
`;
