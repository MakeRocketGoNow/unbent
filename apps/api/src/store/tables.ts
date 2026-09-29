/**
 * The data tables of a per-account store, in dependency order: what `dumpPage` pages,
 * `stats` counts, and the copy from D1 fills. A module of its own, with no import of
 * `cloudflare:workers`, so the Worker's routes can name the tables without pulling the
 * object class into a module graph the Node-run unit tests reach.
 *
 * The FTS tables are deliberately not here. They shadow these by rowid and are rebuilt
 * from them by their triggers; dumping or counting them would say nothing the data
 * tables do not.
 */
export const DATA_TABLES = [
  'notebooks',
  'notebook_fields',
  'tags',
  'notes',
  'note_tags',
  'note_fields',
  'attachments',
  'attachment_text',
] as const;
export type DataTable = (typeof DATA_TABLES)[number];
