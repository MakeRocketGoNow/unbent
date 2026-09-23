-- Indexes for the two note-list sorts that had none: title and date created.
--
-- The list is paged fifty at a time, and a page is only cheap when an index hands the rows
-- over already in order, so the query can stop at the fiftieth. `updated` has had that since
-- 0003. Title and created did not, so every page under them sorted the whole archive first,
-- and before sorting it built each row's tags, fields and attachments too. On an archive of
-- thirteen thousand notes one page read close to forty thousand rows, and D1 bills rows read.
-- With these it reads a couple of hundred.
--
-- Two per sort, and neither pair can drop its per-notebook half. With only the account-wide
-- index, the planner used it inside a notebook too, because it avoids the sort, and walked
-- the entire archive in title order looking for that notebook's thirty notes: a small
-- notebook went from about a hundred rows read to about thirteen thousand. The per-notebook
-- index starts with the notebook, so it is both the filter and the order.
--
-- `id` is the last column because it is the list's tie-break (`ORDER BY title, id`). An
-- index that stopped at the title would leave equal titles to be sorted apart, and an
-- imported archive has thousands of scans with the same placeholder title.
--
-- The cost is on writes. `created_at` never changes after insert, and `title` only when
-- someone renames a note, so autosaving a body touches neither. Trashing and restoring
-- do move `deleted_at`, which every notes index already carries.
CREATE INDEX idx_notes_user_title
  ON notes(user_id, deleted_at, title COLLATE NOCASE, id);
CREATE INDEX idx_notes_user_created
  ON notes(user_id, deleted_at, created_at, id);
CREATE INDEX idx_notes_user_notebook_title
  ON notes(user_id, notebook_id, deleted_at, title COLLATE NOCASE, id);
CREATE INDEX idx_notes_user_notebook_created
  ON notes(user_id, notebook_id, deleted_at, created_at, id);
