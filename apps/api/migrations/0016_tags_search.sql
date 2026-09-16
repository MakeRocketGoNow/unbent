-- Search over tag names.
--
-- A note's tags are the one thing about it that search could not see: the index covers
-- the title and body (0005), attachment text (0006) and custom field values (0015), and a
-- note whose only mention of "Stelvio" is a tag called Alfa Romeo Stelvio matched nothing.
-- Evernote finds that note, and people who filed an archive by tag expect to. So the
-- names get an index of their own, in the shape of the other three: external content,
-- pointing at the rows in tags rather than copying them.
--
-- tags has a text primary key, so its rowid is the implicit one — the same situation as
-- attachment_text and note_fields. Renames are an UPDATE in place (the _au trigger below
-- sees them); merges and deletes remove the row (the _ad trigger). A tag row is created
-- by INSERT ... ON CONFLICT DO NOTHING, which fires _ai only when a row is actually
-- inserted, so a repeated name never indexes twice.
--
-- The same rule as the other three indexes applies: never `DELETE FROM tags_fts`.
-- Removing rows takes the 'delete' command with the old values, or the index corrupts
-- silently. To rebuild: INSERT INTO tags_fts(tags_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE tags_fts USING fts5(
  name,
  content='tags',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER tags_ai AFTER INSERT ON tags BEGIN
  INSERT INTO tags_fts(rowid, name) VALUES (new.rowid, new.name);
END;

CREATE TRIGGER tags_ad AFTER DELETE ON tags BEGIN
  INSERT INTO tags_fts(tags_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
END;

CREATE TRIGGER tags_au AFTER UPDATE ON tags BEGIN
  INSERT INTO tags_fts(tags_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  INSERT INTO tags_fts(rowid, name) VALUES (new.rowid, new.name);
END;

-- Every tag that already exists is indexed now.
INSERT INTO tags_fts(tags_fts) VALUES ('rebuild');
