/**
 * Saved views (MAK-249): a notebook's list the way someone left it, under a name.
 *
 * What a view is, and why it is per notebook and what it leaves out, is said once in
 * `views.ts` in `@unbent/shared`; this is where the account keeps them. A row per view,
 * its query as the JSON of a `ViewQuery` (tags by name, field filters in the address's
 * own spelling, the sort, the dates, the layout), read and written whole: nothing here
 * filters by what a query holds, and a view's query only ever changes as one value, so
 * a column per key would be a migration for every key the address gains.
 *
 * `notebook_id` is nullable on purpose, and nothing writes a null yet (the route refuses
 * one). A view over the whole library may come later, and a column that could not be
 * null would make that a table rebuilt in every store rather than a route allowed to send
 * it. The cascade is real, since foreign keys are on in every store (the object checks
 * on each wake), so a notebook's delete would take its views; `NotesStore.deleteNotebook`
 * deletes them itself first, for their ids, because the feed has to carry a tombstone
 * for each and a cascade tells nobody what it removed.
 *
 * `position` is the view's place among its notebook's views, dense from zero, as
 * `notebook_fields` keeps a notebook's fields; a move rewrites the others so it stays
 * dense. The index leads with the notebook because every read but the feed's is "this
 * notebook's views, in order", and the feed's is by primary key.
 *
 * Names are unique within a notebook without case, as notebooks', tags' and fields' are:
 * two views that differ only in case would be two rows the rail could not tell apart.
 * The constraint is the check, so the store tells a taken name from its conflict rather
 * than reading first. It holds only where `notebook_id` is set: SQLite counts every NULL
 * as distinct in a UNIQUE, so the library views that may come later will need a check of
 * their own (a partial unique index, added then) rather than finding this one does it.
 *
 * Hard delete, no `deleted_at`. Nothing refers to a view (a note does not know which
 * views would show it), so there is nothing a tombstone row would keep readable; the
 * feed's tombstone is how a device learns it went.
 */
export default `
CREATE TABLE notebook_views (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT REFERENCES notebooks(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  query       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(notebook_id, name COLLATE NOCASE)
);
CREATE INDEX idx_notebook_views_notebook ON notebook_views(notebook_id, position);
`;
