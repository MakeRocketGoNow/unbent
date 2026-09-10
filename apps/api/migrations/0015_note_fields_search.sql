-- Search over custom field values.
--
-- A field value is exactly the kind of thing that is not in a note's body: a vendor, a
-- policy number, an invoice reference. In a paperless archive most bodies are empty and
-- the PDF's text is what search reads; a value typed into a field would otherwise be
-- invisible to the search box until a filter on that field exists. So the values get an
-- index of their own, in the shape of 0005 and 0006: external content, pointing at the
-- rows in note_fields rather than copying them.
--
-- note_fields has a composite primary key, so its rowid is the implicit one, the same
-- situation as attachment_text. The write path only ever inserts, deletes, or updates in
-- place (the upsert in NotesRepo takes the UPDATE branch on conflict), so a row keeps its
-- rowid and the _au trigger below sees it; deletes — explicit or by cascade — fire _ad.
--
-- The same rule as the other two indexes applies: never `DELETE FROM note_fields_fts`.
-- Removing rows takes the 'delete' command with the old values, or the index corrupts
-- silently. To rebuild: INSERT INTO note_fields_fts(note_fields_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE note_fields_fts USING fts5(
  value_text,
  content='note_fields',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER note_fields_ai AFTER INSERT ON note_fields BEGIN
  INSERT INTO note_fields_fts(rowid, value_text) VALUES (new.rowid, new.value_text);
END;

CREATE TRIGGER note_fields_ad AFTER DELETE ON note_fields BEGIN
  INSERT INTO note_fields_fts(note_fields_fts, rowid, value_text)
  VALUES ('delete', old.rowid, old.value_text);
END;

CREATE TRIGGER note_fields_au AFTER UPDATE ON note_fields BEGIN
  INSERT INTO note_fields_fts(note_fields_fts, rowid, value_text)
  VALUES ('delete', old.rowid, old.value_text);
  INSERT INTO note_fields_fts(rowid, value_text) VALUES (new.rowid, new.value_text);
END;

-- Values written between 0014 and this migration are indexed now.
INSERT INTO note_fields_fts(note_fields_fts) VALUES ('rebuild');
