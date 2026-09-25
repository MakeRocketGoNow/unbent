-- Indexes a sort by a custom field can page from.
--
-- 0014 laid down (field_id, value_num) and (field_id, value_text) for this, but neither
-- could hand a page over in order. The list breaks ties on the note's id, which neither
-- carried, and text sorts COLLATE NOCASE, which a binary index cannot answer. So every
-- page sorted by a field read every note in scope and every one of their values, then
-- sorted them all to keep fifty — about two rows read per note in the notebook, on every
-- page and every refetch after a save, however deep. Measured on a 13k-note copy, a page
-- of a 770-note notebook read ~2.4k rows where the same page by date read ~840.
--
-- With the id and the collation in the index, the list walks one field's values already
-- in order and stops at the fiftieth, checking each value's note as it goes: ~100 rows to
-- choose a page at any depth. See `pageRows` for the query that walks them.
--
-- These replace 0014's rather than sit beside them. Everything else that reads values by
-- field — deleting a field's values, counting them, converting them to a new type — needs
-- only the `field_id` prefix, which these keep, and a third and fourth index on this table
-- would be written on every value save for no read that wants them.
DROP INDEX IF EXISTS idx_note_fields_field_num;
DROP INDEX IF EXISTS idx_note_fields_field_text;

CREATE INDEX idx_note_fields_sort_num
  ON note_fields(field_id, value_num, note_id);
CREATE INDEX idx_note_fields_sort_text
  ON note_fields(field_id, value_text COLLATE NOCASE, note_id);
