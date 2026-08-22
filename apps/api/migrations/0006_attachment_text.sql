-- Searchable text extracted from attachments.
--
-- Most notes in a real Evernote export are a scanned PDF with an empty body: in one
-- notebook, 90 of 108 sampled notes had zero body text. Without this table those notes
-- import as title-only stubs that no search can find, even though Evernote's OCR text is
-- already embedded in the PDFs.
--
-- Kept out of notes.body deliberately. OCR output is thousands of characters of noisy
-- text that would be unpleasant to see while editing and would bloat every export.

CREATE TABLE attachment_text (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,   -- carried so a search hit can name the file it matched
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_attachment_text_note ON attachment_text(note_id);
CREATE INDEX idx_attachment_text_user ON attachment_text(user_id);

-- External content again: the index points at attachment_text rather than copying it.
CREATE VIRTUAL TABLE attachment_text_fts USING fts5(
  text,
  content='attachment_text',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

-- Same 'delete' command requirement as notes_fts: a plain DELETE silently corrupts the
-- index rather than erroring. See migrations/0005_search.sql.
CREATE TRIGGER attachment_text_ai AFTER INSERT ON attachment_text BEGIN
  INSERT INTO attachment_text_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER attachment_text_ad AFTER DELETE ON attachment_text BEGIN
  INSERT INTO attachment_text_fts(attachment_text_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER attachment_text_au AFTER UPDATE ON attachment_text BEGIN
  INSERT INTO attachment_text_fts(attachment_text_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO attachment_text_fts(rowid, text) VALUES (new.rowid, new.text);
END;
