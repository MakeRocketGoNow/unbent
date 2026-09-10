-- Custom typed fields: defined per notebook, valued per note.
--
-- A field belongs to a notebook rather than to the account, because a notebook is where a
-- kind of thing lives: "Merchant" and "Expires" make sense on coupons and not on recipes.
-- A note holds a value for a field. Nothing here says a note *must* have one — the
-- definitions are a template for what notes in this notebook usually carry, not a
-- constraint, and a note moved to another notebook keeps the values it has.
--
-- Values are keyed by the definition's id rather than its name, so renaming a field is one
-- row update and no value is rewritten — the same reason notebooks became an entity in
-- 0008. Names are still the interchange format: export writes each value as a top-level
-- frontmatter key so Obsidian reads it as a property, and import resolves a key back to a
-- definition by name. Ids never leave the database's world.
--
-- Values live in these tables and not as frontmatter inside `body`, for the reason 0003
-- gives for every other column: one source of truth, and the export codec stays an exact
-- inverse of the columns rather than a parser of the body.

CREATE TABLE notebook_fields (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- One of text, number, date, checkbox, url, email, phone, select. Enforced by the shared
  -- zod schema that every write passes through rather than by a CHECK here: SQLite cannot
  -- alter a CHECK constraint, so a ninth type would otherwise mean rebuilding the table.
  type        TEXT NOT NULL,
  -- JSON array of strings. Only meaningful for `select`; NULL for every other type.
  options     TEXT,
  -- Display order within the notebook. Dense from 0; reordering rewrites the whole set.
  position    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  -- Case-insensitive within a notebook, matching notebook names: "amount" and "Amount"
  -- would export as two YAML keys that most tools treat as one.
  UNIQUE(notebook_id, name COLLATE NOCASE)
);

CREATE INDEX idx_notebook_fields_notebook ON notebook_fields(notebook_id, position);

CREATE TABLE note_fields (
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  field_id   TEXT NOT NULL REFERENCES notebook_fields(id) ON DELETE CASCADE,
  -- Carried here as on attachment_text: a search join and the value writes can scope to
  -- the user without a second hop through notes.
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- The canonical text form of every value, whatever its type: numbers as JavaScript
  -- prints them, dates as YYYY-MM-DD, checkboxes as 'true' or 'false', the string types
  -- as themselves. This is what export writes and what search will index.
  value_text TEXT NOT NULL,
  -- A numeric shadow for the types that order: the number itself, a date as epoch ms at
  -- UTC midnight, a checkbox as 1 or 0. NULL for the string types. Nothing reads it yet.
  -- It exists so that sorting and range filters can be added later without rewriting
  -- every value, and it is maintained from day one so that backfill never has to happen.
  value_num  REAL,
  PRIMARY KEY (note_id, field_id)
);

-- The two access paths a filter or sort will need: by field, ordered by number or by text.
CREATE INDEX idx_note_fields_field_num  ON note_fields(field_id, value_num);
CREATE INDEX idx_note_fields_field_text ON note_fields(field_id, value_text);
