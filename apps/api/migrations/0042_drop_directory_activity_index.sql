-- The operator's accounts list is ordered by email now (`listOperatorAccounts` in
-- src/lib/directory.ts), and walks `user`'s unique email index, which the auth tables
-- have always had. Nothing reads 0039's activity index any more, and each new activity
-- the hourly sweep records rewrites a row's entry in it, so it goes. The dump run's
-- statements never took it (0040 says why that mattered), so no other plan changes with it.
DROP INDEX IF EXISTS idx_account_directory_activity;
