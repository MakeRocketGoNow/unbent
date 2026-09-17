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

-- SQLite cannot drop a table constraint, and UNIQUE(notebook_id, name) has to become
-- partial: a tombstone must not block the name in a notebook that is recreated under the
-- same name later. Rebuilt rather than altered for that one reason.
CREATE TABLE notebook_fields_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- No longer REFERENCES notebooks(id): a tombstone outlives its notebook by design, and
  -- the ON DELETE CASCADE that was here would take it with the row it has to survive.
  notebook_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  options       TEXT,
  position      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  -- Set when the notebook is deleted; NULL for every live definition.
  deleted_at    INTEGER,
  -- The deleted notebook's name, captured alongside `deleted_at`. NULL while live.
  notebook_name TEXT
);

INSERT INTO notebook_fields_new (id, user_id, notebook_id, name, type, options, position, created_at)
SELECT id, user_id, notebook_id, name, type, options, position, created_at FROM notebook_fields;

-- note_fields.field_id references notebook_fields(id), so dropping the old table with
-- foreign keys enforced would cascade every value away. D1 does not promise they are on,
-- which is why each delete path here is explicit; this one statement needs them off.
PRAGMA foreign_keys = OFF;
DROP TABLE notebook_fields;
ALTER TABLE notebook_fields_new RENAME TO notebook_fields;
PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX idx_notebook_fields_name_live
  ON notebook_fields(notebook_id, name COLLATE NOCASE)
  WHERE deleted_at IS NULL;

-- Recreated with the table. The live-only partial index above serves name lookups; this
-- one is the ordered read of a notebook's fields, as in 0014.
CREATE INDEX idx_notebook_fields_notebook ON notebook_fields(notebook_id, position);
