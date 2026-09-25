-- Rewrite a full-text entry only when the text it indexes changes.
--
-- The four FTS update triggers (0005, 0006, 0015, 0016) fired on every UPDATE of their
-- table, whatever it changed, and each firing deletes the row's entry and inserts it again.
-- That was harmless while the only updates were edits to the text. It is not now: a note's
-- `updated_at`, `deleted_at` and `notebook_id` change on every trash, restore, move and
-- bulk action; a tag's `note_count` changes on every tag added to or taken off a note and
-- every trash and restore of a tagged note (0023); a text row's `read_by` changes when the
-- vision model reads a file (0020). Every one of those rewrote an index entry for text that
-- had not moved. D1 bills the rows a trigger writes, and Workers Free allows 100,000 a day:
-- trashing a note with two tags wrote 17 rows where 11 do, moving 100 notes 1,400 where
-- 1,000 do, deleting a 10,900-note notebook 86,900 where 65,100 do.
--
-- Each trigger now names the columns its index holds and skips an update that leaves them
-- as they were. Nothing is rebuilt: the indexed text is unchanged by definition, so every
-- entry already matches its row. The insert and delete triggers are untouched.

DROP TRIGGER notes_au;
CREATE TRIGGER notes_au AFTER UPDATE OF title, body ON notes
  WHEN OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body
BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

DROP TRIGGER attachment_text_au;
CREATE TRIGGER attachment_text_au AFTER UPDATE OF text ON attachment_text
  WHEN OLD.text IS NOT NEW.text
BEGIN
  INSERT INTO attachment_text_fts(attachment_text_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO attachment_text_fts(rowid, text) VALUES (new.rowid, new.text);
END;

DROP TRIGGER note_fields_au;
CREATE TRIGGER note_fields_au AFTER UPDATE OF value_text ON note_fields
  WHEN OLD.value_text IS NOT NEW.value_text
BEGIN
  INSERT INTO note_fields_fts(note_fields_fts, rowid, value_text)
  VALUES ('delete', old.rowid, old.value_text);
  INSERT INTO note_fields_fts(rowid, value_text) VALUES (new.rowid, new.value_text);
END;

DROP TRIGGER tags_au;
CREATE TRIGGER tags_au AFTER UPDATE OF name ON tags
  WHEN OLD.name IS NOT NEW.name
BEGIN
  INSERT INTO tags_fts(tags_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  INSERT INTO tags_fts(rowid, name) VALUES (new.rowid, new.name);
END;
