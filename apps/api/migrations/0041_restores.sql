-- Every restore and load of an account's store, with the operator who asked for it
-- (MAK-198; src/lib/restores.ts, and the restore and load routes in src/routes/admin.ts).
--
-- 0038 kept one wind-back per account on its directory row, enough to offer that one's
-- undo after a reload and nothing more: a second wind-back replaced the first, an undo or
-- a load cleared it, and nothing said who had done any of it. This keeps a row for each,
-- and the operator page lists them, so the page is the record of what was done to a
-- store and by whom.
--
-- `kind` is what was asked: a wind-back to a `moment` (`to_at`), a restore to a
-- `bookmark` — an undo, when the bookmark is a recorded row's `undo`, which `undoes`
-- names — or the `load` of a dump (`dump_key`, with `before_key` the dump the load wrote
-- of the store as it stood first). `state` is how far it got: `started` is written before
-- the store is touched and stays when no answer came back, so a restore whose outcome is
-- unknown is in the list and is the newest row rather than leaving an older one's undo
-- on offer; `applied` once it was; `failed` for a load that emptied the store and did not
-- fill it. A restore the runtime refused deletes its row, since nothing happened.
-- `undo` is the bookmark that reverses the row, or NULL when the runtime handed none
-- back. Only the newest row's is offered on the page; `RestoreHistory` says why.
--
-- `operator_id` is the operator's user id, and NULL only on the rows copied below, which
-- 0038 kept without one. No foreign key, as `account_directory` has none (0030): a row
-- outlives neither its account, since the sweep deletes an account's rows with its
-- directory row, nor needs its operator to exist for the page to say who it was.
--
-- Indexed on the account alone. Every statement on the table is one account's — the
-- page's list, the match of an undo's bookmark, the sweep's delete — and the rowid rides
-- in the index, so the newest-first list reads its rows and no others. A new table, so no
-- other statement's plan moves (AGENTS.md).
CREATE TABLE restores (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  operator_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('moment', 'bookmark', 'load')),
  state TEXT NOT NULL CHECK (state IN ('started', 'applied', 'failed')),
  started_at INTEGER NOT NULL,
  applied_at INTEGER,
  to_at INTEGER,
  dump_key TEXT,
  before_key TEXT,
  undo TEXT,
  undoes INTEGER
);
CREATE INDEX idx_restores_user ON restores (user_id);

-- 0038's record of each live account's last wind-back, so its undo is still offered the
-- day this lands. Its three columns stay for now: the Worker that deploys after this
-- neither reads nor writes them, and the one before it, which runs against this schema
-- for the seconds in between, still does. A later migration drops them.
INSERT INTO restores (user_id, operator_id, kind, state, started_at, applied_at, to_at, undo)
SELECT user_id, NULL, 'moment', 'applied', restore_at, restore_at, restore_to_at, restore_undo
  FROM account_directory
 WHERE restore_at IS NOT NULL AND restore_to_at IS NOT NULL AND deleted_at IS NULL
 ORDER BY restore_at;
