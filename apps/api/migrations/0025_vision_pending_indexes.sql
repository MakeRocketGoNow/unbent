-- Indexes over the files the vision model has still to read, one for each kind.
--
-- "Pending for vision" was one predicate over a LEFT JOIN of every attachment to its text:
-- a picture with no text row, or a PDF whose text layer came back empty and that the model
-- has not been asked about. Like the PDF question 0024 answered, SQLite could only settle
-- it by walking every attachment the account has. Maintenance asked on every visit, and
-- the "Read N images" pass asked twice per batch of three files — the next files and the
-- count left — so reading a thousand pictures walked the whole archive hundreds of times.
--
-- The two kinds live in different tables, so each gets its own index and the queries ask
-- them separately and add the answers (see `visionPendingHalves` in attachments-repo.ts).
--
-- Pictures without text: `has_text` is 0024's flag. The type list is the vision model's
-- (`VISION_IMAGE_TYPES`) and has to match the queries' exactly for SQLite to use this.
CREATE INDEX idx_attachments_unread_image ON attachments(user_id, created_at)
  WHERE content_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp') AND has_text = 0;

-- Rows a text layer wrote empty and the model has not yet read (`read_by`, 0020). Kept on
-- `attachment_text` because that is where both facts are; the query joins back to the
-- attachment for its type and to the note for whether it is still live. Nothing else
-- in this table is empty and unread by the model, so the index stays as small as the
-- backlog.
CREATE INDEX idx_attachment_text_vision_pending ON attachment_text(user_id)
  WHERE text = '' AND read_by IS NULL;
