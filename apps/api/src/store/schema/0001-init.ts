/**
 * The per-user store's schema, as one file.
 *
 * This is the final state of D1 migrations 0003 through 0028 — the notes data plane as it
 * stood when it moved into one SQLite database per account — with three things taken out:
 *
 *   - `user_id`, from every table and every index. The database *is* the user. Nothing in
 *     here can name another account's row, so nothing needs a column to say whose it is.
 *     Every planner hazard the shared database had came from that column being on every
 *     index and matching nearly every row; here the planner sees small tables and no such
 *     column, and the `+user_id` tricks the D1 repos carried are gone with it.
 *   - Foreign keys to `user`. There is no `user` table here; the control plane stays in D1.
 *   - Columns nothing read: `attachments.md5` and its index (ENEX import resolves media
 *     by hash on the client), `idx_attachment_text_user` (a `user_id` index), and the
 *     `_unbent_meta` version row (superseded by `_migrations`).
 *
 * Everything else is the same object under the same name, so a query written against the
 * D1 schema reads the same here once its `user_id` clauses are removed. The uniqueness
 * constraints that were per user (`tags.name`, `notebooks.name`) are simply unique, and
 * the account-wide `note_counts` row is a single row keyed `id = 1`.
 *
 * Foreign keys are enforced in this engine — `PRAGMA foreign_keys` is on by default for a
 * SQLite-backed Durable Object, and the object's constructor checks it — so the `ON DELETE`
 * clauses are real here, where on D1 they were documentation. The repos still delete
 * children by hand where they always did; a cascade that also fires does nothing.
 *
 * This file is applied once, in one transaction, and never edited again. A change to the
 * schema is a new file beside it (`0002-<name>.ts`), appended to `SCHEMA` in index.ts and
 * applied on the object's next wake. Additive only: an object can be migrated forward on
 * any wake, but there is no step that runs the other way.
 */
export default `
-- Per-object facts nothing else has a home for: which user this is
-- ('user_id', written on first wake and refused on a mismatch after), whether the one-time
-- copy from D1 has run ('migrated_from_d1') and how far it got ('copy_cursor'), and, kept
-- for the change feed, the per-user sequence ('seq') and 'last_active_at'.
CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE notebooks (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Free text telling Auto-fill what the notebook is for (0021). NULL means "the name says".
  purpose    TEXT,
  -- One emoji drawn beside the name (0028). NULL means the default glyph.
  emoji      TEXT,
  -- Live notes filed here, kept by the triggers below (0023).
  note_count INTEGER NOT NULL DEFAULT 0,
  -- Case-insensitive: "Taxes" and "taxes" would export as two folders most tools treat as one.
  UNIQUE(name COLLATE NOCASE)
);

CREATE TABLE notes (
  id           TEXT PRIMARY KEY,          -- uuid: client-generatable, globally unique
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,          -- epoch ms
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,                   -- soft delete; trash rather than destroy
  source_enex  TEXT,                      -- provenance for imported notes
  content_hash TEXT,                      -- sha256(title+body); import idempotency
  notebook_id  TEXT REFERENCES notebooks(id) ON DELETE SET NULL
);

-- The list's sorts, each with a per-notebook twin (0003, 0008, 0022). A page is only cheap
-- when an index hands the rows over already in order, so the query can stop at the
-- fiftieth. Every one leads with the column the list always filters on, 'deleted_at', or
-- with the notebook and then it; the notebook halves exist because the planner would
-- otherwise walk the whole archive in sort order to find a small notebook's rows. 'id'
-- closes each because it is the list's tie-break, and an imported archive has thousands
-- of scans sharing a placeholder title.
CREATE INDEX idx_notes_updated          ON notes(deleted_at, updated_at DESC);
CREATE INDEX idx_notes_hash             ON notes(content_hash);
CREATE INDEX idx_notes_notebook_updated ON notes(notebook_id, deleted_at, updated_at DESC);
CREATE INDEX idx_notes_title            ON notes(deleted_at, title COLLATE NOCASE, id);
CREATE INDEX idx_notes_created          ON notes(deleted_at, created_at, id);
CREATE INDEX idx_notes_notebook_title   ON notes(notebook_id, deleted_at, title COLLATE NOCASE, id);
CREATE INDEX idx_notes_notebook_created ON notes(notebook_id, deleted_at, created_at, id);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- Live notes carrying the tag, kept by the triggers below (0023).
  note_count INTEGER NOT NULL DEFAULT 0,
  -- Exact, unlike notebooks: "Receipt" and "receipt" are two tags, as they were in Evernote.
  UNIQUE(name)
);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);
CREATE INDEX idx_note_tags_tag ON note_tags(tag_id, note_id);

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,   -- the leaf of the relative markdown path: files/<filename>
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  -- Whether a row of text exists for the file, whatever it says (0024). Kept by the
  -- triggers on attachment_text below, so the two cannot disagree.
  has_text     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(note_id, filename)
);
CREATE INDEX idx_attachments_note ON attachments(note_id);

-- The files a reading pass has still to read, one partial index per kind (0024, 0025), so
-- finding them reads one entry per unread file and, once an archive is read, nothing. A
-- query uses a partial index only when its WHERE repeats the index's conditions exactly,
-- so 'needingText' and 'visionPendingHalves' spell them out as they are here; the image
-- list is the vision model's ('VISION_IMAGE_TYPES').
CREATE INDEX idx_attachments_unread_pdf ON attachments(created_at)
  WHERE content_type = 'application/pdf' AND has_text = 0;
CREATE INDEX idx_attachments_unread_image ON attachments(created_at)
  WHERE content_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp') AND has_text = 0;

CREATE TABLE attachment_text (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,   -- carried so a search hit can name the file it matched
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- 'vision' when the vision model wrote the row (0020); NULL for a text layer.
  read_by       TEXT
);
CREATE INDEX idx_attachment_text_note ON attachment_text(note_id);
-- Rows a text layer wrote empty and the model has not yet read: the PDF half of the
-- vision backlog. Nothing else in this table is empty and unread, so the index stays as
-- small as the backlog.
CREATE INDEX idx_attachment_text_vision_pending ON attachment_text(attachment_id)
  WHERE text = '' AND read_by IS NULL;

-- Custom typed fields: defined per notebook, valued per note (0014, 0017, 0018, 0019).
CREATE TABLE notebook_fields (
  id            TEXT PRIMARY KEY,
  -- Deliberately not REFERENCES notebooks(id): a tombstone outlives its notebook, and an
  -- ON DELETE CASCADE here would take it with the row it exists to survive (0017).
  notebook_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- One of the shared zod schema's types. Enforced there rather than by a CHECK, which
  -- SQLite cannot alter, so a new type does not mean rebuilding the table.
  type          TEXT NOT NULL,
  -- JSON array of strings; only for the types that carry options, NULL for the rest.
  options       TEXT,
  -- Display order within the notebook. Dense from 0; reordering rewrites the whole set.
  position      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  -- Set when the notebook is deleted; NULL for every live definition (0017).
  deleted_at    INTEGER,
  -- The deleted notebook's name, captured alongside 'deleted_at', so a value the tombstone
  -- keys keeps its "from Coupons" label after the notebook row is gone. NULL while live.
  notebook_name TEXT,
  -- A rating's bounds (0018): both or neither. Only on a 'number'.
  scale_max     INTEGER,
  scale_step    REAL,
  -- Display currency for a plain number (0019).
  currency      TEXT,
  UNIQUE(notebook_id, name COLLATE NOCASE)
);
CREATE INDEX idx_notebook_fields_notebook ON notebook_fields(notebook_id, position);
CREATE INDEX idx_notebook_fields_live     ON notebook_fields(notebook_id, deleted_at);

CREATE TABLE note_fields (
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  field_id   TEXT NOT NULL REFERENCES notebook_fields(id) ON DELETE CASCADE,
  -- The canonical text form of every value, whatever its type: what export writes and
  -- what search indexes.
  value_text TEXT NOT NULL,
  -- A numeric shadow for the types that order: the number itself, a date as epoch ms at
  -- UTC midnight, a checkbox as 1 or 0. NULL for the string types.
  value_num  REAL,
  PRIMARY KEY (note_id, field_id)
);
-- Indexes a sort by a custom field can page from (0027): one field's values already in
-- order, tie-broken by note id, the text one under the collation the list sorts by.
CREATE INDEX idx_note_fields_sort_num  ON note_fields(field_id, value_num, note_id);
CREATE INDEX idx_note_fields_sort_text ON note_fields(field_id, value_text COLLATE NOCASE, note_id);

-- Full-text search: four external-content FTS5 tables shadowing the rows they index by
-- rowid, kept in step by triggers (0005, 0006, 0015, 0016). A trigger sees every write
-- however it arrives, which application code maintaining an index would not. Each update
-- trigger names the columns its index holds and skips an update that leaves them as they
-- were (0026): a trash, a move or a count change must not rewrite an entry for text that
-- has not moved.
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
CREATE TRIGGER notes_au AFTER UPDATE OF title, body ON notes
  WHEN OLD.title IS NOT NEW.title OR OLD.body IS NOT NEW.body
BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE VIRTUAL TABLE attachment_text_fts USING fts5(
  text,
  content='attachment_text',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER attachment_text_ai AFTER INSERT ON attachment_text BEGIN
  INSERT INTO attachment_text_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER attachment_text_ad AFTER DELETE ON attachment_text BEGIN
  INSERT INTO attachment_text_fts(attachment_text_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER attachment_text_au AFTER UPDATE OF text ON attachment_text
  WHEN OLD.text IS NOT NEW.text
BEGIN
  INSERT INTO attachment_text_fts(attachment_text_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO attachment_text_fts(rowid, text) VALUES (new.rowid, new.text);
END;

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
CREATE TRIGGER note_fields_au AFTER UPDATE OF value_text ON note_fields
  WHEN OLD.value_text IS NOT NEW.value_text
BEGIN
  INSERT INTO note_fields_fts(note_fields_fts, rowid, value_text)
  VALUES ('delete', old.rowid, old.value_text);
  INSERT INTO note_fields_fts(rowid, value_text) VALUES (new.rowid, new.value_text);
END;

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
CREATE TRIGGER tags_au AFTER UPDATE OF name ON tags
  WHEN OLD.name IS NOT NEW.name
BEGIN
  INSERT INTO tags_fts(tags_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  INSERT INTO tags_fts(rowid, name) VALUES (new.rowid, new.name);
END;

-- 'has_text' follows the text rows (0024): rows arrive by 'recordText''s upsert and by
-- 'copyText', and leave by cascade from an attachment or a note, and a trigger sees all
-- of them. When the attachment itself is being deleted its text goes by cascade and the
-- delete trigger updates a row already gone, which does nothing.
CREATE TRIGGER attachment_text_has_text_ai AFTER INSERT ON attachment_text BEGIN
  UPDATE attachments SET has_text = 1 WHERE id = NEW.attachment_id;
END;
CREATE TRIGGER attachment_text_has_text_ad AFTER DELETE ON attachment_text BEGIN
  UPDATE attachments SET has_text = 0 WHERE id = OLD.attachment_id;
END;
CREATE TRIGGER attachment_text_has_text_au AFTER UPDATE OF attachment_id ON attachment_text
WHEN OLD.attachment_id IS NOT NEW.attachment_id
BEGIN
  UPDATE attachments SET has_text = 0 WHERE id = OLD.attachment_id;
  UPDATE attachments SET has_text = 1 WHERE id = NEW.attachment_id;
END;

-- Note counts kept as notes change, instead of counted every time they are shown (0023).
-- A count is a read of every row it counts, and rows read are metered here as they were
-- on D1; the sidebar shows one beside every notebook and tag and the list refetches after
-- every save. Stored, each is one row. What is counted is live notes: a trashed note
-- leaves every count beside a notebook or tag and appears only in 'trashed'.
--
-- Nothing may treat these as the truth for something destructive. Every confirmation that
-- names how many notes it will delete still counts them live; these are for display, and
-- 'recountNotes' can rebuild them from the notes if one is ever wrong.
--
-- The account-wide totals are one row, 'id = 1', created by the first note's trigger and
-- only ever updated after. Readers treat a missing row as zeros.
CREATE TABLE note_counts (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  live    INTEGER NOT NULL DEFAULT 0,
  unfiled INTEGER NOT NULL DEFAULT 0,  -- live and in no notebook
  trashed INTEGER NOT NULL DEFAULT 0
);

-- A note arrives. It has no tags yet: note_tags references it, so those rows come after.
CREATE TRIGGER notes_counts_ai AFTER INSERT ON notes BEGIN
  INSERT OR IGNORE INTO note_counts (id) VALUES (1);
  UPDATE note_counts
     SET live    = live    + (NEW.deleted_at IS NULL),
         unfiled = unfiled + (NEW.deleted_at IS NULL AND NEW.notebook_id IS NULL),
         trashed = trashed + (NEW.deleted_at IS NOT NULL)
   WHERE id = 1;
  UPDATE notebooks SET note_count = note_count + 1
   WHERE id = NEW.notebook_id AND NEW.deleted_at IS NULL;
END;

-- A note moves notebook, is trashed or is restored. Guarded by WHEN so a body save costs
-- nothing here: UPDATE OF alone fires whenever the column is named in the SET, changed or
-- not. Each count takes off the note's old contribution and adds its new one, which is
-- right whichever of the two columns changed, or both at once.
CREATE TRIGGER notes_counts_au AFTER UPDATE OF notebook_id, deleted_at ON notes
WHEN OLD.notebook_id IS NOT NEW.notebook_id
  OR (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL)
BEGIN
  UPDATE note_counts
     SET live    = live    - (OLD.deleted_at IS NULL) + (NEW.deleted_at IS NULL),
         unfiled = unfiled - (OLD.deleted_at IS NULL AND OLD.notebook_id IS NULL)
                           + (NEW.deleted_at IS NULL AND NEW.notebook_id IS NULL),
         trashed = trashed - (OLD.deleted_at IS NOT NULL) + (NEW.deleted_at IS NOT NULL)
   WHERE id = 1;
  UPDATE notebooks SET note_count = note_count - 1
   WHERE id = OLD.notebook_id AND OLD.deleted_at IS NULL;
  UPDATE notebooks SET note_count = note_count + 1
   WHERE id = NEW.notebook_id AND NEW.deleted_at IS NULL;
  -- Trashing or restoring takes the note out of, or puts it back into, every tag it has.
  UPDATE tags SET note_count = note_count + (NEW.deleted_at IS NULL) - (OLD.deleted_at IS NULL)
   WHERE (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL)
     AND id IN (SELECT tag_id FROM note_tags WHERE note_id = NEW.id);
END;

-- A note is deleted for good. BEFORE, so the note can still be read: a tag's count depends
-- on whether each of its notes is live, which only the note row can say, and by the time
-- the cascade reaches note_tags the note row is gone. So the note's own trigger deletes
-- its note_tags while it can still be read, and the tag triggers below handle those rows
-- like any other removal. The cascade then finds nothing left to do.
CREATE TRIGGER notes_counts_bd BEFORE DELETE ON notes BEGIN
  DELETE FROM note_tags WHERE note_id = OLD.id;
  UPDATE note_counts
     SET live    = live    - (OLD.deleted_at IS NULL),
         unfiled = unfiled - (OLD.deleted_at IS NULL AND OLD.notebook_id IS NULL),
         trashed = trashed - (OLD.deleted_at IS NOT NULL)
   WHERE id = 1;
  UPDATE notebooks SET note_count = note_count - 1
   WHERE id = OLD.notebook_id AND OLD.deleted_at IS NULL;
END;

-- A tag goes on, or comes off, a note. It counts only if the note is live.
CREATE TRIGGER note_tags_counts_ai AFTER INSERT ON note_tags BEGIN
  UPDATE tags SET note_count = note_count + 1
   WHERE id = NEW.tag_id
     AND EXISTS (SELECT 1 FROM notes WHERE id = NEW.note_id AND deleted_at IS NULL);
END;
CREATE TRIGGER note_tags_counts_ad AFTER DELETE ON note_tags BEGIN
  UPDATE tags SET note_count = note_count - 1
   WHERE id = OLD.tag_id
     AND EXISTS (SELECT 1 FROM notes WHERE id = OLD.note_id AND deleted_at IS NULL);
END;
-- Nothing updates a note_tags row today — renaming a tag inserts and deletes — but a
-- count that one future UPDATE could silently break is not worth saving four lines over.
CREATE TRIGGER note_tags_counts_au AFTER UPDATE ON note_tags BEGIN
  UPDATE tags SET note_count = note_count - 1
   WHERE id = OLD.tag_id
     AND EXISTS (SELECT 1 FROM notes WHERE id = OLD.note_id AND deleted_at IS NULL);
  UPDATE tags SET note_count = note_count + 1
   WHERE id = NEW.tag_id
     AND EXISTS (SELECT 1 FROM notes WHERE id = NEW.note_id AND deleted_at IS NULL);
END;
`;
