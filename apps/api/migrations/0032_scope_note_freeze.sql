-- Freezes each account's note rows once that account's store holds them — and not before.
--
-- 0031 froze the eight tables outright, and that was wrong twice over. A `user` delete is
-- not only deletes underneath: `notes.notebook_id … ON DELETE SET NULL` updates notes,
-- `notes_counts_bd` updates notebooks and note_counts, and `attachment_text_has_text_ad`
-- updates attachments, and the update triggers refused all three — so any account with a
-- filed note or a read file could no longer be deleted, after its files and its store were
-- already gone. And the freeze applied to every account the moment the migration ran,
-- which on the shared dev database, where a pull request's preview applies migrations
-- before the pull request merges, stopped the dev instance saving notes while it still
-- ran the old code. Both found in review (2026-09-30); the dev database had 0031's
-- triggers dropped by hand and this file recreates them in the shape below.
--
-- The right rule is per account and per moment: an account's D1 rows are frozen from the
-- moment its object's copy is verified, which is when `account_directory.migrated_at` is
-- written (by the copy itself, and by the sweep). Before that, D1 is still the account's
-- truth, and nothing may refuse a write to it; after, a write there would be lost. So each
-- trigger fires only for a row whose account is migrated. And only while the account's
-- `user` row exists: by the time a `user` delete cascades into these tables the row is
-- already gone, which is what lets the cascade's own updates through, and a deleted
-- account has nothing left to protect. `note_tags` carries no `user_id`; it reaches both
-- facts through its note.
--
-- Every trigger is dropped `IF EXISTS` and recreated, so this file is right whether 0031's
-- triggers are still there or were removed by hand. They go with the tables, in the
-- migration that drops them. Rolling the cutover back needs them gone first: see
-- scripts/unfreeze-note-tables.sql.
DROP TRIGGER IF EXISTS notebooks_frozen_insert;
CREATE TRIGGER notebooks_frozen_insert BEFORE INSERT ON notebooks
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = NEW.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
DROP TRIGGER IF EXISTS notebooks_frozen_update;
CREATE TRIGGER notebooks_frozen_update BEFORE UPDATE ON notebooks
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = OLD.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

DROP TRIGGER IF EXISTS notebook_fields_frozen_insert;
CREATE TRIGGER notebook_fields_frozen_insert BEFORE INSERT ON notebook_fields
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = NEW.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
DROP TRIGGER IF EXISTS notebook_fields_frozen_update;
CREATE TRIGGER notebook_fields_frozen_update BEFORE UPDATE ON notebook_fields
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = OLD.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

DROP TRIGGER IF EXISTS tags_frozen_insert;
CREATE TRIGGER tags_frozen_insert BEFORE INSERT ON tags
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = NEW.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
DROP TRIGGER IF EXISTS tags_frozen_update;
CREATE TRIGGER tags_frozen_update BEFORE UPDATE ON tags
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = OLD.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

DROP TRIGGER IF EXISTS notes_frozen_insert;
CREATE TRIGGER notes_frozen_insert BEFORE INSERT ON notes
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = NEW.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
DROP TRIGGER IF EXISTS notes_frozen_update;
CREATE TRIGGER notes_frozen_update BEFORE UPDATE ON notes
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = OLD.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

DROP TRIGGER IF EXISTS note_fields_frozen_insert;
CREATE TRIGGER note_fields_frozen_insert BEFORE INSERT ON note_fields
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = NEW.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
DROP TRIGGER IF EXISTS note_fields_frozen_update;
CREATE TRIGGER note_fields_frozen_update BEFORE UPDATE ON note_fields
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = OLD.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

DROP TRIGGER IF EXISTS attachments_frozen_insert;
CREATE TRIGGER attachments_frozen_insert BEFORE INSERT ON attachments
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = NEW.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
DROP TRIGGER IF EXISTS attachments_frozen_update;
CREATE TRIGGER attachments_frozen_update BEFORE UPDATE ON attachments
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = OLD.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

DROP TRIGGER IF EXISTS attachment_text_frozen_insert;
CREATE TRIGGER attachment_text_frozen_insert BEFORE INSERT ON attachment_text
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = NEW.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
DROP TRIGGER IF EXISTS attachment_text_frozen_update;
CREATE TRIGGER attachment_text_frozen_update BEFORE UPDATE ON attachment_text
WHEN EXISTS (SELECT 1 FROM account_directory WHERE user_id = OLD.user_id AND migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM user WHERE id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;

DROP TRIGGER IF EXISTS note_tags_frozen_insert;
CREATE TRIGGER note_tags_frozen_insert BEFORE INSERT ON note_tags
WHEN EXISTS (SELECT 1 FROM notes n JOIN account_directory d ON d.user_id = n.user_id
              WHERE n.id = NEW.note_id AND d.migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM notes n JOIN user u ON u.id = n.user_id WHERE n.id = NEW.note_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
DROP TRIGGER IF EXISTS note_tags_frozen_update;
CREATE TRIGGER note_tags_frozen_update BEFORE UPDATE ON note_tags
WHEN EXISTS (SELECT 1 FROM notes n JOIN account_directory d ON d.user_id = n.user_id
              WHERE n.id = OLD.note_id AND d.migrated_at IS NOT NULL)
 AND EXISTS (SELECT 1 FROM notes n JOIN user u ON u.id = n.user_id WHERE n.id = OLD.note_id)
BEGIN SELECT RAISE(ABORT, 'notes moved to the per-account store'); END;
