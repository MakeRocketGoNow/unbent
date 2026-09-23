-- Note counts kept as notes change, instead of counted every time they are shown.
--
-- A count in SQLite is a read of every row it counts, and D1 bills each of those reads. The
-- sidebar shows a count beside every notebook and tag, the list header shows the total, and
-- the list refetches after every save — so on an archive of thirteen thousand notes, a pause
-- in typing cost well over ten thousand rows read to redraw numbers that had not changed.
-- Stored, each is one row: the notebook's, the tag's, or the account's.
--
-- What is counted is live notes, the same as the queries these replace: a trashed note
-- leaves every count beside a notebook or tag, and appears only in `trashed`.
--
-- Triggers rather than application code, for the reason the search indexes use them (0005):
-- a trigger sees every write however it arrives — the editor, import, a batch move, MCP,
-- purge — and runs inside the statement that caused it, so a count cannot be left behind by
-- a request that failed halfway. A count maintained in code is right only on the paths that
-- remembered to maintain it.
--
-- Nothing may treat these as the truth for something destructive. Every confirmation that
-- names how many notes it will delete still counts them live; these are for display, and
-- Maintenance can recount them from the notes if one is ever wrong.
--
-- ---------------------------------------------------------------------------------------
-- WHY A NOTE'S TAGS ARE REMOVED BY THE NOTE'S OWN TRIGGER
--
-- A tag's count depends on whether each of its notes is live, which only the note row can
-- say. When a note is deleted its `note_tags` rows go by `ON DELETE CASCADE`, and by the
-- time a trigger on `note_tags` runs for those, the note row is already gone: there is no
-- way left to ask whether it was live. So the note's BEFORE DELETE trigger deletes its
-- `note_tags` itself, while the note can still be read, and the tag triggers below handle
-- those rows like any other removal. The cascade then finds nothing left to do.
--
-- That keeps the tag arithmetic in one place, and it does not depend on how D1 orders a
-- cascade against the triggers it fires — the question 0017 answered wrongly by testing on
-- stock SQLite.
-- ---------------------------------------------------------------------------------------

ALTER TABLE notebooks ADD COLUMN note_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tags ADD COLUMN note_count INTEGER NOT NULL DEFAULT 0;

-- The account-wide totals, one row per user who has ever had a note. A user with no row
-- has no notes; readers treat a missing row as zeros.
CREATE TABLE note_counts (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  live    INTEGER NOT NULL DEFAULT 0,
  unfiled INTEGER NOT NULL DEFAULT 0,  -- live and in no notebook
  trashed INTEGER NOT NULL DEFAULT 0
);

-- Backfill from the rows as they stand. The triggers below keep them from here.
INSERT INTO note_counts (user_id, live, unfiled, trashed)
SELECT user_id,
       SUM(deleted_at IS NULL),
       SUM(deleted_at IS NULL AND notebook_id IS NULL),
       SUM(deleted_at IS NOT NULL)
  FROM notes
 GROUP BY user_id;

UPDATE notebooks SET note_count = (
  SELECT COUNT(*) FROM notes n
   WHERE n.notebook_id = notebooks.id AND n.user_id = notebooks.user_id AND n.deleted_at IS NULL
);

UPDATE tags SET note_count = (
  SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
   WHERE nt.tag_id = tags.id AND n.deleted_at IS NULL
);

-- A note arrives. It has no tags yet: `note_tags` references it, so those rows come after.
--
-- The INSERT OR IGNORE is the only place a totals row is created. Every other trigger only
-- UPDATEs one, which does nothing if the row is gone — and during account deletion it is,
-- because the cascade removes it. An upsert there would try to recreate the row for a user
-- who no longer exists and fail the deletion.
CREATE TRIGGER notes_counts_ai AFTER INSERT ON notes BEGIN
  INSERT OR IGNORE INTO note_counts (user_id) VALUES (NEW.user_id);
  UPDATE note_counts
     SET live    = live    + (NEW.deleted_at IS NULL),
         unfiled = unfiled + (NEW.deleted_at IS NULL AND NEW.notebook_id IS NULL),
         trashed = trashed + (NEW.deleted_at IS NOT NULL)
   WHERE user_id = NEW.user_id;
  UPDATE notebooks SET note_count = note_count + 1
   WHERE id = NEW.notebook_id AND NEW.deleted_at IS NULL;
END;

-- A note moves notebook, is trashed or is restored.
--
-- Guarded by WHEN so a body save costs nothing here. `UPDATE OF` alone is not enough: it
-- fires whenever the column is named in the SET, changed or not, and re-trashing a trashed
-- note changes `deleted_at` without changing whether the note is live.
--
-- Each count takes off the note's old contribution and adds its new one, which is right
-- whichever of the two columns changed, or both at once — deleting a notebook with "move
-- its notes to Trash" does both in one statement.
CREATE TRIGGER notes_counts_au AFTER UPDATE OF notebook_id, deleted_at ON notes
WHEN OLD.notebook_id IS NOT NEW.notebook_id
  OR (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL)
BEGIN
  UPDATE note_counts
     SET live    = live    - (OLD.deleted_at IS NULL) + (NEW.deleted_at IS NULL),
         unfiled = unfiled - (OLD.deleted_at IS NULL AND OLD.notebook_id IS NULL)
                           + (NEW.deleted_at IS NULL AND NEW.notebook_id IS NULL),
         trashed = trashed - (OLD.deleted_at IS NOT NULL) + (NEW.deleted_at IS NOT NULL)
   WHERE user_id = NEW.user_id;
  UPDATE notebooks SET note_count = note_count - 1
   WHERE id = OLD.notebook_id AND OLD.deleted_at IS NULL;
  UPDATE notebooks SET note_count = note_count + 1
   WHERE id = NEW.notebook_id AND NEW.deleted_at IS NULL;
  -- Trashing or restoring takes the note out of, or puts it back into, every tag it has.
  UPDATE tags SET note_count = note_count + (NEW.deleted_at IS NULL) - (OLD.deleted_at IS NULL)
   WHERE (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL)
     AND id IN (SELECT tag_id FROM note_tags WHERE note_id = NEW.id);
END;

-- A note is deleted for good. BEFORE, so the note can still be read; see the note at the top.
CREATE TRIGGER notes_counts_bd BEFORE DELETE ON notes BEGIN
  DELETE FROM note_tags WHERE note_id = OLD.id;
  UPDATE note_counts
     SET live    = live    - (OLD.deleted_at IS NULL),
         unfiled = unfiled - (OLD.deleted_at IS NULL AND OLD.notebook_id IS NULL),
         trashed = trashed - (OLD.deleted_at IS NOT NULL)
   WHERE user_id = OLD.user_id;
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

-- Nothing updates a `note_tags` row today — renaming a tag inserts and deletes — but a
-- count that one future UPDATE could silently break is not worth saving four lines over.
CREATE TRIGGER note_tags_counts_au AFTER UPDATE ON note_tags BEGIN
  UPDATE tags SET note_count = note_count - 1
   WHERE id = OLD.tag_id
     AND EXISTS (SELECT 1 FROM notes WHERE id = OLD.note_id AND deleted_at IS NULL);
  UPDATE tags SET note_count = note_count + 1
   WHERE id = NEW.tag_id
     AND EXISTS (SELECT 1 FROM notes WHERE id = NEW.note_id AND deleted_at IS NULL);
END;
