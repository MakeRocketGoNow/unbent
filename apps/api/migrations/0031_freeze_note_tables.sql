-- Freezes the note tables this database no longer serves.
--
-- Every account's notes are read and written in its own object from this deploy on (see
-- apps/api/src/store/), and the rows here are only what each object copies from on its
-- first wake. That copy is verified by row count, and it trusts the tables not to change
-- underneath it. Nothing in the new Worker writes them — but during a deploy the old
-- isolates drain for a while, and an old isolate would write here as it always had. An
-- update made after its table was copied would be lost without anyone noticing; an insert
-- would fail the copy's count check. "Deploy at a quiet time" narrows that window. These
-- triggers close it: a late write fails, loudly, with a message that says why, instead of
-- disappearing.
--
-- Inserts and updates only. Deletes stay allowed, for one reason: `user` cascades into
-- these tables, and account deletion — and the test fixtures' purge — deletes user rows.
-- A trigger that refused those would refuse the deletion. A late delete from an old
-- isolate is also the one write the copy survives: it trashes nothing (trash is an update)
-- and the copy would find the row gone and count it that way. The `note_counts` and
-- FTS triggers on these tables still fire on a delete and keep those shadows consistent,
-- which does not matter, since nothing reads them.
--
-- Applied before the new Worker goes out, as every migration is, so for the length of the
-- deploy itself a write from an old isolate is refused rather than accepted: an error the
-- person sees and can retry a minute later against the new Worker, in place of a silent
-- loss. The triggers go with the tables, in the migration that drops them.
CREATE TRIGGER notebooks_frozen_insert BEFORE INSERT ON notebooks
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
CREATE TRIGGER notebooks_frozen_update BEFORE UPDATE ON notebooks
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

CREATE TRIGGER notebook_fields_frozen_insert BEFORE INSERT ON notebook_fields
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
CREATE TRIGGER notebook_fields_frozen_update BEFORE UPDATE ON notebook_fields
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

CREATE TRIGGER tags_frozen_insert BEFORE INSERT ON tags
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
CREATE TRIGGER tags_frozen_update BEFORE UPDATE ON tags
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

CREATE TRIGGER notes_frozen_insert BEFORE INSERT ON notes
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
CREATE TRIGGER notes_frozen_update BEFORE UPDATE ON notes
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

CREATE TRIGGER note_tags_frozen_insert BEFORE INSERT ON note_tags
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
CREATE TRIGGER note_tags_frozen_update BEFORE UPDATE ON note_tags
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

CREATE TRIGGER note_fields_frozen_insert BEFORE INSERT ON note_fields
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
CREATE TRIGGER note_fields_frozen_update BEFORE UPDATE ON note_fields
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

CREATE TRIGGER attachments_frozen_insert BEFORE INSERT ON attachments
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
CREATE TRIGGER attachments_frozen_update BEFORE UPDATE ON attachments
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

CREATE TRIGGER attachment_text_frozen_insert BEFORE INSERT ON attachment_text
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
CREATE TRIGGER attachment_text_frozen_update BEFORE UPDATE ON attachment_text
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
