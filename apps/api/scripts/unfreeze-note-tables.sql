-- Unfreezes the shared note tables: the first step of rolling the per-account store back.
-- Also drops the copy's indexes (0034/0035), so a reverted Worker's plans are exactly what
-- they were before the cutover.
--
-- Migration 0032 refuses inserts and updates to these tables for any account whose store
-- holds its notes (`account_directory.migrated_at` set). A Worker rolled back to before the
-- cutover writes its notes here again, and would be refused on every save for every
-- account that had migrated. So a rollback is three steps, in this order:
--
--   1. Dump each account's store (`GET /api/admin/store/dump?user=<id>`, as an operator),
--      because the rows here are frozen at the cutover and anything written since lives
--      only in the object.
--   2. Apply this file: `wrangler d1 execute unbent --remote --env "" --file scripts/unfreeze-note-tables.sql`
--      (`unbent-dev --env dev` for the dev instance).
--   3. Revert and deploy.
--
-- Not a migration, deliberately: wrangler would apply a file under migrations/ to every
-- database on its next deploy, and this must only ever run by hand, before a revert.
DROP TRIGGER IF EXISTS notebooks_frozen_insert;
DROP TRIGGER IF EXISTS notebooks_frozen_update;
DROP TRIGGER IF EXISTS notebook_fields_frozen_insert;
DROP TRIGGER IF EXISTS notebook_fields_frozen_update;
DROP TRIGGER IF EXISTS tags_frozen_insert;
DROP TRIGGER IF EXISTS tags_frozen_update;
DROP TRIGGER IF EXISTS notes_frozen_insert;
DROP TRIGGER IF EXISTS notes_frozen_update;
DROP TRIGGER IF EXISTS note_tags_frozen_insert;
DROP TRIGGER IF EXISTS note_tags_frozen_update;
DROP TRIGGER IF EXISTS note_fields_frozen_insert;
DROP TRIGGER IF EXISTS note_fields_frozen_update;
DROP TRIGGER IF EXISTS attachments_frozen_insert;
DROP TRIGGER IF EXISTS attachments_frozen_update;
DROP TRIGGER IF EXISTS attachment_text_frozen_insert;
DROP TRIGGER IF EXISTS attachment_text_frozen_update;

DROP INDEX IF EXISTS idx_notes_copy;
DROP INDEX IF EXISTS idx_notebooks_copy;
DROP INDEX IF EXISTS idx_tags_copy;
DROP INDEX IF EXISTS idx_notebook_fields_copy;
DROP INDEX IF EXISTS idx_note_fields_copy;
DROP INDEX IF EXISTS idx_attachments_copy;
