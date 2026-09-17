-- Deleting a notebook stops destroying the values its fields held.
--
-- 0014 promised that "a note moved to another notebook keeps the values it has", and the
-- read path honours it: a value whose definition belongs to a notebook the note has since
-- left is shown as a foreign value, labelled with that notebook's name. Deleting the
-- notebook broke the promise twice over. It deleted every value of its fields regardless
-- of which note held them, so a note that left months ago silently lost data; and the
-- cascade-to-trash option sold recoverable deletion while stripping the notes on the way,
-- so restoring one returned a note without its values.
--
-- The fix is to let a definition outlive its notebook. `deleted_at` marks a definition
-- whose notebook is gone: it no longer appears anywhere a field can be listed, edited or
-- valued, but the values keyed to it stay readable. The notebook row itself is still
-- deleted outright -- soft-deleting it would only preserve anything if its notes kept
-- pointing at it, and they are deliberately unfiled.
--
-- `notebook_name` is why that works. The label came from a join to `notebooks`, which is
-- the row that goes; capturing the name here at delete time keeps the foreign value's
-- provenance readable ("from Coupons") after the notebook no longer exists. It is written
-- only when a definition is tombstoned, and NULL for every live one, so it cannot drift
-- out of step with a notebook that can still be renamed.
--
-- Tombstones are swept when the last value referencing them goes, so they accumulate only
-- for as long as something still needs them.
--
-- ---------------------------------------------------------------------------------------
-- WHY THIS FILE COPIES `note_fields` OUT AND BACK
--
-- The first version of this migration rebuilt `notebook_fields` and guarded the
-- `DROP TABLE` with `PRAGMA foreign_keys = OFF`. D1 ignores that pragma -- foreign key
-- enforcement belongs to Cloudflare, not to a migration, and `PRAGMA foreign_keys`
-- reports 1 there no matter what a migration asks for. So the drop cascaded through
-- `note_fields.field_id REFERENCES notebook_fields(id) ON DELETE CASCADE` and deleted
-- every custom field value in the database. It read as safe locally because it was tested
-- against stock SQLite, where the pragma does what it says; the difference between those
-- two engines is the whole incident.
--
-- The rebuild itself is still necessary, for a reason `ALTER TABLE ADD COLUMN` cannot
-- reach: `notebook_fields.notebook_id` carries `REFERENCES notebooks(id) ON DELETE
-- CASCADE`, and a tombstone's entire purpose is to outlive the notebook row. With that
-- clause in place, deleting the notebook deletes the tombstone in the same breath and the
-- values go with it -- verified on D1, not assumed.
--
-- So the values are carried across explicitly instead of being trusted to survive. They
-- are copied into a temporary table first, the rebuild runs, and they are put back. A
-- cascade during the drop then has nothing left to destroy, and correctness no longer
-- depends on a pragma any engine is free to ignore.

-- 1. Park the values somewhere no foreign key points at.
CREATE TABLE note_fields_backup AS SELECT * FROM note_fields;

-- 2. The new shape: two columns added, and no FK to `notebooks`.
CREATE TABLE notebook_fields_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- Deliberately not REFERENCES notebooks(id): a tombstone outlives its notebook, and an
  -- ON DELETE CASCADE here would take it with the row it exists to survive. Nothing else
  -- enforced it anyway -- D1 makes no promise about foreign keys, which is why every
  -- delete path in NotesRepo is written out by hand.
  notebook_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  options       TEXT,
  position      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  -- Set when the notebook is deleted; NULL for every live definition.
  deleted_at    INTEGER,
  -- The deleted notebook's name, captured alongside `deleted_at`. NULL while live.
  notebook_name TEXT,
  -- Unchanged from 0014. A tombstone cannot block a live name: `notebook_id` is a fresh
  -- UUID per notebook, so a recreated notebook never shares the constrained pair with the
  -- tombstone of the old one.
  UNIQUE(notebook_id, name COLLATE NOCASE)
);

INSERT INTO notebook_fields_new (id, user_id, notebook_id, name, type, options, position, created_at)
SELECT id, user_id, notebook_id, name, type, options, position, created_at FROM notebook_fields;

DROP TABLE notebook_fields;
ALTER TABLE notebook_fields_new RENAME TO notebook_fields;

-- 3. Put the values back, whether or not the drop above cascaded them away.
--    `INSERT OR IGNORE` because on an engine that did not cascade they are still there,
--    and re-inserting them would collide on (note_id, field_id).
INSERT OR IGNORE INTO note_fields (note_id, field_id, user_id, value_text, value_num)
SELECT note_id, field_id, user_id, value_text, value_num FROM note_fields_backup;

DROP TABLE note_fields_backup;

-- 4. The FTS index shadows note_fields by rowid. A cascade fires the _ad trigger and the
--    re-insert above fires _ai with new rowids, so the index and the table can disagree.
--    Rebuilding is the documented way to make them agree again (see 0015).
INSERT INTO note_fields_fts(note_fields_fts) VALUES ('rebuild');

CREATE INDEX idx_notebook_fields_notebook ON notebook_fields(notebook_id, position);

-- Every listing filters on `deleted_at IS NULL`, so it belongs in the index that serves them.
CREATE INDEX idx_notebook_fields_live ON notebook_fields(notebook_id, deleted_at);
