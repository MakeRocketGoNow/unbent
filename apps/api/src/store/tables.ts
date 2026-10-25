/**
 * The data tables of a per-account store, in dependency order: what `dumpSlice` reads,
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
  /*
   * A notebook's saved views (0010). Right after the notebooks because a view names one,
   * and a dump loads in this order; counted and dumped as any data table is, since they
   * are the person's own arrangement of their library and a store rebuilt without them
   * would lose every one.
   */
  'notebook_views',
  'notebook_fields',
  'tags',
  'notes',
  'note_tags',
  'note_fields',
  'attachments',
  'attachment_text',
  /*
   * Note history (0003). Counted so `stats` shows what the safety net costs an account,
   * and dumped with everything else: the dump is how a schema file is rehearsed against
   * a real account, and one that left this table empty would rehearse a change to it
   * against no rows. Leaving it out was tried, for the dump's call budget and to keep
   * removed text off an operator's disk, and taken back. An archive's dump is about a
   * dozen store calls of the fifty allowed, so history would have to reach hundreds of
   * megabytes to matter, and the file already holds every note the account has.
   */
  'note_revisions',
  /*
   * The change feed (0002). Not note data, but counted and dumped with it: `stats`
   * showing how long an account's feed is says whether retention is doing its job, and a
   * dump that rebuilds a store must rebuild the feed too or every client of it would
   * resync from nothing. Last because it references nothing and nothing references it.
   */
  'changes',
  /*
   * Files let go of but not yet deleted from R2 (0005). Counted so `stats` shows how many
   * objects an account is still paying for after a purge, and dumped because a store
   * rebuilt from a dump has to know which files it still owes a deletion: left out, every
   * file deleted before the dump would sit in the bucket as an orphan the hourly sweep
   * never asks about. References nothing, like `changes`.
   */
  'deleted_blobs',
  /*
   * What the language model has cost the account, by day (0007). Counted so `stats`
   * shows it, and dumped because it is the account's record of what it has spent: a
   * store rebuilt from a dump without it would start the year, and the day's cap, again.
   * As of the account's last dump, though: a write here does not move the feed's mark,
   * which is what tells the daily dump an account changed, so presses that read no file
   * may reach a dump only with the weekly refresh. A restore can therefore lose up to a
   * week of counts, and gives back that much of the day's cap. Moving the mark for them
   * would dump an account for every press; a count is not worth that. References nothing.
   */
  'llm_usage',
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
