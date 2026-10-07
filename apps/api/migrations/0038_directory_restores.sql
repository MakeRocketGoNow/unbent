-- The last point-in-time restore of each account's store, for the operator page
-- (MAK-189; src/routes/admin.ts, the restore route).
--
-- A restore's answer carries the bookmark of the store as it stood the instant before
-- (`undo`), good for thirty days. The page offered it as "Undo the wind-back" from the
-- answer alone, so leaving the page — to look at a note the restore brought back, which is
-- the first thing an operator does — lost it, and the only other copy was a line in the
-- Worker's log. The object's own storage cannot hold it: a restore winds that storage
-- back with everything else, so the undo of an undo would vanish as it was used. The
-- directory is outside the object and already the operator's view of the account.
--
-- `restore_at` is when the restore was applied, `restore_to_at` the moment it wound back
-- to, or NULL when it went to a bookmark (an undo), and `restore_undo` the bookmark that
-- reverses it, or NULL when the runtime handed none back. One record, the latest: an undo
-- is a restore too, so after one the row holds the undo's own way back, which is the
-- state the undo replaced. No index, for the reason 0037 gives.
ALTER TABLE account_directory ADD COLUMN restore_at INTEGER;
ALTER TABLE account_directory ADD COLUMN restore_to_at INTEGER;
ALTER TABLE account_directory ADD COLUMN restore_undo TEXT;
