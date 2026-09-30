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

/**
 * What a dump carries: the data tables, the account totals (`note_counts` is one row the
 * triggers keep, and the dump writes its rows before its triggers, so it has to travel as
 * a row), and the object's own two, so a file rebuilt from it says which schema files it
 * is at and whose it is. None of the three extras is counted as data.
 */
export const DUMP_TABLES = ['_migrations', '_meta', 'note_counts', ...DATA_TABLES] as const;
export type DumpTable = (typeof DUMP_TABLES)[number];
