-- The order the operator's accounts list pages in (MAK-171, part 5; `listOperatorAccounts`
-- in src/lib/directory.ts): newest activity first, where activity is the newest write the
-- sweep recorded, else the account's creation, with the id breaking ties.
--
-- An expression index, deliberately, and partial: 0037's rule against a plain index on
-- this table stands, because the planner has no statistics and takes any index whose
-- first column fits a statement's WHERE, so a plain `last_active_at` index would be taken
-- by statements that never asked for it. An index on this exact spelling is taken by
-- nothing but a statement that writes the same expression (AGENTS.md), and the list's
-- query is the only one that does. Without it every page of the list sorted the whole
-- live directory and its `user` join to take fifty rows, and the list refetches every
-- five minutes (found in review). The partial predicate matches the list's own
-- `deleted_at IS NULL`, so tombstoned rows cost the index nothing.
CREATE INDEX idx_account_directory_activity
  ON account_directory (COALESCE(last_active_at, created_at) DESC, user_id DESC)
  WHERE deleted_at IS NULL;
