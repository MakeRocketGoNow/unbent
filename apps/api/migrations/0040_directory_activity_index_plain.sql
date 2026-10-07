-- Replaces 0039's index where the partial version of it landed.
--
-- 0039 was first written with `WHERE deleted_at IS NULL`, and a pull-request preview
-- applied that version to the shared dev database before review found that a partial
-- index is taken by every statement whose WHERE implies its predicate — the dump run's
-- two statements among them. The file was then rewritten without the predicate, but
-- wrangler never re-applies a migration whose name it has recorded, so dev keeps the
-- partial index and its schema no longer matches the migrations. This drops whichever
-- version is there and creates the plain one; on an instance that applied 0039 as it now
-- reads, it recreates the same index, which costs one pass over a table with a row per
-- account. The lesson, for the next time: once a preview has run, a migration on a
-- branch has landed in the shared database, and a fix is a new migration, not an edit.
DROP INDEX IF EXISTS idx_account_directory_activity;
CREATE INDEX idx_account_directory_activity
  ON account_directory (COALESCE(last_active_at, created_at) DESC, user_id DESC);
