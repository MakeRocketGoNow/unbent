-- Notes and tags.
--
-- `body` holds markdown WITHOUT frontmatter: title, tags, and timestamps are real columns
-- here and frontmatter is generated from them at export time. Keeping one source of truth
-- means a title edit is a column update, not a string rewrite, and the export codec stays
-- an exact inverse (see packages/shared/src/frontmatter.ts).
--
-- Every table carries user_id. D1 has no row-level security, so scoping is application
-- code; see apps/api/src/lib/repo.ts for the structural enforcement.

CREATE TABLE notes (
  id           TEXT PRIMARY KEY,          -- uuidv7: client-generatable, time-sortable
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,          -- epoch ms
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,                   -- soft delete; trash rather than destroy
  source_enex  TEXT,                      -- provenance for imported notes
  content_hash TEXT                       -- sha256(title+body); import idempotency
);

-- The note list is the hottest query; this composite covers it so the scan reads only
-- rows it returns.
CREATE INDEX idx_notes_user_updated ON notes(user_id, deleted_at, updated_at DESC);
CREATE INDEX idx_notes_user_hash    ON notes(user_id, content_hash);

CREATE TABLE tags (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

-- Reverse direction: "every note with tag X" without scanning the join table.
CREATE INDEX idx_note_tags_tag ON note_tags(tag_id, note_id);
