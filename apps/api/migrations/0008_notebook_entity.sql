-- Notebooks become a real entity instead of a string on each note.
--
-- As a derived list (SELECT DISTINCT notebook FROM notes) a notebook had no existence
-- apart from the notes naming it: it vanished when its last note was trashed, could not be
-- renamed or created empty, and "Case Test" and "case test" listed as two notebooks.
--
-- Names stay the interchange format. Export writes `notebook: <name>` into frontmatter and
-- import reads it back, so ids live inside the database and every boundary still speaks
-- names. An id in an exported markdown file would mean nothing to another editor.

CREATE TABLE notebooks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Case-insensitive per user: typing an existing name in a different case must file into
  -- the notebook that already exists rather than silently creating a second one.
  UNIQUE(user_id, name COLLATE NOCASE)
);

-- ON DELETE SET NULL is what implements "deleting a notebook unfiles its notes". Putting
-- it in the schema rather than in application code means no future call path can delete a
-- notebook and take its notes with it.
ALTER TABLE notes ADD COLUMN notebook_id TEXT REFERENCES notebooks(id) ON DELETE SET NULL;

-- Backfill one row per distinct (user, notebook). Deliberately not filtered on deleted_at:
-- a trashed note must return to its notebook when restored.
INSERT INTO notebooks (id, user_id, name, created_at)
SELECT lower(hex(randomblob(16))), user_id, notebook, unixepoch() * 1000
  FROM (SELECT DISTINCT user_id, notebook
          FROM notes
         WHERE notebook IS NOT NULL AND notebook <> '');

UPDATE notes
   SET notebook_id = (
     SELECT nb.id FROM notebooks nb
      WHERE nb.user_id = notes.user_id
        AND nb.name = notes.notebook COLLATE NOCASE
   )
 WHERE notebook IS NOT NULL AND notebook <> '';

CREATE INDEX idx_notes_user_notebook_id
  ON notes(user_id, notebook_id, deleted_at, updated_at DESC);

-- The old `notebook` column is left in place on purpose. Dropping it here would mean a
-- failed deploy loses the mapping entirely; it becomes dead weight only once the new path
-- is proven, and removing it is then a one-line migration.
