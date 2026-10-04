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
  /*
   * Note history (0003). Counted so `stats` shows what the safety net costs an account,
   * and not dumped; see `DUMP_TABLES`.
   */
  'note_revisions',
  /*
   * The change feed (0002). Not note data, but counted and dumped with it: `stats`
   * showing how long an account's feed is says whether retention is doing its job, and a
   * dump that rebuilds a store must rebuild the feed too or every client of it would
   * resync from nothing. Last because it references nothing and nothing references it.
   */
  'changes',
] as const;
export type DataTable = (typeof DATA_TABLES)[number];

/**
 * What a dump carries: the data tables, the account totals (`note_counts` is one row the
 * triggers keep, and the dump writes its rows before its triggers, so it has to travel as
 * a row), and the object's own two, so a file rebuilt from it says which schema files it
 * is at and whose it is. None of the three extras is counted as data.
 *
 * Note history is left out, and its table is rebuilt empty. A dump is what an account is
 * rebuilt from, and history is a safety net for a recent edit rather than part of the
 * account — the export leaves it out on the same grounds. It is also the one table that
 * can outgrow the notes themselves, at up to twenty bodies a note, inside a route whose
 * every page is a store call against the fifty an invocation is allowed. And it holds
 * text its owner removed from a note, which has no business in a file on an operator's
 * disk.
 */
const NOT_DUMPED = ['note_revisions'] as const;
type DumpedDataTable = Exclude<DataTable, (typeof NOT_DUMPED)[number]>;
export const DUMP_TABLES = [
  '_migrations',
  '_meta',
  'note_counts',
  ...DATA_TABLES.filter((t): t is DumpedDataTable => !(NOT_DUMPED as readonly string[]).includes(t)),
] as const;
export type DumpTable = (typeof DUMP_TABLES)[number];
