-- Which attachments have a row of text, kept on the attachment itself.
--
-- The web app asks on every open whether any PDF still needs its text read (the pass
-- `__root.tsx` starts). "A PDF with no `attachment_text` row" is an anti-join, and the only
-- way SQLite can answer one is to walk every PDF and look each one up: the full list of
-- PDFs, twice per open, once to find up to 25 unread files and once to count what is left.
-- On an archive of 2,700 PDFs that was about 16,800 rows read to learn that nothing was
-- pending, and an archive that is mostly scanned PDFs pays that on every tab it opens.
--
-- `has_text` turns the question into a lookup. The partial index holds only the PDFs
-- without text, so finding them reads one entry per unread file, and when everything has
-- been read, which is where an archive spends nearly all its time, it reads nothing.
--
-- "Has text" means a row exists, whatever it says. An empty row is how a reader records
-- that it looked and found nothing (the text layer's `unusable`, or the vision model's
-- empty answer), so such a file is done as far as this pass is concerned; `read_by`
-- (0020) is what tells the vision pass apart, and that pass is not changed here.
--
-- Triggers rather than application code, as for the note counts (0023): rows arrive by
-- `recordText`'s upsert, by `copyText`, and leave by cascade from an attachment or a note,
-- and a trigger sees all of them. An upsert that finds its row updates rather than inserts,
-- which leaves the flag at 1, where it already is.

ALTER TABLE attachments ADD COLUMN has_text INTEGER NOT NULL DEFAULT 0;

UPDATE attachments SET has_text = 1
 WHERE id IN (SELECT attachment_id FROM attachment_text);

CREATE TRIGGER attachment_text_has_text_ai AFTER INSERT ON attachment_text BEGIN
  UPDATE attachments SET has_text = 1 WHERE id = NEW.attachment_id;
END;

-- When the attachment itself is being deleted, its text goes by cascade and this updates a
-- row that is already gone, which does nothing.
CREATE TRIGGER attachment_text_has_text_ad AFTER DELETE ON attachment_text BEGIN
  UPDATE attachments SET has_text = 0 WHERE id = OLD.attachment_id;
END;

-- Nothing moves a text row to another attachment today; the upsert changes the text and
-- `read_by`, never the key. Covered anyway, for the reason 0023 gives for `note_tags`.
CREATE TRIGGER attachment_text_has_text_au AFTER UPDATE OF attachment_id ON attachment_text
WHEN OLD.attachment_id IS NOT NEW.attachment_id
BEGIN
  UPDATE attachments SET has_text = 0 WHERE id = OLD.attachment_id;
  UPDATE attachments SET has_text = 1 WHERE id = NEW.attachment_id;
END;

-- Only the PDFs still waiting, in the order the pass takes them. A query uses a partial
-- index only when its WHERE repeats these two conditions, so `needingText` and the count
-- beside it spell them out exactly as they are here.
CREATE INDEX idx_attachments_unread_pdf ON attachments(user_id, created_at)
  WHERE content_type = 'application/pdf' AND has_text = 0;
