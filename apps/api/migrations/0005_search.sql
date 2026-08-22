-- Full-text search over notes.
--
-- External-content FTS5 (content='notes'): the index references the notes table rather
-- than storing a second copy of every body, which matters against D1's 10GB cap.
--
-- CRITICAL: with external content, rows must be removed from the index with the special
-- 'delete' command carrying the OLD column values. A plain `DELETE FROM notes_fts` does
-- not error — it silently corrupts the index, and the corruption only surfaces later as
-- stale or missing search hits. The delete-then-insert pattern in notes_au is the same
-- requirement for updates.
--
-- notes_fts carries no user_id, so every query MUST join back to notes and filter there.
-- See NotesRepo.search.

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  body,
  content='notes',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- Populate from any notes that already exist. Also the recovery path if the index is ever
-- rebuilt from scratch: INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
