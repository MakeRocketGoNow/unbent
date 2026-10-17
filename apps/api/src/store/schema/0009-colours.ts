/**
 * A colour on every tag and on every select option, kept rather than hashed.
 *
 * The web app used to give a tag or an option its tint from a hash of the word, which
 * stored nothing and so needed nothing here. `colors.ts` in `@unbent/shared` says why
 * that went (six hues colliding over dozens of tags, no way for Yes to be green, the head
 * and the list disagreeing). Notion's model replaces it: a colour is assigned when the
 * word is made and kept with it, so it has to live on the row.
 *
 * `tags.color` is an index into the palette, nullable because a column added to a table
 * in use has to be; every row holds one from the statement below on, and `ensureTag`
 * gives every new row one. `notebook_fields.option_colors` is a JSON object from option
 * to index, beside the `options` list rather than inside it, so the list keeps the shape
 * every filter, value and export reads: `{"Bike": 3, "Toys": 5}`. NULL where `options`
 * is, which is every field that is not a select.
 *
 * Existing rows are coloured here, once, by the rule a new one is coloured by: the
 * colour fewest siblings wear, lowest index among ties, taken in creation order. Over a
 * set with no colours yet that rule is simply the palette in order, repeating, so it is
 * one window function over the tags (rowid is creation order) and one `json_each` over
 * each field's options (the array index is the option's order). The ten here is
 * `TAG_COLOR_COUNT`, written out because a schema file is SQL; a palette that grows
 * changes the constant and leaves this file, which has run, alone.
 *
 * The feed hears of it as 0006-tags-nocase taught: a row per tag and one per notebook
 * whose fields carry options, numbered from `_meta.seq` through a staging table whose
 * rowid counts them, so a device holding the library learns the colours on its next
 * pull rather than drawing every chip grey until each tag happens to be written again.
 * A store with no tags and no selects stages nothing and moves no counter.
 */
export default `
ALTER TABLE tags ADD COLUMN color INTEGER;
ALTER TABLE notebook_fields ADD COLUMN option_colors TEXT;

UPDATE tags
   SET color = r.c
  FROM (SELECT id, (row_number() OVER (ORDER BY rowid) - 1) % 10 AS c FROM tags) AS r
 WHERE r.id = tags.id;

UPDATE notebook_fields
   SET option_colors = (SELECT json_group_object(value, key % 10) FROM json_each(notebook_fields.options))
 WHERE options IS NOT NULL;

CREATE TABLE _colour_changes (
  n       INTEGER PRIMARY KEY,
  entity  TEXT NOT NULL,
  id      TEXT NOT NULL
);
INSERT INTO _colour_changes (entity, id)
  SELECT 'tag', id FROM tags
  UNION ALL
  SELECT DISTINCT 'notebook', notebook_id FROM notebook_fields
   WHERE options IS NOT NULL AND deleted_at IS NULL;

INSERT OR IGNORE INTO _meta (key, value) VALUES ('seq', '0');
INSERT INTO changes (seq, entity, id, deleted, at)
  SELECT (SELECT CAST(value AS INTEGER) FROM _meta WHERE key = 'seq') + n,
         entity, id, 0,
         CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    FROM _colour_changes;
UPDATE _meta
   SET value = CAST(CAST(value AS INTEGER) + (SELECT COUNT(*) FROM _colour_changes) AS TEXT)
 WHERE key = 'seq' AND EXISTS (SELECT 1 FROM _colour_changes);

DROP TABLE _colour_changes;
`;
