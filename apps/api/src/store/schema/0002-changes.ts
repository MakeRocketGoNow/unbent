/**
 * The change feed: one row per entity a write touched, numbered by the object's own
 * counter, so a client can ask "what changed since N?" and be answered in order.
 *
 * `seq` is the rowid, kept dense by `record` (store/feed.ts), which hands out
 * `_meta.seq + 1 … + n` inside the writing transaction and stores the last one back.
 * Dense matters twice: "the last 50,000 rows" is then a range on the primary key, which
 * is what lets pruning read nothing until it has something to delete, and a client's
 * cursor is exactly the seq it last applied. No other index, on purpose: every index
 * is one more row written per change (measured 2026-10-02), and the one read shape the
 * feed has, `WHERE seq > ?`, is the primary key's.
 *
 * `entity` is one of note, notebook, tag, attachment. A note row covers its tags, fields
 * and files (the reader takes the note whole); a notebook row covers its field
 * definitions; a tag row is a rename, merge or delete; an attachment row is a file added,
 * removed, or its text arriving. `deleted` marks a tombstone: a purge, never the trash,
 * which is an update of the note. `at` is when, for the age half of retention.
 *
 * `_meta.seq` starts at 0, so a client that has applied nothing says `since=0`.
 * `_meta.feed_epoch` names this history: a point-in-time restore winds `seq` back with
 * everything else, and a client whose cursor sits in the rewound range would otherwise
 * miss the part written again on top of it. The restore route changes the epoch after a
 * confirmed restore (`UserStore.feedRestored`), and a client that sees a different epoch
 * from the one it stored starts over. `INSERT OR IGNORE` on both, because this file is
 * applied to objects that have been in use under 0001 and must leave what it finds.
 */
export default `
CREATE TABLE changes (
  seq     INTEGER PRIMARY KEY,
  entity  TEXT NOT NULL,
  id      TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  at      INTEGER NOT NULL
);

INSERT OR IGNORE INTO _meta (key, value) VALUES ('seq', '0');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('feed_epoch', lower(hex(randomblob(16))));
`;
