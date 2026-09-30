-- Replaces 0034's indexes with ones only the copy can use.
--
-- 0034 indexed `user_id` on six tables so the copy from D1 could page each account by
-- rowid. With no statistics, the planner then took those indexes for statements it used
-- to answer narrowly: a file lookup by note (`WHERE note_id = ? AND user_id = ?`) went
-- from the note index to every file row of the account, and the import's duplicate check
-- from the hash index to every live note. Those statements are `main`'s, and `main` is
-- what the dev instance serves from this database until the cutover merges, what
-- production runs while a deploy drains, and what a rollback would run again (found in
-- review, measured with EXPLAIN QUERY PLAN against these migrations).
--
-- An expression index is matched only by a statement that spells the same expression, so
-- `(user_id || '')` gives the copy its range seek — `SEARCH … idx_notes_copy (<expr>=? AND
-- rowid>?)` — and nothing else can pick it up. The copy's statements write the expression;
-- `migrations.test.ts` pins both the copy's plans and `main`'s.
--
-- Drop and recreate rather than edit 0034: the dev database has already run it.
-- Production runs both in one deploy and builds the plain indexes only to drop them,
-- which is one extra pass over the tables. These go with the tables, in the migration
-- that drops them, and scripts/unfreeze-note-tables.sql drops them for a rollback.
DROP INDEX IF EXISTS idx_notes_copy;
DROP INDEX IF EXISTS idx_notebooks_copy;
DROP INDEX IF EXISTS idx_tags_copy;
DROP INDEX IF EXISTS idx_notebook_fields_copy;
DROP INDEX IF EXISTS idx_note_fields_copy;
DROP INDEX IF EXISTS idx_attachments_copy;
CREATE INDEX IF NOT EXISTS idx_notes_copy ON notes((user_id || ''));
CREATE INDEX IF NOT EXISTS idx_notebooks_copy ON notebooks((user_id || ''));
CREATE INDEX IF NOT EXISTS idx_tags_copy ON tags((user_id || ''));
CREATE INDEX IF NOT EXISTS idx_notebook_fields_copy ON notebook_fields((user_id || ''));
CREATE INDEX IF NOT EXISTS idx_note_fields_copy ON note_fields((user_id || ''));
CREATE INDEX IF NOT EXISTS idx_attachments_copy ON attachments((user_id || ''));
