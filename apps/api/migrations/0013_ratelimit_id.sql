-- Give `rateLimit` the id column Better Auth expects of every table.
--
-- 0011 made `key` the primary key, which is how the limiter looks a row up and reads
-- naturally. Better Auth nonetheless treats `id` as present on every model it manages, and
-- 1.7.3 added a schema check at startup that says so out loud: without this column the
-- Worker answers 500 to *every* request, including ones that never touch the limiter,
-- because the check runs when the instance is built rather than when the table is used.
--
-- SQLite cannot add a primary key with ALTER TABLE, so the table is rebuilt. Existing
-- counters are carried over rather than dropped: they expire on their own in seconds, but
-- discarding them mid-window would hand anyone being limited a fresh allowance, and the
-- copy costs nothing on a table this size.
--
-- `key` keeps its uniqueness, which 0011 explains is load-bearing: the limiter races two
-- isolates against that constraint on purpose, catches the violation, and re-reads.

CREATE TABLE rateLimit_new (
  id          TEXT    PRIMARY KEY,
  key         TEXT    NOT NULL,
  count       INTEGER NOT NULL,
  lastRequest INTEGER NOT NULL
);

-- Existing rows have no id of their own; the key is unique, so it serves as one.
INSERT INTO rateLimit_new (id, key, count, lastRequest)
  SELECT key, key, count, lastRequest FROM rateLimit;

DROP TABLE rateLimit;

ALTER TABLE rateLimit_new RENAME TO rateLimit;

CREATE UNIQUE INDEX idx_rateLimit_key ON rateLimit(key);
