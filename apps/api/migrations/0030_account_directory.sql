-- A directory of accounts, for the per-account note stores.
--
-- Each account's notes are moving into a SQLite-backed Durable Object of their own (see
-- apps/api/src/store/), and nothing in the control plane can see inside one: there is no
-- query across objects, no list of them, and no way to ask "how many notes does this
-- instance hold" without waking every object. This row is the cross-account view — the
-- one place billing, usage limits, the sweep and account deletion can read without
-- touching an object — kept up to date by the sweep, which walks these rows and asks each
-- object for its `usage`.
--
-- No foreign key to `user`, deliberately. Account deletion removes the user row and then
-- has the object to wipe, and if that wipe fails the row here is the only thing left that
-- knows an object exists: `deleted_at` is set first, the wipe retried from it by the
-- sweep, and the row dropped only once the object reports itself empty. A cascade would
-- take the tombstone with the row it exists to outlive.
--
-- Backfilled from every user that exists today, so the sweep after the cutover finds all
-- of them and runs the one-time copy of each account's rows out of the tables this
-- database still holds (src/store/copy-from-d1.ts; the operator's `copy` route runs it
-- for one account). New accounts get their row from the `user.create.after` hook in
-- auth.ts.
CREATE TABLE account_directory (
  user_id        TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  -- Written by the copy before it reads a page, which is what freezes the account's rows
  -- here (migration 0032); cleared again if the copy cannot be verified.
  migrated_at    INTEGER,
  -- What the object last reported, for the cross-account view. Zero until the first sweep.
  storage_bytes  INTEGER NOT NULL DEFAULT 0,
  note_count     INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER,
  -- Set when the account is deleted; the row lives on until the object is confirmed empty.
  deleted_at     INTEGER
);

INSERT INTO account_directory (user_id, created_at)
SELECT id, unixepoch() * 1000 FROM user;
