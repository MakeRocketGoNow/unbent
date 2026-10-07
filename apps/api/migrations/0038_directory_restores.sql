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
-- `restore_at` is when the wind-back was applied, `restore_to_at` the moment it wound
-- back to, and `restore_undo` the bookmark that reverses it, or NULL when the runtime
-- handed none back. Only a wind-back to a moment is recorded. A restore to a bookmark is
-- an undo, and clears the record rather than replacing it: the first version kept the
-- undo's own way back, and after a reload the page offered that as "Undo the wind-back"
-- — a press that would have reapplied the wind-back just taken back (found in review). A
-- load clears it too, since its way back is the before-load dump it lists. No index, for
-- the reason 0037 gives.
ALTER TABLE account_directory ADD COLUMN restore_at INTEGER;
ALTER TABLE account_directory ADD COLUMN restore_to_at INTEGER;
ALTER TABLE account_directory ADD COLUMN restore_undo TEXT;
