-- One-time links an assistant can upload a file to, minted by the MCP tool
-- prepare_attachment_upload.
--
-- A tool call is JSON the model writes, so it cannot carry a file of any real size; what it
-- can carry is a URL. The tool writes a row here and hands back a URL naming a random token,
-- and whatever holds the file (the assistant's own shell, usually curl) PUTs the bytes to
-- it. The row says whose note the bytes are for, under what name, and until when.
--
-- The token is stored hashed. The URL is the credential, like a session cookie, so a copy of
-- this table must not be a set of working links. SHA-256 rather than a slow hash, because the
-- token is 32 random bytes and there is nothing to guess.
--
-- Single use: the upload route deletes the row as it claims it, so a link that leaked after
-- it was used opens nothing. An expired row that was never used is pruned the next time its
-- owner mints another; the table only ever holds a handful.
--
-- `note_id` is not a foreign key. The upload re-checks that the note is still the owner's
-- and still live, which a foreign key would not (a trashed note still exists), and a row
-- outliving its note by half an hour is harmless.
CREATE TABLE attachment_uploads (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  note_id      TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT,
  link         INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- The prune on mint is per user; without this it would read every user's rows.
CREATE INDEX attachment_uploads_user ON attachment_uploads(user_id);
