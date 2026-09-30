-- Drops the shared note tables. Every account's notes have lived in its own store since
-- the cutover (src/store/, README "Where your notes live"), copied out of these tables
-- and verified row for row; nothing has read or written them since, and the freeze
-- triggers 0032 put on them have refused every attempt. What remains here is the control
-- plane: Better Auth's tables, OAuth and MCP clients, upload grants, the account directory.
--
-- Guarded. The first statements refuse to run while any account that has rows here is
-- not recorded as copied: `account_directory.copied_at` is written only when a copy
-- verified (0033), so a database where the sweep has not finished, or a fork that ran the
-- cutover Worker for a minute and then deployed this, fails on the CHECK below rather than
-- losing rows nobody copied. The guard is SQL rather than a step in the deploy workflow so
-- it holds wherever migrations run — production, the dev instance, a fork's instance —
-- and an account with rows but no directory row counts as not copied, since the LEFT JOIN
-- finds it with a null. An account is one that owns a note, a notebook or a tag: every
-- other table hangs off those three by foreign key, so an account with only an empty
-- notebook and its field definitions is counted too (found in review). Idempotent around
-- a failed attempt: the guard table is created if missing and emptied before it is filled.
CREATE TABLE IF NOT EXISTS _drop_guard (uncopied INTEGER NOT NULL CHECK (uncopied = 0));
DELETE FROM _drop_guard;
INSERT INTO _drop_guard (uncopied)
  SELECT COUNT(*) FROM (
    SELECT user_id FROM notes UNION SELECT user_id FROM notebooks UNION SELECT user_id FROM tags
  ) n
    LEFT JOIN account_directory d ON d.user_id = n.user_id
   WHERE d.copied_at IS NULL;
DROP TABLE _drop_guard;

-- Children before parents: foreign keys are enforced, and a parent cannot go while rows
-- point at it. Each table takes its triggers (the freeze, the counts, the search index
-- upkeep) and its indexes (the copy's included) with it; each FTS5 table takes its shadow
-- tables. `_unbent_meta` stays: the sweep keeps its cursor there. The directory's
-- `migrated_at` and `copied_at` stay as the record of when each account was frozen and
-- copied.
DROP TABLE attachment_text;
DROP TABLE note_fields;
DROP TABLE note_tags;
DROP TABLE attachments;
DROP TABLE notebook_fields;
DROP TABLE notes;
DROP TABLE tags;
DROP TABLE notebooks;
DROP TABLE note_counts;
DROP TABLE notes_fts;
DROP TABLE tags_fts;
DROP TABLE note_fields_fts;
DROP TABLE attachment_text_fts;
