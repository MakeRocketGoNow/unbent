/**
 * Tag names unique without case, as notebook names have always been (MAK-127).
 *
 * 0001 kept tags exact — "Receipt" and "receipt" two tags, as Evernote had them — and that
 * made tags the one name in the app a write could miss by case. An assistant tagging a
 * note "receipts" beside an existing Receipts made a second tag, removing "receipts" left
 * Receipts on the note and said nothing, and `?tag=receipts` found none of Receipts' notes.
 * The web app's pickers hid most of it by offering the existing spelling; MCP, the HTTP
 * API, Auto-fill and imports did not. Now a name is found without case everywhere the
 * store looks one up, and this index is what makes "one tag per name" true.
 *
 * NOCASE folds ASCII only, deliberately: it is the collation SQLite has without ICU, the
 * one `notebooks` uses, and the one `foldNoCase` in `@unbent/shared` mirrors for the code
 * that compares names outside SQL. "Café" and "CAFÉ" stay two tags, as they are two
 * notebooks.
 *
 * Before the index can exist, a store holding both spellings has to be made to hold one.
 * Each set of names that differ only in case folds into the one on the most live notes —
 * the spelling the person has used most — and, between equals, the oldest row, which is
 * the spelling that came first. The others' notes are moved onto it and their rows go,
 * which is exactly what `renameTag` does when asked to merge, written in SQL because a
 * schema file is SQL:
 *
 *   - The join rows are moved by hand before a row goes, so the count triggers see each
 *     link leave one tag and arrive at the other and `note_count` stays right; a note
 *     carrying both spellings keeps one link (`INSERT OR IGNORE`).
 *   - The feed hears of it as it hears of a merge: a tombstone for each tag that went, a
 *     row for each that took its notes, and a row for every note whose tag ids changed.
 *     Without them a device holding the library would keep notes pointing at a tag id
 *     that no longer exists. The UNION ALL below writes tombstones first, then survivors,
 *     then notes — the order merge used to use. A client that pages the pull can apply
 *     the delete before some retags; `tagNames` then hides the tag, and a body save can
 *     send the short set. `renameTag` now records notes first so a later merge does not.
 *     This file is not edited: schema is append-only, and objects that have already run
 *     it have those rows as they were written. The rows are numbered from `_meta.seq` as
 *     `Feed.flush` numbers them, through a staging table whose rowid counts them, so the
 *     counter moves by exactly the rows written and `seq` stays dense. Nothing is
 *     announced on the sockets — a migration runs before any request — so a device finds
 *     them on its next pull, which opening the app makes.
 *   - The two staging tables are dropped in the same transaction; nothing outside this
 *     file ever sees them, and a dump never holds them.
 *
 * A store with no near-duplicates — every new one, and most others — stages nothing,
 * writes no feed row and moves no counter: every statement below is then a read of the
 * tags table, which is a few hundred rows on an archive, once.
 *
 * The note's history is not rewritten. A copy kept before this ran may name a tag id that
 * is gone; `planRestore` takes such a tag to the tag its name is today, in any case, so a
 * restore puts back the tag this file kept rather than calling it deleted. Rewriting the
 * ids inside every copy's `props` would have been a read of the whole history table.
 *
 * 0001's `UNIQUE(name)` stays, because removing a table constraint means rebuilding the
 * table; the NOCASE index is stricter, so the exact one can never be the one that refuses
 * a row. It is also the one no lookup should reach for: every statement that finds a tag
 * by name says `COLLATE NOCASE`, which is what puts this index in its plan.
 */
export default `
CREATE TABLE _tag_merge (
  loser    TEXT PRIMARY KEY,
  survivor TEXT NOT NULL
);
INSERT INTO _tag_merge (loser, survivor)
  SELECT id, survivor FROM (
    SELECT id,
           row_number() OVER fold AS rank,
           first_value(id) OVER fold AS survivor
      FROM tags
    WINDOW fold AS (PARTITION BY name COLLATE NOCASE ORDER BY note_count DESC, rowid)
  )
   WHERE rank > 1;

CREATE TABLE _tag_merge_changes (
  n       INTEGER PRIMARY KEY,
  entity  TEXT NOT NULL,
  id      TEXT NOT NULL,
  deleted INTEGER NOT NULL
);
INSERT INTO _tag_merge_changes (entity, id, deleted)
  SELECT 'tag', loser, 1 FROM _tag_merge
  UNION ALL
  SELECT DISTINCT 'tag', survivor, 0 FROM _tag_merge
  UNION ALL
  SELECT DISTINCT 'note', nt.note_id, 0
    FROM _tag_merge m JOIN note_tags nt ON nt.tag_id = m.loser;

INSERT OR IGNORE INTO _meta (key, value) VALUES ('seq', '0');
INSERT INTO changes (seq, entity, id, deleted, at)
  SELECT (SELECT CAST(value AS INTEGER) FROM _meta WHERE key = 'seq') + n,
         entity, id, deleted,
         CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    FROM _tag_merge_changes;
UPDATE _meta
   SET value = CAST(CAST(value AS INTEGER) + (SELECT COUNT(*) FROM _tag_merge_changes) AS TEXT)
 WHERE key = 'seq' AND EXISTS (SELECT 1 FROM _tag_merge_changes);

INSERT OR IGNORE INTO note_tags (note_id, tag_id)
  SELECT nt.note_id, m.survivor FROM _tag_merge m JOIN note_tags nt ON nt.tag_id = m.loser;
DELETE FROM note_tags WHERE tag_id IN (SELECT loser FROM _tag_merge);
DELETE FROM tags WHERE id IN (SELECT loser FROM _tag_merge);

DROP TABLE _tag_merge_changes;
DROP TABLE _tag_merge;

CREATE UNIQUE INDEX idx_tags_name_nocase ON tags(name COLLATE NOCASE);
`;
