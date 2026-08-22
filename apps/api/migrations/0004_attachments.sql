-- Attachments.
--
-- Blobs live in R2; this table holds the metadata and the R2 key. The key is always
-- derived from the authenticated session (users/{uid}/notes/{nid}/files/{id}-{name}) and
-- never from client input, so a wrong query still cannot reach another user's objects.
--
-- user_id is denormalized here rather than reached through note_id so ownership is
-- checkable in one indexed query on the hot attachment-serving path.

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,   -- the leaf of the relative markdown path: files/<filename>
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  md5          TEXT,            -- ENEX en-media hash, for import resolution
  r2_key       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,

  -- The invariant relative markdown paths depend on: within one note, files/foo.png
  -- resolves to exactly one object. Upload suffixes collisions rather than overwriting.
  UNIQUE(note_id, filename)
);

CREATE INDEX idx_attachments_note ON attachments(note_id);
CREATE INDEX idx_attachments_md5  ON attachments(user_id, md5);
