-- Remove the notebook name column left behind by 0008.
--
-- 0008 kept it deliberately: dropping the mapping in the same migration that introduced
-- the new one would have left nothing to fall back on if the deploy failed. The
-- notebook_id path is now proven — every query in notes-repo.ts reads through
-- `notebooks`, and the two columns agreed on every row before this ran — so the old
-- column is dead weight and a second source of truth waiting to drift.
--
-- The index on it goes first: dropping a column does not remove an index over it, and a
-- stale index referencing a column that no longer exists is a corrupt schema.

DROP INDEX IF EXISTS idx_notes_user_notebook;

ALTER TABLE notes DROP COLUMN notebook;
