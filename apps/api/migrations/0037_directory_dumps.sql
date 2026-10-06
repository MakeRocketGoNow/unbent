-- What the daily backup knows of each account's last dump (MAK-171, part 2;
-- src/lib/backups.ts). Written only by the dump run, at :47 each hour, and read by it.
--
-- `dump_at`, `dump_bytes` and `dump_mark` describe the newest dump in the backups bucket:
-- when it was written, its size, and the change feed's epoch and seq it was taken at — the
-- mark the next run compares the store's against, so an account nobody has touched is not
-- dumped again. `dump_checked_at` is when a run last found that dump current, by writing it
-- or by finding the mark unmoved; it is what "stale" is measured from, since an idle
-- account's newest dump is legitimately days old. `dump_tried_at` is when a run last tried
-- the account at all, which is what limits it to one attempt a day: a dump that fails is
-- not retried every hour in front of every other account. `dump_error` is the last
-- attempt's failure, cleared by the next success.
--
-- No index. The run reads the directory twice an hour — the accounts due, and the status
-- it writes for the mirror — and an index whose first column is one of these would be taken
-- by every other statement on the table that could use it (AGENTS.md).
ALTER TABLE account_directory ADD COLUMN dump_at INTEGER;
ALTER TABLE account_directory ADD COLUMN dump_bytes INTEGER;
ALTER TABLE account_directory ADD COLUMN dump_mark TEXT;
ALTER TABLE account_directory ADD COLUMN dump_checked_at INTEGER;
ALTER TABLE account_directory ADD COLUMN dump_tried_at INTEGER;
ALTER TABLE account_directory ADD COLUMN dump_error TEXT;
