-- Indexes for the one-time copy of each account's rows out of these tables.
--
-- SUPERSEDED by 0035, which drops these and recreates them as expression indexes: plain
-- ones on `user_id` were picked up by `main`'s own statements and made them read whole
-- accounts. Kept as written because the dev database has already run it.
--
-- The copy pages a table by `WHERE user_id = ? AND rowid > ? ORDER BY rowid`. With the
-- indexes these tables had, the planner (no statistics here, as ever) took the `user_id`
-- prefix of some other index and then sorted every remaining row of the account for each
-- page — every page of an archive's notes read and sorted all of them, bodies included —
-- and for `notebook_fields` and `note_fields`, which had no index led by `user_id`, walked
-- every account's rows by rowid and counted them with a full scan, once per account the
-- sweep copied. Measured with EXPLAIN QUERY PLAN on a database built from these
-- migrations (found in review).
--
-- An index on `user_id` alone carries the rowid as its trailing key, so the same query
-- becomes a range seek (`user_id=? AND rowid>?`) in rowid order with no sort, and the
-- count a covering read — the plan `attachment_text` already had from
-- `idx_attachment_text_user`. These go with the tables, in the migration that drops them.
CREATE INDEX IF NOT EXISTS idx_notes_copy ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_notebooks_copy ON notebooks(user_id);
CREATE INDEX IF NOT EXISTS idx_tags_copy ON tags(user_id);
CREATE INDEX IF NOT EXISTS idx_notebook_fields_copy ON notebook_fields(user_id);
CREATE INDEX IF NOT EXISTS idx_note_fields_copy ON note_fields(user_id);
CREATE INDEX IF NOT EXISTS idx_attachments_copy ON attachments(user_id);
