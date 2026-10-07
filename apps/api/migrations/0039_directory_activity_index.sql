-- The order the operator's accounts list pages in (MAK-171, part 5; `listOperatorAccounts`
-- in src/lib/directory.ts): newest activity first, where activity is the newest write the
-- sweep recorded, else the account's creation, with the id breaking ties.
--
-- An expression index, deliberately, and not partial. 0037's rule against a plain index
-- on this table stands: the planner has no statistics and takes any index whose first
-- column fits a statement's WHERE, so a plain `last_active_at` index would be taken by
-- statements that never asked for it. An index on this exact spelling is taken by nothing
-- but a statement that writes the same expression, and the list's query is the only one
-- that does. A `WHERE deleted_at IS NULL` on the index would undo that: SQLite takes a
-- partial index for any statement whose WHERE implies its predicate, and the dump run's
-- two statements say `deleted_at IS NULL` too — with the predicate they walked this index
-- plus a table lookup per row on every hourly run (found in review). Without the
-- predicate every plan on the table but the list's is what it was; the list filters the
-- few tombstoned rows itself. 0040 replaces the index where the partial version landed. Before this index every page of the list sorted the whole live directory
-- and its `user` join to take fifty rows, and the list refetches every five minutes.
CREATE INDEX idx_account_directory_activity
  ON account_directory (COALESCE(last_active_at, created_at) DESC, user_id DESC);
