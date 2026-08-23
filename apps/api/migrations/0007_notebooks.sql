-- First-class notebook column: one nullable value per note, unlike tags.
-- Backfill from source_enex (the ENEX filename already stored at import time).

ALTER TABLE notes ADD COLUMN notebook TEXT;

CREATE INDEX idx_notes_user_notebook
  ON notes(user_id, notebook, deleted_at, updated_at DESC);

-- Strip trailing .enex from source_enex (case-insensitive).
UPDATE notes
   SET notebook = substr(source_enex, 1, length(source_enex) - 5)
 WHERE source_enex IS NOT NULL
   AND lower(source_enex) LIKE '%.enex';

-- Remove the old notebook-as-tag link for imported notes only.
DELETE FROM note_tags
 WHERE rowid IN (
   SELECT nt.rowid
     FROM note_tags nt
     JOIN notes n  ON n.id = nt.note_id
     JOIN tags t   ON t.id = nt.tag_id
    WHERE n.source_enex IS NOT NULL
      AND n.notebook IS NOT NULL
      AND t.user_id = n.user_id
      AND t.name = n.notebook
 );
