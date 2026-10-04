import {
  encodeFieldValue,
  excerptMarkdown,
  expectedFieldValue,
  fieldHasOptions,
  fieldOptionsSchema,
  inferFieldType,
  InvalidFieldValue,
  withHeldOptions,
  isReservedFieldName,
  MAX_FIELDS_PER_NOTEBOOK,
  MAX_SELECT_OPTIONS,
  planConversion,
  fitRatingScale,
  UNFILED,
  type FieldDef,
  type FieldFilter,
  type FieldScale,
  type FieldType,
  type FieldValue,
  type FeedNote,
  type FeedNotebook,
  type FeedTag,
  type Note,
  type NoteFieldsPatch,
  type NoteRevision,
  type NoteRevisionChange,
  type NoteRevisionProps,
  type NoteRevisionSummary,
  type RevisionSkip,
  type RestoredNote,
  type NoteSort,
  type NoteSummary,
  type NotebookDefinition,
  type NotebookSummary,
  type SearchResult,
  type StaleNote,
  DEFAULT_NOTE_SORT,
} from '@unbent/shared';
import type { Change, Feed } from './feed.js';
import { Revisions } from './revisions.js';
import type { Bind, Sql } from './sql.js';
import {
  ATTACHMENTS_SUBQUERY,
  FIELDS_SUBQUERY,
  PURGE_PAGE,
  SCOPE_DRIVEN_SEARCH_MAX,
  SEARCH_OVERFETCH,
  SORTS,
  TRASH_SORT,
  currencyColumn,
  decodeAttachmentsJson,
  decodeCursor,
  decodeFieldsJson,
  fieldSort,
  filterConditions,
  isJsonArray,
  keysOfDeletedNotes,
  liveCondition,
  optionsColumn,
  placeholders,
  rowToField,
  runs,
  sameFieldText,
  sameTagSet,
  scaleColumns,
  scaleTightens,
  scopeDrivenSearchSql,
  splitTags,
  tierColumns,
  tierRankMatch,
  toFtsQuery,
  toSearchResult,
  uniqueTags,
  type ExportedNote,
  type FieldRow,
  type NoteRow,
  type SearchRow,
  type SummaryRow,
} from './notes-shared.js';

/** What `list`, `listFull` and the composites built on them take. */
export interface ListOptions {
  limit: number;
  cursor?: string | undefined;
  tags?: string[] | undefined;
  notebook?: string | undefined;
  fields?: FieldFilter[] | undefined;
  /** Only notes with no tag at all; see `filterConditions`. */
  untagged?: boolean | undefined;
  /**
   * Rows without their body, field values or files: what a caller that only wants to
   * know which notes these are, and where each is filed, would throw away. See
   * `summaryRows`.
   */
  compact?: boolean | undefined;
  sort?: NoteSort | undefined;
  order?: 'asc' | 'desc' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** List trashed notes instead of live ones. */
  trashed?: boolean | undefined;
  /**
   * Order by this field's value instead of `sort`. The resolved definition rather than
   * an id, so the SQL is built knowing the type — the same reason `filterConditions`
   * takes definitions. Ignored for the trash.
   */
  sortField?: FieldDef | undefined;
}

export interface CountOptions {
  tags?: string[] | undefined;
  notebook?: string | undefined;
  fields?: FieldFilter[] | undefined;
  /** Only notes with no tag at all; see `filterConditions`. */
  untagged?: boolean | undefined;
  trashed?: boolean | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sort?: NoteSort | undefined;
  /** Sorting by a field, which decides the column a date range reads; see `fieldSort`. */
  sortField?: FieldDef | undefined;
  exact?: boolean | undefined;
}

export interface SearchFilters {
  tags?: string[] | undefined;
  notebook?: string | undefined;
  fields?: FieldFilter[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** A statement built now and run later, inside the transaction of the method that built it. */
type Statement = [sql: string, binds: Bind[]];

/**
 * All note access for one account, inside that account's own SQLite.
 *
 * This is `NotesRepo` moved onto the per-user store: the same methods, the same SQL, with
 * three things different because the database is the user's alone.
 *
 * There is no `user_id`. Not on any table, not in any predicate, not as a bind. On the
 * shared database every method injected it and every index led with it, and the whole
 * `+user_id` discipline existed because one user owned nearly every row. Here a lookup by
 * primary key is a lookup by primary key. Isolation is the object's: a request reaches
 * this class only through the stub for its own user, and the object refuses a database
 * whose `_meta.user_id` is not its name.
 *
 * Everything is synchronous. `ctx.storage.sql` runs in-process, so a method that made
 * five round trips to D1 makes five local calls, and what D1 called a `batch` is a real
 * transaction: `tx()` at the boundary of every public method that writes, rolled back
 * whole if anything inside throws. Public methods call one another — `create` reads back
 * through `get`, `duplicate` writes through `create` — and the runtime nests those
 * transactions with savepoint semantics, so the outermost one commits once. Private
 * helpers never open one.
 *
 * Foreign keys are enforced, so a note's children go with it. The explicit deletes the
 * shared-database code wrote by hand — because D1 promised nothing about cascades — are
 * kept where they carry meaning (a BEFORE DELETE trigger needs `note_tags` gone while the
 * note is readable; see the schema), and left out where the cascade is the whole story.
 *
 * Bodies never cross the object boundary in a list: `list` computes each row's excerpt
 * here, so a page of fifty notes is fifty excerpts on the wire. `listFull` is the export's
 * and returns bodies on purpose; its caller pages by bytes.
 */
/** A note as `wholeNotes` reads it: a `FeedNote` without its files, which the object adds. */
export type WholeNote = Omit<FeedNote, 'files'>;

export class NotesStore {
  constructor(
    private readonly sql: Sql,
    private readonly feed: Feed,
  ) {
    this.revisions = new Revisions(sql);
  }

  /** The copies kept of what a write replaced; see `Revisions.keep`. */
  private readonly revisions: Revisions;

  /**
   * A page of notes, ordered by the requested sort. Keyset pagination keeps deep pages
   * cheap: each page resumes from the last row's sort key rather than counting past
   * everything before it.
   */
  list(opts: ListOptions): NoteSummary[] {
    return this.pageRows(opts).map(toSummary);
  }

  /**
   * The list's rows for a handful of notes named by id, in the order named — the rows a
   * search found, drawn as a table's. Live notes only; an id that is not one is left out.
   *
   * The same outer select as a page, so a row here is exactly the row the list would draw
   * for that note. By primary key, in runs under the bind cap: a search's page is at most
   * a hundred ids, so this reads those notes and their tags, fields and files, and nothing
   * else.
   */
  summariesFor(ids: string[]): NoteSummary[] {
    const byId = new Map<string, NoteSummary>();
    for (const run of runs([...new Set(ids)])) {
      const page = `SELECT n.id, n.title, n.body, n.created_at, n.updated_at, n.deleted_at, n.notebook_id,
                           NULL AS sort_key
                      FROM notes n
                     WHERE n.id IN (${run.map((_, i) => `?${i + 1}`).join(', ')})
                       AND +n.deleted_at IS NULL`;
      for (const r of this.summaryRows(page, run, 'n.id')) byId.set(r.id, toSummary(r));
    }
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /**
   * Whole notes by id, trashed ones included, in no particular order: what the change feed
   * and the snapshot carry. The body, the tags, the values and the notebook's name, as
   * `get` returns them, read in runs under the bind cap with the same correlated
   * subqueries a list page uses — about eight rows per note with its tags, values and
   * files (measured 2026-10-02). An id that is not a note is left out; a trashed one
   * carries `deletedAt`, since the trash is part of the copy a client keeps.
   */
  wholeNotes(ids: string[]): WholeNote[] {
    const notes: WholeNote[] = [];
    for (const run of runs([...new Set(ids)])) {
      const page = `SELECT n.id, n.title, n.body, n.created_at, n.updated_at, n.deleted_at, n.notebook_id,
                           NULL AS sort_key
                      FROM notes n
                     WHERE n.id IN (${placeholders(1, run.length)})`;
      // Tags by id, for the feed's `tagIds`: the join rows alone, no names (see
      // `FeedNote` for why none are carried); the page query is asked to leave its name
      // subquery out too.
      const tagsOf = new Map<string, string[]>();
      for (const t of this.sql.exec<{ note_id: string; tag_id: string }>(
        `SELECT note_id, tag_id FROM note_tags WHERE note_id IN (${placeholders(1, run.length)}) ORDER BY note_id, tag_id`,
        ...run,
      )) {
        tagsOf.get(t.note_id)?.push(t.tag_id) ?? tagsOf.set(t.note_id, [t.tag_id]);
      }
      for (const r of this.summaryRows(page, run, 'n.id', { tags: false })) {
        const fields = decodeFieldsJson(r.fields, r.notebook_id);
        notes.push({
          id: r.id,
          title: r.title,
          body: r.body,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          tagIds: tagsOf.get(r.id) ?? [],
          notebookId: r.notebook_id,
          ...(fields.length > 0 ? { fields } : {}),
          ...(r.deleted_at !== null ? { deletedAt: r.deleted_at } : {}),
        });
      }
    }
    return notes;
  }

  /**
   * How many bytes each note's body holds, by id, trashed included: what the feed cuts a
   * page on before it loads anything. Bytes, not characters: `octet_length` counts the
   * UTF-8 the body is stored as, where `length` would count characters and undercount
   * non-Latin text by up to three times against the RPC ceiling the cut protects.
   */
  bodyBytes(ids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const run of runs([...new Set(ids)])) {
      for (const r of this.sql.exec<{ id: string; bytes: number }>(
        `SELECT id, octet_length(body) AS bytes FROM notes WHERE id IN (${placeholders(1, run.length)})`,
        ...run,
      )) {
        out.set(r.id, r.bytes);
      }
    }
    return out;
  }

  /**
   * The next `limit` note ids after `cursor` in id order, trashed included: the
   * snapshot's walk. Ids are UUIDs, so the order means nothing and costs nothing — the
   * primary key is the index, and a page deep into the walk seeks straight to it.
   */
  idsAfter(cursor: string | null, limit: number): string[] {
    return this.sql
      .exec<{ id: string }>(`SELECT id FROM notes WHERE id > ?1 ORDER BY id LIMIT ?2`, cursor ?? '', limit)
      .map((r) => r.id);
  }

  /** Every note the snapshot's walk will visit: live and trashed, from the stored counts. */
  totalNotes(): number {
    const t = this.totals();
    return t.live + t.trashed;
  }

  /**
   * A page of whole notes — the body rather than an excerpt — with the names of their
   * files, for the browser to write an export from. The same page `list` reads, in one
   * statement, so an export is the note list the person was looking at.
   */
  listFull(opts: ListOptions): ExportedNote[] {
    return this.pageRows(opts).map((r) => {
      const fields = decodeFieldsJson(r.fields, r.notebook_id);
      const attachments = decodeAttachmentsJson(r.attachments);
      return {
        id: r.id,
        title: r.title,
        body: r.body,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        tags: splitTags(r.tags),
        notebook: r.notebook,
        notebookId: r.notebook_id,
        ...(fields.length > 0 ? { fields } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    });
  }

  private pageRows(opts: ListOptions): SummaryRow[] {
    const { limit, cursor, tags, notebook, fields, untagged, trashed, from, to } = opts;
    const sort = opts.sort ?? DEFAULT_NOTE_SORT;
    // Trash has one meaningful order — most recently deleted first — so it ignores both.
    const byField = !trashed && opts.sortField ? opts.sortField : undefined;
    const spec = trashed ? TRASH_SORT : byField ? fieldSort(byField) : SORTS[sort];
    const descending = trashed || (opts.order ?? 'desc') === 'desc';
    const collate = 'collate' in spec && spec.collate ? ` ${spec.collate.trim()}` : '';
    const direction = descending ? 'DESC' : 'ASC';
    const op = descending ? '<' : '>';
    // Titles and field text compare as text; the timestamp and numeric columns must bind as
    // numbers or SQLite compares them as strings, where '9' sorts after '10'.
    const isText = !trashed && 'text' in spec && spec.text === true;

    const binds: Bind[] = [];
    // Bound first, so the page can name it as ?1 whatever else the filters bind later.
    if (byField) binds.push(byField.id);

    const decoded = cursor ? decodeCursor(cursor) : null;
    /**
     * `(key, id) < (?, ?)` spelled out, because SQLite has no row-value comparison in
     * this position: strictly past the boundary key, or on it and past that row's id.
     *
     * With a plain range in front: SQLite cannot seek into an index through the OR when
     * the column carries a collation, so a page deep into the title sort walked every
     * title before it — thousands of rows read for fifty. `key >= K` is one it can seek
     * on, and the OR behind it then only settles the ties.
     */
    const pastCursor = (column: string, idColumn: string): string => {
      if (!decoded) return '';
      binds.push(isText ? decoded.key : Number(decoded.key), decoded.id);
      const keyBind = `?${binds.length - 1}`;
      const idBind = `?${binds.length}`;
      return (
        `${column} ${op}= ${keyBind}` +
        ` AND (${column} ${op} ${keyBind} OR ${idColumn} ${op} ${idBind})`
      );
    };

    const conditions = [liveCondition(trashed, tags)];
    const sortKey = `${spec.column}${collate}`;
    const cursorCondition = !byField && decoded ? pastCursor(sortKey, 'n.id') : '';
    /*
     * A field sort's valueless boundary is recognised before the filters bind, so the
     * cursor's binds keep one order whichever branch reads them. `''` is the marker
     * `fieldSortKey` writes for a row with no value.
     */
    const pastValueless = byField && decoded?.key === '';
    let valuedCursor = '';
    let valuelessCursor = '';
    if (byField && decoded) {
      if (pastValueless) {
        binds.push(decoded.id);
        valuelessCursor = `n.id ${op} ?${binds.length}`;
      } else {
        valuedCursor = pastCursor(sortKey, 'sf.note_id');
      }
    }
    conditions.push(
      // The range applies to the column being sorted, so the filter and the order agree.
      ...filterConditions({ tags, notebook, fields, untagged, from, to, dateColumn: spec.dateColumn }, binds),
    );
    binds.push(limit);
    const limitBind = `?${binds.length}`;

    // A compact page never selects the body, here or in `summaryRows`: the page is
    // materialised when it is sorted, and a body selected here would be carried through
    // the sort to be dropped after it.
    const columns = `n.id, n.title, ${opts.compact ? `''` : 'n.body'} AS body, n.created_at, n.updated_at, n.deleted_at, n.notebook_id`;
    let page: string;
    if (byField) {
      /*
       * Sorted by a field, the page is two ordered runs one after the other: the notes
       * holding a value, in value order, then the notes holding none, by id. That is the
       * order the old single query produced with `(value IS NULL)` leading its ORDER BY,
       * but no index can serve that ORDER BY, so it read every note in scope and every
       * value, then sorted them all to keep fifty — about two rows per note in the
       * notebook, on every page however deep: ~2.4k rows for a page of a 770-note notebook
       * where sorting it by date read ~840.
       *
       * Split, the first run walks 0027's index for the one field — already in order, id
       * tie-break and collation included — checking each value's note against the filters
       * as it goes, and stops at the page's end: ~100 rows at any depth. CROSS JOIN pins
       * that loop order; left to itself the planner could start from the notebook's notes
       * and sort again.
       *
       * The second run is the expensive one — nothing indexes "notes with no value", so it
       * reads the notes in scope — but UNION ALL under a LIMIT runs it only when the first
       * run came up short, which is the last page or two of a long list.
       *
       * A cursor on a valued row pages the first run and starts the second from the top,
       * since every valueless row lies beyond every valued one in both directions. A
       * cursor on a valueless row skips the first run entirely.
       */
      const where = conditions.join(' AND ');
      const valued = `SELECT * FROM (
                 SELECT ${columns}, ${sortKey} AS sort_key
                   FROM note_fields sf CROSS JOIN notes n ON n.id = sf.note_id
                  WHERE sf.field_id = ?1 AND ${spec.column} IS NOT NULL AND ${where}
                        ${valuedCursor ? `AND ${valuedCursor}` : ''}
                  ORDER BY ${sortKey} ${direction}, sf.note_id ${direction}
                  LIMIT ${limitBind})`;
      const valueless = `SELECT * FROM (
                 SELECT ${columns}, NULL AS sort_key
                   FROM notes n
                  WHERE ${where}
                    AND NOT EXISTS (SELECT 1 FROM note_fields sf
                                     WHERE sf.note_id = n.id AND sf.field_id = ?1
                                       AND ${spec.column} IS NOT NULL)
                        ${valuelessCursor ? `AND ${valuelessCursor}` : ''}
                  ORDER BY n.id ${direction}
                  LIMIT ${limitBind})`;
      page = pastValueless ? valueless : `${valued} UNION ALL ${valueless} LIMIT ${limitBind}`;
    } else {
      page = `SELECT ${columns}, ${sortKey} AS sort_key
                FROM notes n
               WHERE ${[...conditions, ...(cursorCondition ? [cursorCondition] : [])].join(' AND ')}
               ORDER BY ${sortKey} ${direction}, n.id ${direction}
               LIMIT ${limitBind}`;
    }

    /*
       The page is chosen in a subquery, and the row's tags, fields and files are looked
       up for the rows chosen. In one query the planner evaluated those three subqueries,
       and the notebook join, for every candidate row before it sorted — every note in a
       tag, every note in a notebook sorted by a field — and rows read are what this store
       is metered on, as D1 was: a page of a 770-note notebook sorted by a field read 11k
       rows, a popular tag's page 4k. Chosen first, the page reads about 4.5k and 2.9k.
       Lists in index order lose nothing (a plain page reads 531 rows where it read 540),
       so every list takes this shape.

       The sort key is selected under one name, with its collation, so the outer ORDER BY
       can name it: SQLite then keeps the subquery's order rather than sorting again, and
       a key without the collation would have cost a second sort on title pages.
    */
    return this.summaryRows(
      page,
      binds,
      `${byField ? '(n.sort_key IS NULL) ASC, ' : ''}n.sort_key ${direction}, n.id ${direction}`,
      { compact: opts.compact },
    );
  }

  /**
   * The rows `page` chose, with their notebook, tags, fields and files; see `pageRows`.
   * `tags: false` leaves the tag names out, for a caller that reads the join rows itself
   * (`wholeNotes` wants ids too) and would otherwise pay for them twice.
   *
   * `compact` leaves out the body, the field values and the files, for a page that is
   * read for its ids, titles, notebooks and tags and nothing else. Such a page is allowed
   * to be five times the size of a full one, and that is what makes it matter here rather
   * than in whoever drops the columns afterwards: five hundred bodies are read into the
   * object to be excerpted and discarded — a body may be 1.8 MB — and the two subqueries
   * are a probe each per note for values nobody is shown.
   */
  private summaryRows(
    page: string,
    binds: Bind[],
    orderBy: string,
    opts: { tags?: boolean; compact?: boolean | undefined } = {},
  ): SummaryRow[] {
    const tags =
      opts.tags === false
        ? 'NULL AS tags'
        : `(SELECT group_concat(t.name, char(31)) FROM note_tags nt
                 JOIN tags t ON t.id = nt.tag_id
                WHERE nt.note_id = n.id) AS tags`;
    return this.sql.exec<SummaryRow>(
      `SELECT n.id, n.title, ${opts.compact ? `''` : 'n.body'} AS body, n.created_at, n.updated_at, n.deleted_at,
              nb.name AS notebook, n.notebook_id,
              ${tags},
              ${opts.compact ? 'NULL AS fields' : FIELDS_SUBQUERY},
              ${opts.compact ? 'NULL AS attachments' : ATTACHMENTS_SUBQUERY}
         FROM (${page}) n
         LEFT JOIN notebooks nb ON nb.id = n.notebook_id
        ORDER BY ${orderBy}`,
      ...binds,
    );
  }

  /**
   * Total live notes, optionally within a notebook and/or some tags.
   *
   * Reported separately from `list` because the list is paginated: counting what a page
   * returned would show "50 notes" for an account holding hundreds.
   *
   * Read from the counts the triggers keep whenever the filter is one of those, and
   * counted from the rows otherwise. `exact` always counts the rows: it is for a
   * confirmation naming how many notes an action will destroy, where a stored count that
   * had drifted would be telling the user something false at the one moment it matters.
   */
  count(opts: CountOptions = {}): number {
    if (!opts.exact) {
      const stored = this.storedCount(opts);
      if (stored !== undefined) return stored;
    }

    const binds: Bind[] = [];
    const conditions = [
      liveCondition(opts.trashed, opts.tags),
      ...filterConditions(
        {
          tags: opts.tags,
          notebook: opts.notebook,
          fields: opts.fields,
          untagged: opts.untagged,
          from: opts.from,
          to: opts.to,
          dateColumn: opts.trashed
            ? TRASH_SORT.dateColumn
            : opts.sortField
              ? fieldSort(opts.sortField).dateColumn
              : SORTS[opts.sort ?? DEFAULT_NOTE_SORT].dateColumn,
        },
        binds,
      ),
    ];

    const row = this.sql.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notes n WHERE ${conditions.join(' AND ')}`,
      ...binds,
    );
    return row?.n ?? 0;
  }

  /**
   * The stored count for a filter that has one, or `undefined` when it has to be counted.
   *
   * Stored are exactly the filters a sidebar entry is: everything, one notebook, Unfiled,
   * one tag, and the trash. Anything narrower — a date range, a field, a tag within a
   * notebook, two tags — is counted, and those count only the notes that match, since the
   * tag and notebook clauses start from the tag or notebook rather than from every note.
   *
   * Names are matched the way `filterConditions` matches them, so a stored count and a
   * counted one can never disagree about which notebook or tag was meant: a notebook
   * case-insensitively, a tag exactly. A name that matches nothing is 0 either way.
   */
  private storedCount(opts: CountOptions): number | undefined {
    const { tags = [], notebook, fields = [], untagged, trashed, from, to } = opts;
    // No stored count is of notes without tags, so it is counted like a field filter is.
    if (from || to || untagged || fields.length > 0 || tags.length > 1) return undefined;
    if (tags.length === 1 && notebook) return undefined;

    if (trashed) return notebook || tags.length > 0 ? undefined : this.totals().trashed;

    if (tags.length === 1) {
      const row = this.sql.first<{ note_count: number }>(`SELECT note_count FROM tags WHERE name = ?1`, tags[0]);
      return row?.note_count ?? 0;
    }
    if (notebook === UNFILED) return this.totals().unfiled;
    if (notebook) {
      const row = this.sql.first<{ note_count: number }>(
        `SELECT note_count FROM notebooks WHERE name = ?1 COLLATE NOCASE`,
        notebook,
      );
      return row?.note_count ?? 0;
    }
    return this.totals().live;
  }

  /** The account-wide counts. No row means no note has ever been stored: all zero. */
  private totals(): { live: number; unfiled: number; trashed: number } {
    return (
      this.sql.first<{ live: number; unfiled: number; trashed: number }>(
        `SELECT live, unfiled, trashed FROM note_counts WHERE id = 1`,
      ) ?? { live: 0, unfiled: 0, trashed: 0 }
    );
  }

  /**
   * Counts every stored count again from the notes and writes back the ones that were
   * wrong, returning how many that was.
   *
   * The way out if a count ever drifts. The triggers should make that impossible, but
   * they can only cover the writes that exist when they were written, and a count that is
   * wrong costs nothing to notice and a full recount to fix. One transaction, so the
   * counts are read and written together and a note saved meanwhile cannot land between.
   *
   * It reads every note, twice over for the notebooks and tags — roughly what the sidebar
   * cost on every load before the counts were stored. Fine for a button; not for a loop.
   */
  recountNotes(): number {
    const liveInNotebook = `(SELECT COUNT(*) FROM notes n
                              WHERE n.notebook_id = notebooks.id AND n.deleted_at IS NULL)`;
    const liveWithTag = `(SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
                           WHERE nt.tag_id = tags.id AND n.deleted_at IS NULL)`;
    const actualTotals = `SELECT COALESCE(SUM(deleted_at IS NULL), 0) AS live,
                                 COALESCE(SUM(deleted_at IS NULL AND notebook_id IS NULL), 0) AS unfiled,
                                 COALESCE(SUM(deleted_at IS NOT NULL), 0) AS trashed
                            FROM notes`;
    type Totals = { live: number; unfiled: number; trashed: number };

    return this.sql.tx(() => {
      const was = this.totals();
      const is = this.sql.first<Totals>(actualTotals)!;
      const notebooks = this.sql.exec<{ id: string }>(
        `UPDATE notebooks SET note_count = ${liveInNotebook}
          WHERE note_count <> ${liveInNotebook}
         RETURNING id`,
      );
      const tags = this.sql.exec<{ id: string }>(
        `UPDATE tags SET note_count = ${liveWithTag}
          WHERE note_count <> ${liveWithTag}
         RETURNING id`,
      );
      // The `WHERE 1` does nothing but let SQLite parse the ON CONFLICT after it as an
      // upsert: straight after a FROM it would be read as the start of a join constraint.
      this.sql.exec(
        `INSERT INTO note_counts (id, live, unfiled, trashed)
         SELECT 1, live, unfiled, trashed FROM (${actualTotals}) WHERE 1
         ON CONFLICT(id) DO UPDATE
           SET live = excluded.live, unfiled = excluded.unfiled, trashed = excluded.trashed`,
      );
      const wrongTotals = (['live', 'unfiled', 'trashed'] as const).filter((k) => was[k] !== is[k]).length;
      return notebooks.length + tags.length + wrongTotals;
    });
  }

  /**
   * One live note, or null.
   *
   * A trashed note reads as missing unless `includeTrashed` asks for it, and then it
   * carries `deletedAt`. Missing is the right default: every caller inside this store
   * reads a note in order to change it, and a write must never reach the trash. Only
   * `GET /notes/:id` passes the flag, because the trash shows a deleted note before
   * anyone decides whether to restore it — and without the flag that view could only
   * ever say the note did not exist.
   */
  get(id: string, opts: { includeTrashed?: boolean | undefined } = {}): Note | null {
    const row = this.sql.first<NoteRow & { fields: string | null; deleted_at: number | null }>(
      `SELECT n.id, n.title, n.body, n.created_at, n.updated_at, nb.name AS notebook,
              n.notebook_id, n.deleted_at, ${FIELDS_SUBQUERY}
         FROM notes n
         LEFT JOIN notebooks nb ON nb.id = n.notebook_id
        WHERE n.id = ?1${opts.includeTrashed ? '' : ' AND n.deleted_at IS NULL'}`,
      id,
    );
    if (!row) return null;

    /*
     * CROSS JOIN is SQLite's way of fixing the join order, and the order is the point.
     * Written as a plain JOIN, the planner walked the whole tag list through the
     * UNIQUE(name) index — it is already in name order, so the ORDER BY came free — and
     * probed note_tags once per tag. That is every tag the account owns, read to return
     * two or three: on an archive with three hundred tags, opening a note read three
     * hundred rows. Starting from note_tags reads this note's rows and sorts a handful
     * of names.
     */
    const tags = this.sql.exec<{ name: string }>(
      `SELECT t.name FROM note_tags nt CROSS JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = ?1 ORDER BY t.name`,
      id,
    );

    const fields = decodeFieldsJson(row.fields, row.notebook_id);
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tags: tags.map((t) => t.name),
      notebook: row.notebook,
      notebookId: row.notebook_id,
      ...(fields.length > 0 ? { fields } : {}),
      ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}),
    };
  }

  /**
   * One transaction for the note, its tags and its values: a bad field value throws
   * before anything is written (it is validated first, as it always was), and a failure
   * after the insert now takes the insert with it rather than leaving a half-made note.
   * An id already held is the insert's own error; `createOrFind` is the way in for a
   * caller whose id may be a replay's.
   */
  create(input: {
    id: string;
    title: string;
    body: string;
    tags: string[];
    notebook?: string | null | undefined;
    fields?: NoteFieldsPatch | undefined;
  }): Note {
    return this.sql.tx(() => {
      const now = Date.now();
      // Validated before the insert, so a bad value leaves no half-made note behind.
      const fieldWrites = input.fields ? this.prepareFieldWrites(input.id, input.fields) : [];
      const notebookId = this.resolveNotebook(input.notebook);
      this.sql.exec(
        `INSERT INTO notes (id, title, body, created_at, updated_at, notebook_id)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)`,
        input.id,
        input.title,
        input.body,
        now,
        notebookId,
      );

      if (input.tags.length > 0) this.setTags(input.id, input.tags);
      if (fieldWrites.length > 0) this.run(fieldWrites);
      this.feed.record([{ entity: 'note', id: input.id }]);
      if (fieldWrites.length > 0) {
        // Read back rather than hand-built: the values carry their definitions' names and
        // types, which only the database knows.
        return this.get(input.id)!;
      }

      return {
        id: input.id,
        title: input.title,
        body: input.body,
        createdAt: now,
        updatedAt: now,
        tags: input.tags,
        notebook: input.notebook ?? null,
        notebookId,
      };
    });
  }

  /**
   * A new note with this one's title, body, filing and field values. Null when there is
   * no such live note.
   *
   * The body is copied as it is, `files/…` links included: those resolve within the copy
   * once its files exist, which is the caller's next step (`copyAttachments`), and the
   * copy is created first so the files have a note to belong to. Values are carried by
   * field id through the same validation a create gets, so a foreign field the note
   * kept from an earlier notebook comes along too. The title is kept rather than marked
   * "(copy)": the duplicate is opened at once, so which is which is never in doubt, and
   * a name the user did not choose is one they would only have to remove.
   */
  duplicate(id: string, newId: string): Note | null {
    return this.sql.tx(() => {
      const source = this.get(id);
      if (!source) return null;
      const fields: NoteFieldsPatch = {};
      for (const v of source.fields ?? []) fields[v.fieldId] = v.value;
      return this.create({
        id: newId,
        title: source.title,
        body: source.body,
        tags: source.tags,
        notebook: source.notebook,
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
      });
    });
  }

  /**
   * `create` for an id the client chose, which may be a replay's. Ids come from the
   * client now as well as the server — a note made offline has its address before the
   * server hears of it — and a request replayed after a dropped answer must find its
   * note rather than make a second one. An id already held answers with the note that
   * holds it, trashed or not, as `existing`, and writes nothing; the routes answer 200
   * for that and 201 for a note made here. The note itself stays a plain `Note`.
   */
  createOrFind(input: Parameters<NotesStore['create']>[0]): { note: Note; existing: boolean } {
    return this.sql.tx(() => {
      if (this.idTaken(input.id)) return { note: this.get(input.id, { includeTrashed: true })!, existing: true };
      return { note: this.create(input), existing: false };
    });
  }

  /** `duplicate` with the same replay rule as `createOrFind` for the copy's id. */
  duplicateOrFind(id: string, newId: string): { note: Note; existing: boolean } | null {
    return this.sql.tx(() => {
      if (this.idTaken(newId)) return { note: this.get(newId, { includeTrashed: true })!, existing: true };
      const note = this.duplicate(id, newId);
      return note ? { note, existing: false } : null;
    });
  }

  /**
   * Returns null when the note does not exist or is in the trash.
   *
   * A key whose value already equals what is stored is dropped before anything is
   * written, and a patch with nothing left after that returns the note untouched — no
   * `UPDATE`, and no new `updated_at`.
   *
   * That guard lives here rather than in each client because `updated_at` is a date the
   * user reads and sorts by, and for an imported note it is a real modification date
   * carried over from Evernote. A client can only diff against what it last saw, which is
   * stale the moment another device writes; the row is the only place that knows what is
   * actually stored. Every writer also gets it for free, which the clients demonstrably
   * do not: the web editor diffs (see `buildNotePatch`), the phone's title field sends
   * every settled keystroke, and `update_note_tags` promises over MCP that tags already
   * present are "left alone" while re-dating the note anyway.
   *
   * Comparison is exact, deliberately. Trimming the body would make a genuine edit that
   * only adds trailing space vanish silently, and in Markdown two trailing spaces are a
   * line break.
   *
   * The read and the writes are one transaction, so the note this compared against is
   * the note it writes over; on the shared database a save from another tab could land
   * between the two.
   *
   * `ifUpdatedAt` makes the write conditional on the note still being the copy the
   * writer last saw. When it has been saved since, nothing is written and the note as it
   * stands comes back as `{ stale }`; the routes answer 409 with it. Checked before the
   * no-op guard, even though a patch that would change nothing overwrites nothing. A 200
   * for it tells the writer its copy is current: the editor took the note that came back
   * as its new base, while its draft still held the old version of whatever else the other
   * device had changed — and the next keystroke sent that old text with a precondition that
   * passed. The writer is the one that can tell a stale no-op from a harmless one (the
   * editor's `holdsTheirChanges`), so it is the one that gets asked.
   *
   * A write may leave a copy of the note as it stood in the note's history, in this
   * transaction, so the copy exists exactly when the write does. Any write that lands:
   * the title and body, and since MAK-170 the field values, the tags and the notebook
   * too, which a version holds and Restore puts back. `by` is who is writing — an
   * assistant's write is not the person's, and is kept differently; see
   * `Revisions.keep`. It is not part of the HTTP patch: the route's schema has no such
   * key, so only the MCP tools, which call the repo, can say it.
   * With `updateMany` and `restoreRevision`, the only writes that leave copies. An
   * import writes a note that has nothing earlier, `appendToBody` only adds, and
   * `setBody` is the import's second step on a note it has just made. What a notebook's
   * or a tag's own management does to the notes under it — a rename, a delete, a field
   * converted — keeps nothing either: those are one act on hundreds of notes, a copy of
   * every body for each would be the archive written again, and Restore does not try to
   * undo them (see `planRestore`).
   */
  update(
    id: string,
    patch: {
      title?: string | undefined;
      body?: string | undefined;
      tags?: string[] | undefined;
      notebook?: string | null | undefined;
      fields?: NoteFieldsPatch | undefined;
      ifUpdatedAt?: number | undefined;
      by?: 'assistant' | undefined;
    },
  ): Note | StaleNote | null {
    const { ifUpdatedAt, by, ...changes } = patch;
    return this.sql.tx(() => {
      const current = this.get(id);
      if (!current) return null;

      if (ifUpdatedAt !== undefined && ifUpdatedAt !== current.updatedAt) return { stale: current };

      const effective = this.changedKeysOnly(changes, current);
      // Nothing in the patch differs from what is stored, so the note keeps its date.
      if (effective === null) return current;

      /*
         The new date, always past the old one. `ifUpdatedAt` is only as sound as "every
         write moves `updated_at`", and the clock alone does not promise that: inside a
         Workers invocation `Date.now()` stands still until there is I/O, so two writes
         the object serves back to back can read the same millisecond — an assistant's
         `edit_note` and an autosave arriving together, say — and the second would carry
         the first one's date, letting a save made against the first copy through.
      */
      const stamp = Math.max(Date.now(), current.updatedAt + 1);

      // Field values are validated before anything is written: a value the field cannot
      // hold fails the whole patch rather than landing after the title has changed.
      const fieldWrites =
        effective.fields !== undefined ? this.prepareFieldWrites(id, effective.fields) : [];

      // Before anything goes, and after everything that could still refuse the patch.
      const changed: NoteRevisionChange[] = [];
      if (effective.title !== undefined || effective.body !== undefined) changed.push('text');
      if (fieldWrites.length > 0) changed.push('fields');
      if (effective.tags !== undefined) changed.push('tags');
      if (effective.notebook !== undefined) changed.push('notebook');
      if (changed.length > 0) this.revisions.keep(id, current, stamp, by, changed, () => this.propsOf(current));

      const sets: string[] = [];
      const binds: Bind[] = [];

      if (effective.title !== undefined) {
        binds.push(effective.title);
        sets.push(`title = ?${binds.length}`);
      }
      if (effective.body !== undefined) {
        binds.push(effective.body);
        sets.push(`body = ?${binds.length}`);
      }
      if (effective.notebook !== undefined) {
        binds.push(this.resolveNotebook(effective.notebook));
        sets.push(`notebook_id = ?${binds.length}`);
      }

      if (sets.length > 0) {
        binds.push(stamp);
        sets.push(`updated_at = ?${binds.length}`);
        binds.push(id);
        const changed = this.sql.exec<{ id: string }>(
          `UPDATE notes SET ${sets.join(', ')}
            WHERE id = ?${binds.length} AND deleted_at IS NULL
            RETURNING id`,
          ...binds,
        );
        // Cannot happen inside the transaction that just read the note live, but the
        // guard costs nothing and says what the read established.
        if (changed.length === 0) return null;
      }

      if (effective.tags !== undefined) this.setTags(id, effective.tags);
      if (fieldWrites.length > 0) {
        this.run(fieldWrites);
        // Clearing a value can retire the last one a tombstoned definition was holding.
        this.sweepTombstonedFields();
      }
      if (effective.tags !== undefined || fieldWrites.length > 0) {
        this.sql.exec(`UPDATE notes SET updated_at = ?1 WHERE id = ?2`, stamp, id);
      }

      this.feed.record([{ entity: 'note', id }]);
      return this.get(id);
    });
  }

  /** A live note's history, newest first, or null when there is no such live note. */
  listRevisions(id: string): NoteRevisionSummary[] | null {
    if (!this.liveNoteById(id)) return null;
    return this.revisions.list(id, Date.now());
  }

  /**
   * One copy from a live note's history, whole, with what Restore would have to skip if
   * it were pressed now (`unfit`). Worked out by `planRestore`, the code Restore itself
   * runs, so what the sheet says beforehand and what the restore does cannot differ.
   */
  getRevision(id: string, revisionId: number): NoteRevision | null {
    const current = this.get(id);
    if (!current) return null;
    const revision = this.revisions.get(id, revisionId, Date.now());
    if (!revision) return null;
    const { skipped } = this.planRestore(current, revision);
    return skipped.length > 0 ? { ...revision, unfit: skipped } : revision;
  }

  /**
   * Deletes a live note's whole history: how many copies went, or null when there is no
   * such live note.
   *
   * For text that should not be kept. History holds what was removed from a note as
   * surely as what was lost from it, and a password pasted in by mistake and deleted a
   * minute later would otherwise be readable in the sheet for as long as copies last.
   * The note is untouched and nothing is recorded in the feed: history was never in it.
   *
   * What this does not reach is the store's own thirty days of point-in-time recovery,
   * which an operator can wind an account back through. That is the platform's, and
   * the README says so where it describes this.
   */
  clearRevisions(id: string): number | null {
    return this.sql.tx(() => {
      if (!this.liveNoteById(id)) return null;
      return this.revisions.clear(id);
    });
  }

  /**
   * Puts a copy from the note's history back: its title and body, and — when the copy
   * holds them — its notebook, tags and field values. Null when the note is not live or
   * the copy is not one of its own.
   *
   * What it replaces is kept first, always and whatever the window says, so a restore is
   * itself something the history can undo — including the one made by mistake, to the
   * wrong copy. One transaction for the copy and the write, here rather than as a patch
   * from the client carrying the old state: a patch is the person's own edit as far as
   * `update` can tell, and that keeps nothing inside the window.
   *
   * A copy that matches the note as it stands changes nothing and re-dates nothing, the
   * way a no-op patch does, and the answer says so: `kept` is the id of the copy this
   * kept of what it replaced, the one an Undo restores, and null when there was nothing
   * to replace.
   *
   * What the copy holds that no longer fits — a notebook deleted since, a field
   * converted — is left as the note has it and named in `skipped`; see `planRestore`.
   * The restore never fails over it: the text is nearly always what someone came for,
   * and refusing it because a field was deleted would hold the note hostage to a
   * settings page.
   *
   * `ifUpdatedAt` is `update`'s precondition, for the same reason and checked in the
   * same place: the caller is putting a copy back over a note it believes it has seen.
   * The Undo on a restore sends it — "undo, if the note is still as the restore left
   * it" — because that is a fact only this row knows; an edit saved since the restore
   * leaves no copy inside the window, so nothing in the history says it happened.
   */
  restoreRevision(id: string, revisionId: number, ifUpdatedAt?: number): RestoredNote | StaleNote | null {
    return this.sql.tx(() => {
      const current = this.get(id);
      if (!current) return null;
      if (ifUpdatedAt !== undefined && ifUpdatedAt !== current.updatedAt) return { stale: current };
      const revision = this.revisions.get(id, revisionId, Date.now());
      if (!revision) return null;

      const plan = this.planRestore(current, revision);
      const skipped = plan.skipped.length > 0 ? { skipped: plan.skipped } : {};
      // Validated before anything is written, as `update` has it. The plan only holds
      // values it has already read under their definitions, so this builds and does not
      // refuse.
      const fieldWrites = Object.keys(plan.fields).length > 0 ? this.prepareFieldWrites(id, plan.fields) : [];

      const changed: NoteRevisionChange[] = [];
      if (revision.title !== current.title || revision.body !== current.body) changed.push('text');
      if (fieldWrites.length > 0) changed.push('fields');
      if (plan.tags !== undefined) changed.push('tags');
      if (plan.notebookId !== undefined) changed.push('notebook');
      // Said, not only done: `kept: null` is how the caller knows this was no restore.
      if (changed.length === 0) return { note: current, kept: null, ...skipped };

      // Past the old date, always, as `update` has it: see the stamp there.
      const stamp = Math.max(Date.now(), current.updatedAt + 1);
      const kept = this.revisions.keep(id, current, stamp, 'restore', changed, () => this.propsOf(current));
      this.sql.exec(
        `UPDATE notes SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4 AND deleted_at IS NULL`,
        revision.title,
        revision.body,
        stamp,
        id,
      );
      if (plan.notebookId !== undefined) {
        this.sql.exec(`UPDATE notes SET notebook_id = ?1 WHERE id = ?2`, plan.notebookId, id);
      }
      if (plan.tags !== undefined) this.setTags(id, plan.tags);
      if (fieldWrites.length > 0) {
        this.run(fieldWrites);
        // Clearing a value can retire the last one a tombstoned definition was holding.
        this.sweepTombstonedFields();
      }
      this.feed.record([{ entity: 'note', id }]);
      return { note: this.get(id)!, kept, ...skipped };
    });
  }

  /**
   * What a copy holds besides the note's text, read when one is being kept: the
   * notebook and the tags with their ids, the field values as the note carries them.
   *
   * One read, for the tags' ids — `get` answers with names, which is what every other
   * caller wants. The ids are what let a restore tell a tag renamed since from one
   * deleted since; see `NoteRevisionProps`.
   */
  private propsOf(current: Note): NoteRevisionProps {
    const tags = this.sql.exec<{ id: string; name: string }>(
      // CROSS JOIN for the order, as `get` has it: this note's rows, then each tag.
      `SELECT t.id, t.name FROM note_tags nt CROSS JOIN tags t ON t.id = nt.tag_id
        WHERE nt.note_id = ?1 ORDER BY t.name`,
      current.id,
    );
    return {
      notebook: current.notebookId && current.notebook != null ? { id: current.notebookId, name: current.notebook } : null,
      tags,
      fields: current.fields ?? [],
    };
  }

  /**
   * What putting a copy's notebook, tags and field values back would write, and what it
   * would have to leave: `notebookId` and `tags` are undefined when they stay as they
   * are, `fields` is a patch for `prepareFieldWrites`, and `skipped` names each thing
   * the copy holds that no longer fits. Reads only, so `getRevision` can ask the same
   * question for the sheet.
   *
   * A copy with no `props` — one kept before they were part of a version — plans
   * nothing: not recorded is not "had none", and a restore that cleared a note's fields
   * because an old copy never knew them would be the opposite of a safety net.
   *
   * The target is the note as the copy has it, by id, under today's names:
   *
   * - The notebook, if it still exists; one deleted since is skipped and the note stays
   *   where it is. Not made again under its old name, which `resolveNotebook` would do:
   *   deleting a notebook is a decision, and its fields would not come back with it.
   * - The tags that still exist, under whatever they are called now. A tag deleted
   *   since is skipped, for the same reason. A tag the note has gained since comes off:
   *   the copy did not have it.
   * - Each value whose field is still defined and can still hold it. A field deleted
   *   since (gone, or a tombstone) is skipped; so is a value its field can no longer be
   *   read as after a conversion, and a choice the field no longer offers. A multi-select
   *   missing one of several choices is skipped whole rather than restored in part: half
   *   a value is not the value the copy held, and saying which half is more than a
   *   snackbar can carry.
   * - A value the note has gained since is cleared, the copy not having had it — unless
   *   the notebook could not be put back and the value belongs to the notebook the note
   *   is staying in. Clearing those would leave the note filed where it is with that
   *   notebook's fields emptied, which is neither the copy nor the note.
   *
   * It restores this note, not the account. A notebook renamed, a field renamed or
   * converted for every note, a tag merged: those are the management pages' acts and
   * stay as they are; the copy's values are read under the definitions of today.
   */
  private planRestore(
    current: Note,
    revision: NoteRevision,
  ): { notebookId?: string | null; tags?: string[]; fields: NoteFieldsPatch; skipped: RevisionSkip[] } {
    const props = revision.props;
    if (!props) return { fields: {}, skipped: [] };
    const skipped: RevisionSkip[] = [];
    const plan: { notebookId?: string | null; tags?: string[] } = {};

    let notebookStays = false;
    const currentNotebookId = current.notebookId ?? null;
    if (props.notebook === null) {
      if (currentNotebookId !== null) plan.notebookId = null;
    } else if (props.notebook.id !== currentNotebookId) {
      if (this.sql.first<{ id: string }>(`SELECT id FROM notebooks WHERE id = ?1`, props.notebook.id)) {
        plan.notebookId = props.notebook.id;
      } else {
        skipped.push({ what: 'notebook', id: props.notebook.id, name: props.notebook.name, why: 'deleted' });
        notebookStays = true;
      }
    }

    if (props.tags.length > 0 || current.tags.length > 0) {
      const live = new Map(
        this.sql
          .exec<{ id: string; name: string }>(
            `SELECT id, name FROM tags WHERE id IN (SELECT value FROM json_each(?1))`,
            JSON.stringify(props.tags.map((t) => t.id)),
          )
          .map((t) => [t.id, t.name]),
      );
      const tags: string[] = [];
      for (const tag of props.tags) {
        const name = live.get(tag.id);
        if (name !== undefined) tags.push(name);
        else skipped.push({ what: 'tag', id: tag.id, name: tag.name, why: 'deleted' });
      }
      if (!sameTagSet(tags, current.tags)) plan.tags = tags;
    }

    const fields: NoteFieldsPatch = {};
    const held = new Map((current.fields ?? []).map((v) => [v.fieldId, v]));
    const defs = new Map(
      this.sql
        .exec<FieldRow & { deleted_at: number | null }>(
          `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position, deleted_at
             FROM notebook_fields
            WHERE id IN (SELECT value FROM json_each(?1))`,
          JSON.stringify(props.fields.map((v) => v.fieldId)),
        )
        .map((r) => [r.id, { def: rowToField(r), deleted: r.deleted_at !== null }]),
    );
    for (const was of props.fields) {
      const stands = held.get(was.fieldId);
      // Already what the note says, whatever has become of the field: nothing to do.
      if (stands !== undefined && sameFieldText(stands.value, was.value)) continue;
      const found = defs.get(was.fieldId);
      if (!found || found.deleted) {
        skipped.push({ what: 'field', id: was.fieldId, name: was.name, why: 'deleted' });
        continue;
      }
      const encoded = encodeFieldValue(found.def, was.value);
      if (encoded === null || encoded === 'clear') {
        const lostOption = found.def.type === was.type && fieldHasOptions(found.def.type);
        skipped.push({ what: 'field', id: was.fieldId, name: found.def.name, why: lostOption ? 'option' : 'type' });
        continue;
      }
      fields[was.fieldId] = was.value;
    }
    const inCopy = new Set(props.fields.map((v) => v.fieldId));
    for (const [fieldId, stands] of held) {
      if (inCopy.has(fieldId)) continue;
      if (notebookStays && stands.notebookId === currentNotebookId) continue;
      fields[fieldId] = null;
    }

    return { ...plan, fields, skipped };
  }

  /**
   * The patch with every key that matches what is stored removed, or null if that leaves
   * nothing to do.
   *
   * Only keys the caller actually sent are considered — a merge PATCH means an absent key
   * is "leave alone", never "clear" — so this can only ever remove keys, and a patch it
   * returns unchanged behaves exactly as it did before this existed.
   *
   * `notebook` is compared by name, which is what the patch carries and what `get`
   * returns. Filing a note into the notebook it is already in is the no-op that
   * `move_notes` performs 50 at a time.
   *
   * Tags are compared as sets: they are stored unordered and `get` returns them sorted by
   * name, so a client resending them in its own order is not an edit. Duplicates and
   * blanks are dropped first, the way `setTags` would drop them before writing.
   */
  private changedKeysOnly(
    patch: {
      title?: string | undefined;
      body?: string | undefined;
      tags?: string[] | undefined;
      notebook?: string | null | undefined;
      fields?: NoteFieldsPatch | undefined;
    },
    current: Note,
  ): typeof patch | null {
    const next: typeof patch = {};

    if (patch.title !== undefined && patch.title !== current.title) next.title = patch.title;
    if (patch.body !== undefined && patch.body !== current.body) next.body = patch.body;

    if (patch.notebook !== undefined) {
      const stored = current.notebook ?? null;
      if ((patch.notebook ?? null) !== stored) next.notebook = patch.notebook;
    }

    if (patch.tags !== undefined && !sameTagSet(patch.tags, current.tags)) next.tags = patch.tags;

    if (patch.fields !== undefined) {
      const held = new Map((current.fields ?? []).map((v) => [v.fieldId, v.value]));
      const fields: NoteFieldsPatch = {};
      for (const [fieldId, value] of Object.entries(patch.fields)) {
        const stands = held.get(fieldId);
        if (value === null || value === undefined) {
          // A clear is only a change when there is something to clear. An id the note
          // never held is dropped rather than sent, which also keeps a stale id from
          // failing the patch in `prepareFieldWrites` with "No such field".
          if (stands !== undefined) fields[fieldId] = value ?? null;
          continue;
        }
        // Compared as text: a number the client re-sends as "12" is the stored 12, and
        // the far end is going to encode it to a string column either way. A list is
        // compared as one, so its elements' commas cannot make two lists read as one.
        if (stands !== undefined && sameFieldText(stands, value)) continue;
        fields[fieldId] = value;
      }
      if (Object.keys(fields).length > 0) next.fields = fields;
    }

    return Object.keys(next).length > 0 ? next : null;
  }

  /**
   * Appends markdown to the end of a note's body, separated by a blank line.
   *
   * Exists for clients that upload an attachment but cannot edit the body themselves. The
   * browser editor inserts its own link at the cursor (see Editor.tsx), but a phone share
   * sheet has no cursor and no copy of the body — without this, a shared photo would be
   * stored as an attachment that the note never displays.
   *
   * One statement, concatenating in SQL, so two files shared together — which upload
   * concurrently and each append their link — both survive whichever lands first. The
   * object serialises the two requests anyway; the shape is kept because it is also the
   * simplest correct one.
   */
  appendToBody(id: string, markdown: string): boolean {
    return this.sql.tx(() => {
      // The date goes past the old one, always, as `update` has it: see the stamp there.
      const changed = this.sql.exec<{ id: string }>(
        `UPDATE notes
            SET body = CASE WHEN body = '' THEN ?1 ELSE body || char(10) || char(10) || ?1 END,
                updated_at = MAX(?2, updated_at + 1)
          WHERE id = ?3 AND deleted_at IS NULL
          RETURNING id`,
        markdown,
        Date.now(),
        id,
      );
      this.feed.record(changed.map((r) => ({ entity: 'note', id: r.id })));
      return changed.length > 0;
    });
  }

  /*
     Whether a write touched a row comes from `RETURNING id`, never from a count of rows
     written: a note's row has triggers on it — the FTS index's, the stored counts' — and
     the engine counts what they write too, so trashing one note reports several rows
     written. The length of what RETURNING hands back is exact.
  */

  /** Soft delete — trash, not destroy. Returns false when there is no such live note. */
  remove(id: string): boolean {
    return this.sql.tx(() => {
      const changed = this.sql.exec<{ id: string }>(
        `UPDATE notes SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL RETURNING id`,
        Date.now(),
        id,
      );
      // The trash is an update to the feed — the note is still there, with `deletedAt`
      // — and only a purge is a tombstone.
      this.feed.record(changed.map((r) => ({ entity: 'note', id: r.id })));
      return changed.length > 0;
    });
  }

  /**
   * Restores a trashed note. Returns false when there is no such note, or it is not in
   * the trash.
   *
   * `updated_at` is deliberately left alone: restoring is not an edit, and bumping it would
   * reorder the note to the top of the list as though it had just been written.
   */
  restore(id: string): boolean {
    return this.sql.tx(() => {
      const changed = this.sql.exec<{ id: string }>(
        `UPDATE notes SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL RETURNING id`,
        id,
      );
      this.feed.record(changed.map((r) => ({ entity: 'note', id: r.id })));
      return changed.length > 0;
    });
  }

  /**
   * Permanently deletes one trashed note, returning its R2 keys so the blobs can go too.
   *
   * The keys are read and the row deleted in one transaction, so the keys are exactly
   * those of the note that went: a restore cannot land between the two and leave the
   * route deleting the files of a note that is live again. The singular route still
   * checks `deleted` before it sweeps, as it did when the two were separate statements.
   */
  purgeOne(id: string): { deleted: boolean; keys: string[] } {
    return this.sql.tx(() => {
      const keys = this.sql
        .exec<{ r2_key: string }>(
          `SELECT a.r2_key FROM attachments a
             JOIN notes n ON n.id = a.note_id
            WHERE n.id = ?1 AND n.deleted_at IS NOT NULL`,
          id,
        )
        .map((r) => r.r2_key);
      const gone = this.sql.exec<{ id: string }>(
        `DELETE FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL RETURNING id`,
        id,
      );
      // This note may have held the last value a tombstoned definition was keeping alive.
      const deleted = gone.length > 0;
      if (deleted) this.sweepTombstonedFields();
      this.feed.record(gone.map((r) => ({ entity: 'note', id: r.id, deleted: true })));
      return { deleted, keys: deleted ? keys : [] };
    });
  }

  /*
     Several notes at once — the list's selection acting as one.

     Each of these is the singular method above applied to a set, with two differences the
     set forces. Ids that are on the wrong side of the trash, or that no longer exist, are
     skipped and counted out rather than failing the request: a selection is made from a
     list that can go stale under it — a note trashed from another tab, restored over MCP —
     and one such id must not stop the other forty-nine. And every statement names its notes
     in runs of `ID_RUN`, because the engine caps the binds a statement carries at a hundred.

     Each answers with the ids it touched rather than a count, so a caller can say which
     of the ids it named were not: the MCP tools report those back to an assistant, and
     the routes reduce the list to the number the web client wants.
  */

  /** Trashes several notes. Returns the ids that were — ids already trashed are not among them. */
  removeMany(ids: string[]): string[] {
    const now = Date.now();
    return this.sql.tx(() => {
      const trashed: string[] = [];
      for (const run of runs([...new Set(ids)])) {
        const rows = this.sql.exec<{ id: string }>(
          `UPDATE notes SET deleted_at = ?1
            WHERE +deleted_at IS NULL AND id IN (${placeholders(2, run.length)})
            RETURNING id`,
          now,
          ...run,
        );
        trashed.push(...rows.map((r) => r.id));
      }
      this.feed.record(trashed.map((id) => ({ entity: 'note', id })));
      return trashed;
    });
  }

  /** Restores several trashed notes. `updated_at` stays, as `restore` leaves it. */
  restoreMany(ids: string[]): string[] {
    return this.sql.tx(() => {
      const restored: string[] = [];
      for (const run of runs([...new Set(ids)])) {
        const rows = this.sql.exec<{ id: string }>(
          `UPDATE notes SET deleted_at = NULL
            WHERE +deleted_at IS NOT NULL AND id IN (${placeholders(1, run.length)})
            RETURNING id`,
          ...run,
        );
        restored.push(...rows.map((r) => r.id));
      }
      this.feed.record(restored.map((id) => ({ entity: 'note', id })));
      return restored;
    });
  }

  /**
   * Permanently deletes several trashed notes, returning their R2 keys so the blobs can go
   * too. Only ones already in the trash, as `purgeOne`: a live note named here is left
   * alone, because the two-step delete is the safety property.
   *
   * Keys are only those of notes this actually deleted. Inside one transaction the SELECT
   * and the DELETE see the same rows, but the DELETE still re-checks `deleted_at` and the
   * keys are still matched against what it returned — the property is worth stating in
   * the code, not only in the isolation the transaction happens to give.
   *
   * Sweeps what `purge` sweeps afterwards — tag rows nothing references any more, and
   * field definitions these notes were the last to hold a value for — since a selection
   * can be most of the trash.
   */
  purgeMany(ids: string[]): { deleted: number; keys: string[] } {
    return this.sql.tx(() => {
      const keys: string[] = [];
      let deleted = 0;
      for (const run of runs([...new Set(ids)])) {
        const keyRows = this.sql.exec<{ r2_key: string; note_id: string }>(
          `SELECT a.r2_key, n.id AS note_id FROM attachments a
             JOIN notes n ON n.id = a.note_id
            WHERE +n.deleted_at IS NOT NULL
              AND n.id IN (${placeholders(1, run.length)})`,
          ...run,
        );
        const gone = this.sql.exec<{ id: string }>(
          `DELETE FROM notes
            WHERE +deleted_at IS NOT NULL AND id IN (${placeholders(1, run.length)})
            RETURNING id`,
          ...run,
        );
        deleted += gone.length;
        keys.push(...keysOfDeletedNotes(keyRows, gone.map((r) => r.id)));
        this.feed.record(gone.map((r) => ({ entity: 'note', id: r.id, deleted: true })));
      }

      if (deleted > 0) this.sweepAfterPurge();
      return { deleted, keys };
    });
  }

  /**
   * Refiles several notes at once — into a notebook or out of every one, with tags added
   * or taken away.
   *
   * Reads first and writes only what differs, the way `update` does through
   * `changedKeysOnly`. The date is not bookkeeping: it is read, sorted by, and for an
   * imported note it is a real modification date carried over from Evernote — so "tag
   * these forty" must not re-date the thirty that already had the tag, and moving a
   * selection into the notebook half of it is already in must leave that half alone.
   * `matched` is which of the ids were live notes; `changed` which of those were actually
   * written.
   *
   * One transaction, so a failure part way leaves every note refiled or none of them.
   * Tags are added and removed per note rather than set — the notes need not agree with
   * each other — and a tag in both lists is added, the rule `update_note_tags` states
   * over MCP. Tag rows are get-or-create as `setTags` has them; a tag removed from its
   * last note keeps its row, also as `setTags` leaves it, since `listTags` only counts
   * tags on live notes.
   *
   * `fields` sets the same values on every note, by field id, with `update`'s rules —
   * merge, null clears, and each value validated against its definition by
   * `prepareFieldWrites`, the one validator — and a note already holding a value keeps its
   * date, as it does under `update`. What `update` leaves to its caller is made a rule
   * here: every field must be one of the notebook the note will be in once this call has
   * run. One note's editor offers only its own notebook's fields, so a value written by id
   * to a note elsewhere is a mistake it cannot make; a set of notes is where a caller can
   * make it by naming a field of one notebook over notes from two. That refuses the whole
   * call, naming the note, rather than leaving values on notes that cannot show them. A
   * bad value refuses the whole call too, and nothing is written: validation precedes the
   * first write, and the transaction would take back anything before it.
   *
   * Each note actually written may leave a copy of itself in its history first, under
   * `update`'s rules and for `update`'s reasons (MAK-170): the same half-hour sitting
   * for a person's selection, and `by: 'assistant'` for the MCP batch tools, whose
   * refiling of two hundred notes is the edit someone most wants to be able to look
   * back through. That is a read of each changed note and at most a row kept for it —
   * a note per changed note, not per id sent, so the forty that already had the tag
   * cost nothing here either. `by` is the caller's to say and is not in the HTTP
   * schema, as on `update`.
   */
  updateMany(
    ids: string[],
    patch: {
      notebook?: string | null | undefined;
      addTags?: string[] | undefined;
      removeTags?: string[] | undefined;
      fields?: NoteFieldsPatch | undefined;
      by?: 'assistant' | undefined;
    },
  ): { matched: string[]; changed: string[] } {
    const add = uniqueTags(patch.addTags ?? []);
    const remove = uniqueTags(patch.removeTags ?? []).filter((t) => !add.includes(t));

    return this.sql.tx(() => {
      // What each note holds now: its notebook and its tags, one row per note.
      const rows: Array<{ id: string; notebook_id: string | null; tags: string | null }> = [];
      for (const run of runs([...new Set(ids)])) {
        rows.push(
          ...this.sql.exec<{ id: string; notebook_id: string | null; tags: string | null }>(
            `SELECT n.id, n.notebook_id,
                    (SELECT group_concat(t.name, char(31)) FROM note_tags nt
                       JOIN tags t ON t.id = nt.tag_id
                      WHERE nt.note_id = n.id) AS tags
               FROM notes n
              WHERE +n.deleted_at IS NULL
                AND n.id IN (${placeholders(1, run.length)})`,
            ...run,
          ),
        );
      }
      const matched = rows.map((r) => r.id);
      if (rows.length === 0) return { matched, changed: [] };

      // The destination, resolved once — created if it does not exist yet, as `update`
      // would create it for one note. Only once something is going to be filed there.
      const notebookId =
        patch.notebook === undefined ? undefined : this.resolveNotebook(patch.notebook);

      // Validated and built for every note before the first write, so a bad value or a
      // field from the wrong notebook leaves nothing half done.
      const fieldWrites =
        patch.fields && Object.keys(patch.fields).length > 0
          ? this.prepareBulkFieldWrites(
              rows.map((r) => ({
                id: r.id,
                notebookId: notebookId === undefined ? r.notebook_id : notebookId,
              })),
              patch.fields,
            )
          : new Map<string, Statement[]>();

      const moving: string[] = [];
      /** Tag name → the notes that lack it, or that carry it. */
      const adding = new Map<string, string[]>();
      const removing = new Map<string, string[]>();
      const changed = new Set<string>();
      const note = (map: Map<string, string[]>, tag: string, id: string) => {
        map.get(tag)?.push(id) ?? map.set(tag, [id]);
        changed.add(id);
      };
      for (const row of rows) {
        if (notebookId !== undefined && row.notebook_id !== notebookId) {
          moving.push(row.id);
          changed.add(row.id);
        }
        const have = new Set(splitTags(row.tags));
        for (const tag of add) if (!have.has(tag)) note(adding, tag, row.id);
        for (const tag of remove) if (have.has(tag)) note(removing, tag, row.id);
        if (fieldWrites.has(row.id)) changed.add(row.id);
      }
      if (changed.size === 0) return { matched, changed: [] };

      // Before the first write, each changed note as it stands, for its history. The
      // stamp is the one the statement at the end gives the note.
      const now = Date.now();
      const moved = new Set(moving);
      const retagged = new Set([...adding.values(), ...removing.values()].flat());
      for (const id of changed) {
        const current = this.get(id);
        if (!current) continue;
        const parts: NoteRevisionChange[] = [];
        if (fieldWrites.has(id)) parts.push('fields');
        if (retagged.has(id)) parts.push('tags');
        if (moved.has(id)) parts.push('notebook');
        this.revisions.keep(id, current, Math.max(now, current.updatedAt + 1), patch.by, parts, () => this.propsOf(current));
      }

      for (const run of runs(moving)) {
        this.sql.exec(
          `UPDATE notes SET notebook_id = ?1
            WHERE +deleted_at IS NULL AND id IN (${placeholders(2, run.length)})`,
          notebookId,
          ...run,
        );
      }

      // Tag rows before the joins that look them up.
      for (const name of adding.keys()) this.ensureTag(name);
      for (const [name, noteIds] of adding) {
        for (const run of runs(noteIds)) {
          this.sql.exec(
            `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
             SELECT n.id, t.id FROM notes n
               JOIN tags t ON t.name = ?1
              WHERE n.id IN (${placeholders(2, run.length)})`,
            name,
            ...run,
          );
        }
      }
      for (const [name, noteIds] of removing) {
        for (const run of runs(noteIds)) {
          this.sql.exec(
            `DELETE FROM note_tags
              WHERE tag_id = (SELECT id FROM tags WHERE name = ?1)
                AND note_id IN (${placeholders(2, run.length)})`,
            name,
            ...run,
          );
        }
      }

      for (const statements of fieldWrites.values()) this.run(statements);

      for (const run of runs([...changed])) {
        this.sql.exec(
          // Past each note's old date, always, as `update` has it: see the stamp there.
          `UPDATE notes SET updated_at = MAX(?1, updated_at + 1) WHERE id IN (${placeholders(2, run.length)})`,
          now,
          ...run,
        );
      }
      this.feed.record([...changed].map((id) => ({ entity: 'note', id })));

      return { matched, changed: [...changed] };
    });
  }

  /**
   * Creates a note from an import, or returns the existing one with the same content hash.
   *
   * Idempotency is what makes a large import resumable. A 3GB file takes tens of minutes
   * and will be interrupted; re-running must not duplicate the thousands of notes that
   * already landed. The hash covers title and body (and the exported id, when there is
   * one), so re-importing an unchanged export is a no-op while a genuinely edited note
   * still comes through as new.
   */
  importNote(input: {
    /** The id to keep if it is free, and to recognise the note by if it is already here. */
    id?: string | undefined;
    title: string;
    body: string;
    tags: string[];
    notebook?: string | undefined;
    createdAt: number;
    updatedAt: number;
    contentHash: string;
    sourceEnex?: string | undefined;
    /** By field name; see `applyImportedFields`. */
    fields?: Record<string, FieldValue> | undefined;
  }): { id: string; created: boolean; skippedFields: string[] } {
    return this.sql.tx(() => {
      /**
       * Two ways a note can already be here, checked in order of confidence.
       *
       * By id first: an Unbent export names each note, and a live note with that id is
       * this note whatever has happened to its text since — a restore must not lay a
       * second copy beside a note the person edited after backing up. Then by content
       * hash, which is what an ENEX import has and what catches an archive whose ids were
       * stripped. The trash is not consulted by either: a note deleted on purpose stays
       * deleted, and importing it again brings back a fresh live copy under a new id.
       *
       * A hash hit is not "already here" when the requested id is free. Two empty
       * Untitled drafts share their text and would otherwise collapse: the second was
       * skipped, and its attachments landed on the first or vanished. A free id is a
       * different note. A taken id with a hash hit is a remint from a prior run of
       * *this* note, and skipping it is what makes that resume work.
       */
      const idIsTaken = input.id ? this.idTaken(input.id) : false;
      const existingById = input.id ? this.liveNoteById(input.id) : null;
      // A free id is a different note however its text hashes, so there is nothing for a
      // hash hit to swallow — don't even look.
      const existingByHash =
        existingById || (input.id && !idIsTaken) ? null : this.liveNoteByHash(input.contentHash);
      const existing = existingById ?? existingByHash;

      if (existing) {
        /**
         * Still ensure the notebook exists (and re-file if the note is unfiled).
         *
         * Deleting a notebook unfiles its notes but leaves them in place. A re-import then
         * hits this skip path — without resolving the notebook here, the notebook would never
         * come back and the notes would stay unfiled forever. Manual moves after import are
         * preserved: only unfiled notes are re-attached.
         */
        let skippedFields: string[] = [];
        // Recorded only when something about the note moved: a re-import of an unchanged
        // archive is thousands of these, and a row for each would have every device read
        // the whole account again for nothing.
        let touched = false;
        if (input.notebook) {
          const notebookId = this.resolveNotebook(input.notebook);
          const refiled = this.sql.exec<{ id: string }>(
            `UPDATE notes SET notebook_id = ?1 WHERE id = ?2 AND notebook_id IS NULL RETURNING id`,
            notebookId,
            existing.id,
          );
          touched = refiled.length > 0;
          // Same rule as the re-file above: restore values a deleted field took with it,
          // but never overwrite a value the person has since changed.
          if (notebookId && input.fields) {
            const applied = this.applyImportedFields(existing.id, notebookId, input.fields, true);
            skippedFields = applied.skipped;
            touched ||= applied.changed;
          }
        } else if (input.fields) {
          skippedFields = Object.keys(input.fields);
        }
        if (touched) this.feed.record([{ entity: 'note', id: existing.id }]);
        return { id: existing.id, created: false, skippedFields };
      }

      /**
       * Keep the exported id when nothing holds it. The check covers the trash, because
       * the column is the table's primary key: a trashed note keeps its id so it can
       * still be restored, so a re-import of the same note lands under a fresh one.
       * Another account importing the same archive is no longer a collision — it has a
       * database of its own — which is why ids stay globally unique UUIDs even so: a
       * reference of the form (owner, note id) has to stay unambiguous forever.
       */
      const id = input.id && !idIsTaken ? input.id : crypto.randomUUID();
      const notebookId = this.resolveNotebook(input.notebook);
      this.sql.exec(
        `INSERT INTO notes
           (id, title, body, created_at, updated_at, content_hash, source_enex, notebook_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        id,
        input.title,
        input.body,
        input.createdAt,
        input.updatedAt,
        input.contentHash,
        input.sourceEnex ?? null,
        notebookId,
      );

      if (input.tags.length > 0) this.setTags(id, input.tags);

      // Fields belong to a notebook, so an unfiled import has nowhere to put them.
      let skippedFields: string[] = [];
      if (input.fields) {
        skippedFields = notebookId
          ? this.applyImportedFields(id, notebookId, input.fields, false).skipped
          : Object.keys(input.fields);
      }

      this.feed.record([{ entity: 'note', id }]);
      return { id, created: true, skippedFields };
    });
  }

  /** The live note with this id, if there is one. */
  private liveNoteById(id: string): { id: string } | null {
    return this.sql.first<{ id: string }>(`SELECT id FROM notes WHERE id = ?1 AND deleted_at IS NULL`, id);
  }

  /** The live note carrying this content hash, if there is one. */
  private liveNoteByHash(contentHash: string): { id: string } | null {
    return this.sql.first<{ id: string }>(
      `SELECT id FROM notes WHERE content_hash = ?1 AND deleted_at IS NULL LIMIT 1`,
      contentHash,
    );
  }

  /** True when any row of this account's — trashed or not — already has this id. */
  private idTaken(id: string): boolean {
    return this.sql.first<{ hit: number }>(`SELECT 1 AS hit FROM notes WHERE id = ?1`, id) !== null;
  }

  /** Replaces a note's body after its attachment links are known. */
  setBody(id: string, body: string): void {
    this.sql.tx(() => {
      const changed = this.sql.exec<{ id: string }>(`UPDATE notes SET body = ?1 WHERE id = ?2 RETURNING id`, body, id);
      this.feed.record(changed.map((r) => ({ entity: 'note', id: r.id })));
    });
  }

  /**
   * Full-text search, newest-relevant first.
   *
   * `scopeDrivenSearchMax` is the threshold below which a notebook or tag filter is
   * searched note by note rather than match by match — see `scopeDrivenSearchSql`. A
   * parameter rather than a field, so the object holds no mutable state a request could
   * leave behind for the next; the facade passes the value the live suite may have set.
   */
  search(
    rawQuery: string,
    limit: number,
    filters: SearchFilters = {},
    scopeDrivenSearchMax = SCOPE_DRIVEN_SEARCH_MAX,
  ): SearchResult[] {
    const query = toFtsQuery(rawQuery);
    if (!query) return [];

    /**
     * The filters bind after the two fixed parameters, and the same clauses are spliced
     * into every tier — each joins `notes n` on its own, so a filter applied to only one
     * would let the other leak notes from outside the current scope.
     */
    const binds: Bind[] = [query, limit];
    const scope = filterConditions(filters, binds);
    const scoped = scope.length > 0 ? `AND ${scope.join(' AND ')}` : '';

    if (this.searchScopeIsSmall(filters, scopeDrivenSearchMax)) {
      return this.sql
        .exec<SearchRow>(scopeDrivenSearchSql(liveCondition(false, filters.tags), scoped), ...binds)
        .map(toSearchResult);
    }

    /**
     * Four indexes, one result set.
     *
     * Most notes in an imported Evernote corpus are a scanned PDF with an empty body, so
     * searching note text alone misses the majority of them. attachment_text_fts carries
     * the OCR text those files already contained; a match there surfaces the note and
     * names the file it came from. note_fields_fts carries custom field values — a vendor,
     * a policy number — which are in neither the body nor the file; a match there names
     * the field. tags_fts carries tag names, so a note filed under "Alfa Romeo Stelvio"
     * is found by "stelvio" even when the word appears nowhere in it — which is how an
     * archive filed by tag is actually looked up, and what Evernote does; a match there
     * names the tag.
     *
     * Tiers order the sources at equal relevance: what the user wrote, then what they
     * filed it under, then what they filed under a field, then what a scanner read. A tag
     * and a field value are both deliberate, exact statements about the note, so both
     * outrank OCR text; the tag comes first because it is the coarser, more often used
     * classification, and a search for a tag name is usually looking for the tag.
     *
     * One row per note, and it is the best-tier one. This was a GROUP BY with MIN(tier)
     * and MIN(rank), which relied on SQLite's bare-column rule to pick the snippet — and
     * that rule follows the *last* aggregate, so a note matching in its body and in a
     * tag came back with the tag's snippet and "tagged X" under it whenever the tag's
     * bm25 happened to be the smaller number. The window function says which row is
     * meant.
     *
     * tag_hits carries two unary pluses, and both are load-bearing. Without the one on
     * `n.deleted_at` the planner — which has no statistics and so takes the first column
     * of an index to be selective — would join each matching tag to every live note
     * through a `deleted_at` index and ask each one whether it carried the tag; on the
     * shared database, where the column was `user_id`, that read 12.7k rows per matching
     * tag at 13k notes. With it, the join runs tag → its note_tags → those notes by
     * primary key. The one on `nt.note_id` stops a tag filter's `n.id IN (…)` from being
     * carried over onto note_tags, which made the plan probe the tag index once per
     * filtered note for every matching tag instead of reading each tag's links once.
     *
     * Every tier stops after a page, because every row a query visits is metered and this
     * one used to visit every match. Each tier used to join all of its matches to notes,
     * compute bm25 for each, and hand the lot to the window function to sort — a common
     * word read 146k rows to show fifty. Now each tier orders by its FTS table's own
     * `rank` (the vtab streams in rank order, so the LIMIT stops the join early), a tier
     * is skipped outright once the tiers above it have filled the page — no lower tier
     * can outrank them — and each later tier leaves out notes an earlier one already
     * holds, so its rows are all candidates. The same common word now reads about 10k.
     * `rank MATCH 'bm25(10.0, 1.0)'` keeps the title weighting the old `bm25()` call had.
     * The MATERIALIZED CTEs are each referenced several times and must run once.
     */
    return this.sql
      .exec<SearchRow>(
        `WITH note_hits AS MATERIALIZED (
           SELECT ${tierColumns('note', 'n', 'vtab')}
             FROM notes_fts
             JOIN notes n ON n.rowid = notes_fts.rowid
            WHERE notes_fts MATCH ?1 AND ${tierRankMatch('note')}
              AND n.deleted_at IS NULL
              ${scoped}
            ORDER BY notes_fts.rank
            LIMIT ?2
         ),
         tag_hits AS MATERIALIZED (
           SELECT ${tierColumns('tag', 'n', 'vtab')}
             FROM tags_fts
             JOIN tags t ON t.rowid = tags_fts.rowid
             JOIN note_tags nt ON nt.tag_id = t.id
             JOIN notes n ON n.id = +nt.note_id
            WHERE (SELECT COUNT(*) FROM note_hits) < ?2
              AND tags_fts MATCH ?1
              AND +n.deleted_at IS NULL
              AND n.id NOT IN (SELECT id FROM note_hits)
              ${scoped}
            ORDER BY tags_fts.rank
            LIMIT ?2 * ${SEARCH_OVERFETCH}
         ),
         early AS MATERIALIZED (
           SELECT * FROM note_hits UNION ALL SELECT * FROM tag_hits
         ),
         field_hits AS MATERIALIZED (
           SELECT ${tierColumns('field', 'n', 'vtab')}
             FROM note_fields_fts
             JOIN note_fields nf ON nf.rowid = note_fields_fts.rowid
             JOIN notebook_fields f ON f.id = nf.field_id
             JOIN notes n ON n.id = nf.note_id
            WHERE (SELECT COUNT(DISTINCT id) FROM early) < ?2
              AND note_fields_fts MATCH ?1
              AND +n.deleted_at IS NULL
              AND n.id NOT IN (SELECT id FROM early)
              ${scoped}
            ORDER BY note_fields_fts.rank
            LIMIT ?2 * ${SEARCH_OVERFETCH}
         ),
         earlier AS MATERIALIZED (
           SELECT * FROM early UNION ALL SELECT * FROM field_hits
         ),
         file_hits AS (
           SELECT ${tierColumns('file', 'n', 'vtab')}
             FROM attachment_text_fts
             JOIN attachment_text at ON at.rowid = attachment_text_fts.rowid
             JOIN notes n ON n.id = at.note_id
            WHERE (SELECT COUNT(DISTINCT id) FROM earlier) < ?2
              AND attachment_text_fts MATCH ?1
              AND +n.deleted_at IS NULL
              AND n.id NOT IN (SELECT id FROM earlier)
              ${scoped}
            ORDER BY attachment_text_fts.rank
            LIMIT ?2 * ${SEARCH_OVERFETCH}
         ),
         combined AS (
           SELECT * FROM earlier UNION ALL SELECT * FROM file_hits
         ),
         best AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY tier, rank) AS place
             FROM combined
         )
         SELECT id, title, updated_at, snippet, matched_file, matched_field, matched_tag,
                tier, rank
           FROM best
          WHERE place = 1
          ORDER BY tier, rank, id
          LIMIT ?2`,
        ...binds,
      )
      .map(toSearchResult);
  }

  /**
   * Whether a search's notebook or tag filter names few enough notes to search them one by
   * one — see `scopeDrivenSearchSql`. Read from the stored counts, so it costs a row per
   * filter. A name that does not exist counts as empty, which the scope-driven query then
   * answers by reading nothing. Field and date filters have no stored size and leave the
   * search FTS-driven.
   */
  private searchScopeIsSmall(filters: { tags?: string[] | undefined; notebook?: string | undefined }, max: number): boolean {
    const binds: Bind[] = [];
    const sizes: string[] = [];
    if (filters.notebook === UNFILED) {
      sizes.push('(SELECT unfiled FROM note_counts WHERE id = 1)');
    } else if (filters.notebook) {
      binds.push(filters.notebook);
      sizes.push(`(SELECT note_count FROM notebooks WHERE name = ?${binds.length} COLLATE NOCASE)`);
    }
    for (const tag of filters.tags ?? []) {
      binds.push(tag);
      sizes.push(`(SELECT note_count FROM tags WHERE name = ?${binds.length})`);
    }
    if (sizes.length === 0) return false;

    const row = this.sql.first<{ size: number }>(
      `SELECT MIN(${sizes.map((s) => `COALESCE(${s}, 0)`).join(', ')}) AS size`,
      ...binds,
    );
    return (row?.size ?? 0) <= max;
  }

  /**
   * Permanently removes notes, with their tags and attachment rows — up to `limit` of
   * them, whichever the index yields first, and says how many the scope still holds.
   *
   * Distinct from `remove`, which is a soft delete the user can undo. This is the
   * irreversible one, so it returns the R2 keys it orphaned rather than deleting blobs
   * itself — the caller sweeps them, and a failure there leaves recoverable garbage
   * rather than a half-deleted note.
   *
   * `scope: 'trashed'` empties the trash; `scope: 'all'` wipes the account's notes.
   *
   * A page at a time, still. The object has no round trips to count, but a page bounds
   * the work one request does inside the single writer every other request for this
   * account waits behind, and the R2 delete after it takes a thousand keys a call. The
   * client calls until `remaining` is zero.
   *
   * Emptying the trash re-checks `deleted_at` on the DELETE, the way `purgeMany` does: a
   * restore between listing the trash and destroying it must leave the note, not take a
   * live note with it. `scope: 'all'` is a wipe, so it still deletes whatever it named.
   *
   * The keys are read by id, in the same runs the deletes use, before them — since the
   * rows go with the cascade. That reads only the page's notes: a lookup by scope read
   * every attachment on the account, or every trashed note, on every page.
   */
  purge(scope: 'trashed' | 'all', limit = PURGE_PAGE): { notes: number; keys: string[]; remaining: number } {
    return this.sql.tx(() => {
      // In no order: any page will do, and ordering by id had the planner sort every id
      // in the scope on every call, 13k rows a page at 13k notes. The index it walks
      // stops at the limit.
      const idRows = this.sql.exec<{ id: string }>(
        scope === 'trashed'
          ? `SELECT id FROM notes WHERE deleted_at IS NOT NULL LIMIT ?1`
          : `SELECT id FROM notes LIMIT ?1`,
        limit,
      );
      if (idRows.length === 0) {
        this.sweepAfterPurge();
        return { notes: 0, keys: [], remaining: 0 };
      }

      const stillTrashed = scope === 'trashed' ? '+deleted_at IS NOT NULL AND ' : '';
      const keyRows: Array<{ r2_key: string; note_id: string }> = [];
      const deletedIds: string[] = [];
      for (const run of runs(idRows.map((r) => r.id), 99)) {
        keyRows.push(
          ...this.sql.exec<{ r2_key: string; note_id: string }>(
            `SELECT a.r2_key, a.note_id FROM attachments a
              WHERE a.note_id IN (${placeholders(1, run.length)})`,
            ...run,
          ),
        );
        deletedIds.push(
          ...this.sql
            .exec<{ id: string }>(
              `DELETE FROM notes WHERE ${stillTrashed}id IN (${placeholders(1, run.length)})
               RETURNING id`,
              ...run,
            )
            .map((r) => r.id),
        );
      }

      this.feed.record(deletedIds.map((id) => ({ entity: 'note', id, deleted: true })));

      // Whether the scope is exhausted comes from what this page saw, not from the stored
      // counts. A short page means the query ran out of notes; a full one means there may be
      // more. The counts only supply the number the client shows, and they can drift —
      // `recount-notes` exists for that — so trusting them to end the loop could stop it
      // with notes left (counts low) or leave a last call that finds nothing and never
      // sweeps (counts high). A full page always reports at least one more, and the call
      // after it, finding nothing, answers zero and sweeps.
      const remaining = idRows.length < limit ? 0 : Math.max(1, this.purgeRemaining(scope));

      // The sweeps once the scope is empty rather than on every page: tag rows survive
      // their notes, and field definitions kept alive only by values on these notes; both
      // walk the whole table, and neither is needed until the end.
      if (remaining === 0) this.sweepAfterPurge();

      return { notes: deletedIds.length, keys: keysOfDeletedNotes(keyRows, deletedIds), remaining };
    });
  }

  /**
   * What a purge leaves behind once its scope is empty: tags no note carries any more, and
   * tombstoned field definitions whose last values went with the notes. Run on the last
   * page, and also on a call that found nothing — the page before it was full, so it did
   * not know it was the last.
   */
  private sweepAfterPurge(): void {
    const gone = this.sql.exec<{ id: string }>(`DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags) RETURNING id`);
    this.feed.record(gone.map((r) => ({ entity: 'tag', id: r.id, deleted: true })));
    // Tombstoned definitions are not in the feed: their notebook's tombstone already
    // told every client to drop them, and nothing lists them after that.
    this.sweepTombstonedFields();
  }

  /** How many notes a purge of `scope` would still find, from the stored counts. */
  private purgeRemaining(scope: 'trashed' | 'all'): number {
    const row = this.totals();
    return scope === 'trashed' ? row.trashed : row.live + row.trashed;
  }

  // --- Tags ---------------------------------------------------------------------------

  /**
   * Every tag in use, with note counts, most-used first.
   *
   * Ordered by count rather than by name because an imported archive's tag list is long
   * and desperately lopsided: this one has 326 tags, of which nearly half are on three
   * notes or fewer, and the ten most-used cover most of what anyone actually filters by.
   * Alphabetically the first screen is whatever begins with a digit or a dot — the
   * deadest tags in the account — and the useful ones are hundreds of rows down.
   *
   * Name breaks ties, so the long tail of once-used tags is still ordered predictably
   * rather than by whatever the query planner returns.
   */
  listTags(): Array<{ id: string; name: string; count: number }> {
    // The count is the triggers', one row per tag. A tag whose notes are all in the trash
    // has a count of zero and is left out, as it was when this joined the notes to count.
    return this.sql.exec<{ id: string; name: string; count: number }>(
      `SELECT id, name, note_count AS count
         FROM tags
        WHERE note_count > 0
        ORDER BY note_count DESC, name COLLATE NOCASE`,
    );
  }

  /**
   * The tags carried by the live notes of one set, with how many of that set carry each,
   * most-used first: "what else do the notes in Coupons carry", or "what do the notes
   * tagged Receipts also carry".
   *
   * The set is a notebook, a list of tags the note must carry all of, or both, with the
   * semantics `list` gives them — the same `filterConditions`, so a count here is the
   * number of notes that list would return under that tag. The tags that define the set
   * are left out of the answer: every note in it carries them, so they would head the
   * list with a count that says nothing. Tags with no live note in the set are not in it
   * at all, which a join makes true without being asked.
   *
   * Unlike `listTags` this cannot read the triggers' counts, which are per tag and say
   * nothing about a notebook: it walks the set's notes and their tag links, so it costs
   * about the size of the set — a notebook of six hundred reads on the order of a
   * thousand and a small one reads dozens. Never periodic, and never the unfiltered
   * call, which stays `listTags` at one row per tag.
   *
   * The CROSS JOINs fix the order: the notes first, by whichever filter is the way in,
   * then each one's links by the primary key, then the tag by id. Left to choose, the
   * planner is free to start from `note_tags` and read every link in the account, which
   * is what `+deleted_at` and `+n.notebook_id` (see `liveCondition`) exist to head off on
   * the notes' side. With a tag in the filter those two are hidden and the way in is the
   * tag's own links; with a notebook alone the per-notebook index is.
   */
  tagCounts(filter: {
    notebook?: string | undefined;
    tags?: string[] | undefined;
  }): Array<{ id: string; name: string; count: number }> {
    const binds: Bind[] = [];
    const conditions = [
      liveCondition(false, filter.tags),
      ...filterConditions({ tags: filter.tags, notebook: filter.notebook }, binds),
    ];
    const named = (filter.tags ?? []).map((name) => {
      binds.push(name);
      return `?${binds.length}`;
    });
    // Counted by tag id first and named after, so the tags table is read once per tag in
    // the set rather than once per link: a third of the reads for a notebook of notes
    // with one or two tags each.
    return this.sql.exec<{ id: string; name: string; count: number }>(
      `SELECT t.id, t.name, c.count
         FROM (SELECT nt.tag_id, COUNT(*) AS count
                 FROM notes n
                CROSS JOIN note_tags nt ON nt.note_id = n.id
                WHERE ${conditions.join(' AND ')}
                GROUP BY nt.tag_id) c
         JOIN tags t ON t.id = c.tag_id
        ${named.length > 0 ? `WHERE t.name NOT IN (${named.join(', ')})` : ''}
        ORDER BY c.count DESC, t.name COLLATE NOCASE`,
      ...binds,
    );
  }

  /**
   * A few titles from each notebook and each of the most-used tags, as examples of what is
   * filed where, for auto-fill to show the model beside each name; and those tags
   * themselves, since they are the ones auto-fill asks about.
   *
   * A notebook called "Misc" or a tag called "2019" says nothing on its own; three titles
   * from it say what a person has been putting there. Untitled notes and the note being
   * filed are left out — one has nothing to show and the other is the question.
   *
   * Each group reads its own few rows and stops. This was one window query per kind that
   * numbered every filed note and every tag link to keep three of each: 146k rows per
   * press at 13k notes, with examples built for every tag when only the most-used
   * `tagLimit` are ever asked about. In production that was 40% of a week's reads, and
   * on the day the quota ran out it was most of it. Now a notebook's examples walk
   * `idx_notes_notebook_updated` newest first and stop at `perGroup`, and a tag's walk
   * `idx_note_tags_tag` to the notes by primary key — 3.3k rows per press.
   *
   * Notebook examples are the most recent, which that index gives for free. Tag examples
   * are the first the tag's index reaches, which is note-id order: a stable sample rather
   * than the newest. The newest would mean reading every note of each of the tags to sort
   * them, 24k rows per press; three notes that carry a tag show what it means about as well
   * as the three newest do. The CROSS JOIN pins the tag side's order — left to itself the
   * planner starts from the notes and reads 186k. The tags are limited before their
   * examples are built, so the subquery runs for the kept tags only, whatever order their
   * names sort in.
   *
   * `tagLimit` is how many of the most-used tags to return. The caller asks for more than
   * it will use: auto-fill drops the tags the note already has before taking its cap.
   */
  sampleTitles(
    exclude: string,
    perGroup: number,
    tagLimit: number,
  ): {
    notebooks: Map<string, string[]>;
    tags: Array<{ id: string; name: string; examples: string[] }>;
  } {
    const byNotebook = this.sql.exec<{ id: string; titles: string | null }>(
      `SELECT nb.id,
              (SELECT json_group_array(title) FROM (
                 SELECT n.title FROM notes n
                  WHERE n.notebook_id = nb.id AND n.deleted_at IS NULL
                    AND n.title <> '' AND n.id <> ?1
                  ORDER BY n.updated_at DESC
                  LIMIT ?2)) AS titles
         FROM notebooks nb`,
      exclude,
      perGroup,
    );
    const byTag = this.sql.exec<{ id: string; name: string; titles: string | null }>(
      `SELECT t.id, t.name,
              (SELECT json_group_array(title) FROM (
                 SELECT n.title FROM note_tags nt
                  CROSS JOIN notes n ON n.id = nt.note_id
                  WHERE nt.tag_id = t.id AND n.deleted_at IS NULL
                    AND n.title <> '' AND n.id <> ?1
                  LIMIT ?2)) AS titles
         FROM (SELECT id, name, note_count AS count FROM tags
                WHERE note_count > 0
                ORDER BY note_count DESC, name COLLATE NOCASE
                LIMIT ?3) t
        ORDER BY t.count DESC, t.name COLLATE NOCASE`,
      exclude,
      perGroup,
      tagLimit,
    );
    const titles = (json: string | null) => (json ? (JSON.parse(json) as string[]) : []);
    return {
      notebooks: new Map(byNotebook.map((r) => [r.id, titles(r.titles)])),
      tags: byTag.map((r) => ({ id: r.id, name: r.name, examples: titles(r.titles) })),
    };
  }

  /**
   * Renames a tag; every note carrying it follows, because notes reference the row.
   *
   * A tag is addressed by id here for the same reason a notebook is: the id is stable
   * across the rename that is the whole point of the call. Names stay the interchange
   * format everywhere else — `?tag=` filters, frontmatter, the picker.
   *
   * When another tag already has the new name, the two are either kept apart (`conflict`,
   * the default) or merged: every note under this tag gains the other, duplicates
   * ignored, and this tag's row goes. Merging is what "rename Receipts to Receipt" means
   * when Receipt already exists, and it is the one operation an archive with hundreds of
   * near-duplicate tags actually needs — but it is also irreversible, so the client asks
   * before passing `merge`. Case is compared exactly, as the UNIQUE index does: "receipt"
   * and "Receipt" are two tags today, and a rename between them is a plain rename.
   *
   * Notes' `updated_at` is left alone, as `updateNotebook` leaves it: nothing about the
   * note's own content changed.
   */
  renameTag(
    id: string,
    name: string,
    opts?: { merge?: boolean | undefined },
  ): { id: string; name: string; merged: boolean } | 'conflict' | 'missing' {
    const trimmed = name.trim();
    if (!trimmed) return 'missing';

    return this.sql.tx(() => {
      const own = this.sql.first<{ name: string }>(`SELECT name FROM tags WHERE id = ?1`, id);
      if (!own) return 'missing';
      if (own.name === trimmed) return { id, name: trimmed, merged: false };

      const other = this.sql.first<{ id: string }>(`SELECT id FROM tags WHERE name = ?1 AND id <> ?2`, trimmed, id);

      if (!other) {
        this.sql.exec(`UPDATE tags SET name = ?1 WHERE id = ?2`, trimmed, id);
        // One row: a feed note carries its tags by id too, and the client looks the new
        // name up, as it does a notebook's. Naming every note under the tag instead was
        // the first shape, and a tag on an imported archive renamed would have sent every
        // device the archive again.
        this.feed.record([{ entity: 'tag', id }]);
        return { id, name: trimmed, merged: false };
      }

      if (!opts?.merge) return 'conflict';

      // A merge changes each note's tag ids — the old one goes, the other arrives — so
      // the notes are named here; bounded by the tag's note count, which the merge walks
      // anyway. Read before the join rows move.
      const carrying = this.notesCarrying(id);

      // One transaction, so a note can never be left with neither tag. The join rows are
      // moved by hand before the row goes, so the count triggers see each link leave and
      // arrive; the cascade would remove them too, but without the moved copies in place.
      this.sql.exec(
        `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
           SELECT note_id, ?1 FROM note_tags WHERE tag_id = ?2`,
        other.id,
        id,
      );
      this.sql.exec(`DELETE FROM note_tags WHERE tag_id = ?1`, id);
      this.sql.exec(`DELETE FROM tags WHERE id = ?1`, id);
      this.feed.record([{ entity: 'tag', id, deleted: true }, { entity: 'tag', id: other.id }, ...carrying]);
      return { id: other.id, name: trimmed, merged: true };
    });
  }

  /**
   * Deletes a tag, taking it off every note that carries it — trashed notes included, so
   * a restore cannot bring a deleted tag back. The notes themselves are untouched; a tag
   * is a label, and removing a label must never remove what it labelled.
   */
  deleteTag(id: string): boolean {
    return this.sql.tx(() => {
      const owned = this.sql.first(`SELECT 1 AS hit FROM tags WHERE id = ?1`, id);
      if (!owned) return false;
      this.sql.exec(`DELETE FROM note_tags WHERE tag_id = ?1`, id);
      this.sql.exec(`DELETE FROM tags WHERE id = ?1`, id);
      // The tombstone alone: a client drops the id from every note it holds, the way it
      // would drop a notebook's. See `renameTag` for why not a row per note.
      this.feed.record([{ entity: 'tag', id, deleted: true }]);
      return true;
    });
  }

  /** The feed rows for every note carrying a tag, trashed ones included: what a merge changes. */
  private notesCarrying(tagId: string): Change[] {
    return this.sql
      .exec<{ note_id: string }>(`SELECT note_id FROM note_tags WHERE tag_id = ?1`, tagId)
      .map((r) => ({ entity: 'note', id: r.note_id }));
  }

  // --- Notebooks ----------------------------------------------------------------------

  /**
   * How many notes sit in no notebook.
   *
   * Counted separately from `listNotebooks` because unfiled notes belong to no row there:
   * the scope selector needs the number to decide whether "Unfiled" is worth offering.
   */
  countUnfiledNotes(): number {
    return this.totals().unfiled;
  }

  /**
   * Every notebook, with note and field counts, for the sidebar scope selector and the
   * management page.
   */
  listNotebooks(): NotebookSummary[] {
    /*
     * The note count is the triggers', kept on the notebook row as its notes come and go.
     * It was counted here, which read every filed note on every sidebar load — and the
     * web editor reloaded the sidebar on every save.
     */
    return this.sql.exec<NotebookSummary>(
      `SELECT nb.id, nb.name, nb.purpose, nb.emoji, nb.note_count AS count,
              (SELECT COUNT(*) FROM notebook_fields f
                WHERE f.notebook_id = nb.id AND f.deleted_at IS NULL) AS fields
         FROM notebooks nb
        ORDER BY nb.name COLLATE NOCASE`,
    );
  }

  /**
   * Notebooks by id with their live field definitions, for the feed. Every notebook when
   * `ids` is null — the snapshot's first page — since a library has a handful. The
   * definitions come in one query over the ids rather than one per notebook, in display
   * order, and are dealt out after. No counts; see `FeedNotebook`.
   */
  notebooksWhole(ids: string[] | null): FeedNotebook[] {
    const runsOf = ids === null ? [null] : runs([...new Set(ids)]);
    const out: FeedNotebook[] = [];
    for (const run of runsOf) {
      const where = run ? `WHERE nb.id IN (${placeholders(1, run.length)})` : '';
      const notebooks = this.sql.exec<Omit<FeedNotebook, 'fieldDefs'>>(
        `SELECT nb.id, nb.name, nb.purpose, nb.emoji
           FROM notebooks nb ${where}
          ORDER BY nb.name COLLATE NOCASE`,
        ...(run ?? []),
      );
      const byId = new Map(notebooks.map((nb) => [nb.id, { ...nb, fieldDefs: [] as FieldDef[] }]));
      const fieldWhere = run ? `AND f.notebook_id IN (${placeholders(1, run.length)})` : '';
      for (const row of this.sql.exec<FieldRow>(
        `SELECT f.id, f.notebook_id, f.name, f.type, f.options, f.scale_max, f.scale_step, f.currency, f.position
           FROM notebook_fields f
          WHERE f.deleted_at IS NULL ${fieldWhere}
          ORDER BY f.notebook_id, f.position`,
        ...(run ?? []),
      )) {
        byId.get(row.notebook_id)?.fieldDefs.push(rowToField(row));
      }
      out.push(...byId.values());
    }
    return out;
  }

  /** Tags by id, or every tag when `ids` is null. No count; see `FeedTag`. */
  tagsWhole(ids: string[] | null): FeedTag[] {
    const runsOf = ids === null ? [null] : runs([...new Set(ids)]);
    const out: FeedTag[] = [];
    for (const run of runsOf) {
      out.push(
        ...this.sql.exec<FeedTag>(
          `SELECT id, name FROM tags ${run ? `WHERE id IN (${placeholders(1, run.length)})` : ''} ORDER BY name`,
          ...(run ?? []),
        ),
      );
    }
    return out;
  }

  /**
   * Maps a notebook name to its id, creating the notebook if it is new.
   *
   * Get-or-create rather than reject: filing a note into a notebook that does not exist yet
   * is the ordinary way notebooks come into being, both from the editor and from an import.
   * The lookup is case-insensitive and runs after the insert, so a name differing only in
   * case resolves to the notebook that already exists rather than failing on the unique
   * constraint.
   */
  private resolveNotebook(name: string | null | undefined): string | null {
    const trimmed = name?.trim();
    if (!trimmed) return null;

    const created = this.sql.exec<{ id: string }>(
      `INSERT INTO notebooks (id, name, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO NOTHING RETURNING id`,
      crypto.randomUUID(),
      trimmed,
      Date.now(),
    );
    // A notebook that came into being here is as much a change as one made by name.
    this.feed.record(created.map((r) => ({ entity: 'notebook', id: r.id })));
    const row = this.sql.first<{ id: string }>(`SELECT id FROM notebooks WHERE name = ?1 COLLATE NOCASE`, trimmed);
    return row?.id ?? null;
  }

  /** Creates an empty notebook. Returns null when the name is already taken. */
  createNotebook(name: string): { id: string; name: string } | null {
    const trimmed = name.trim();
    if (!trimmed) return null;

    return this.sql.tx(() => {
      // RETURNING says whether the row went in: nothing back means the name already exists,
      // case-insensitively, and the conflict target is the NOCASE unique (measured).
      const inserted = this.sql.exec<{ id: string; name: string }>(
        `INSERT INTO notebooks (id, name, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO NOTHING RETURNING id, name`,
        crypto.randomUUID(),
        trimmed,
        Date.now(),
      );
      this.feed.record(inserted.map((r) => ({ entity: 'notebook', id: r.id })));
      return inserted[0] ?? null;
    });
  }

  /**
   * Updates a notebook's name, purpose and/or emoji. Returns 'conflict' when a new name is
   * already taken by another notebook, case-insensitively.
   *
   * When `name` is given, every note follows automatically because they reference the id —
   * the rename is a single row update, which is the point of the notebook being an entity at
   * all. `purpose` or `emoji` given as `null` clears it. An omitted key is left untouched, so
   * the same method serves the rename-only path (route, MCP), the purpose editor and the
   * emoji picker without any of them disturbing another's column.
   */
  updateNotebook(
    id: string,
    patch: { name?: string | undefined; purpose?: string | null | undefined; emoji?: string | null | undefined },
  ): 'ok' | 'conflict' | 'missing' {
    return this.sql.tx(() => {
      const sets: string[] = [];
      const binds: Bind[] = [];

      if (patch.name !== undefined) {
        const trimmed = patch.name.trim();
        if (!trimmed) return 'missing';

        const clash = this.sql.first(
          `SELECT 1 AS hit FROM notebooks WHERE name = ?1 COLLATE NOCASE AND id <> ?2`,
          trimmed,
          id,
        );
        if (clash) return 'conflict';

        binds.push(trimmed);
        sets.push(`name = ?${binds.length}`);
      }

      if (patch.purpose !== undefined) {
        binds.push(patch.purpose);
        sets.push(`purpose = ?${binds.length}`);
      }

      if (patch.emoji !== undefined) {
        binds.push(patch.emoji);
        sets.push(`emoji = ?${binds.length}`);
      }

      // Nothing to change: still tell the caller whether the notebook exists, so a PATCH
      // with an empty body 404s on a bad id rather than silently reporting success.
      if (sets.length === 0) {
        return this.sql.first(`SELECT 1 AS hit FROM notebooks WHERE id = ?1`, id) ? 'ok' : 'missing';
      }

      binds.push(id);
      const changed = this.sql.exec<{ id: string }>(
        `UPDATE notebooks SET ${sets.join(', ')} WHERE id = ?${binds.length} RETURNING id`,
        ...binds,
      );
      // The notebook alone: its notes refer to it by id, and a client joins the name.
      this.feed.record(changed.map((r) => ({ entity: 'notebook', id: r.id })));
      return changed.length > 0 ? 'ok' : 'missing';
    });
  }

  /**
   * Deletes a notebook.
   *
   * Default: notes survive, unfiled. With `trashNotes`, live notes in the notebook are
   * soft-deleted into the trash (already-trashed ones keep their `deleted_at`) and then
   * unfiled — restoring later must not point at a notebook that no longer exists.
   *
   * Notes are unfiled explicitly rather than left to `ON DELETE SET NULL`, although the
   * cascade is real here: the trash branch has to touch the rows anyway, and one shape
   * for both branches keeps the count triggers' work identical either way. One
   * transaction, so a note can never be left pointing at a notebook row that is gone.
   *
   * No value is destroyed, whichever branch runs. The field definitions are tombstoned
   * rather than deleted, so every value keyed to them stays readable on the note that
   * holds it — including on a note cascaded to the trash, which is what makes that
   * cascade the recoverable operation its button claims. The definitions carry the
   * notebook's name with them so the values keep their "from Coupons" label after this
   * row is gone.
   *
   * Deleting the values here was the older behaviour and was wrong twice: it was scoped
   * by field rather than by note, so it also stripped notes that had left the notebook
   * long before, contradicting the promise that a note keeps the values it has when it
   * moves.
   */
  deleteNotebook(id: string, opts?: { trashNotes?: boolean | undefined }): boolean {
    return this.sql.tx(() => {
      const owned = this.sql.first(`SELECT 1 AS hit FROM notebooks WHERE id = ?1`, id);
      if (!owned) return false;

      const now = Date.now();
      const unfiled = opts?.trashNotes
        ? this.sql.exec<{ id: string }>(
            `UPDATE notes SET deleted_at = COALESCE(deleted_at, ?1), notebook_id = NULL WHERE notebook_id = ?2 RETURNING id`,
            now,
            id,
          )
        : this.sql.exec<{ id: string }>(`UPDATE notes SET notebook_id = NULL WHERE notebook_id = ?1 RETURNING id`, id);
      // The definitions are tombstoned rather than deleted, taking the notebook's name
      // with them: it is the label the values are read back with, and the row that
      // carried it is about to go. In the same transaction as that delete so a definition
      // is never briefly live with no notebook behind it.
      this.sql.exec(
        `UPDATE notebook_fields
            SET deleted_at = ?1,
                notebook_name = (SELECT name FROM notebooks WHERE id = ?2)
          WHERE notebook_id = ?2 AND deleted_at IS NULL`,
        now,
        id,
      );
      this.sql.exec(`DELETE FROM notebooks WHERE id = ?1`, id);

      // A notebook with no values to preserve leaves nothing worth keeping, so its
      // tombstones go at once rather than waiting for a note that will never reference them.
      this.sweepTombstonedFields();
      this.feed.record([
        { entity: 'notebook', id, deleted: true },
        ...unfiled.map((r) => ({ entity: 'note' as const, id: r.id })),
      ]);
      return true;
    });
  }

  /**
   * Drops tombstoned definitions no value refers to any more.
   *
   * A tombstone exists only to keep the values it keys readable — its name, its type, and
   * the notebook name they are labelled with. Once the last of those values is gone,
   * whether cleared from a note, purged with one, or never there at all, it is holding
   * nothing and goes. That is the whole lifecycle: no expiry, no UI, nothing for the
   * person to tidy up.
   *
   * Run after any delete that can drop the last reference. It is a single statement, and
   * a no-op when there is nothing to sweep.
   */
  private sweepTombstonedFields(): void {
    this.sql.exec(
      `DELETE FROM notebook_fields
        WHERE deleted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM note_fields nf WHERE nf.field_id = notebook_fields.id)`,
    );
  }

  // --- Custom fields -------------------------------------------------------------------

  /**
   * A notebook's field definitions in display order. Null when there is no such notebook,
   * so the route can answer 404 without a second query.
   *
   * `counts` adds how many notes hold a value for each field, which the management page
   * shows and names before a delete. Only on request: it reads every stored value of every
   * field — 6.3k rows for a 770-note notebook with nine fields, where the definitions
   * alone are 13 — and every other caller wanted the definitions. The note editor, the
   * list and MCP's writes all fetched it, so each note opened in such a notebook and each
   * card an assistant filled paid for counts nobody showed.
   *
   * Tombstones cannot reach here — the notebook they belonged to is gone, so the guard
   * above already answers null — but they are excluded explicitly so the query reads as
   * what it means rather than relying on that.
   */
  listFields(notebookId: string, { counts = false }: { counts?: boolean | undefined } = {}): FieldDef[] | null {
    const owned = this.sql.first(`SELECT 1 AS hit FROM notebooks WHERE id = ?1`, notebookId);
    if (!owned) return null;

    return this.sql
      .exec<FieldRow>(
        `SELECT f.id, f.notebook_id, f.name, f.type, f.options, f.scale_max, f.scale_step, f.currency, f.position
                ${counts ? ', (SELECT COUNT(*) FROM note_fields nf WHERE nf.field_id = f.id) AS value_count' : ''}
           FROM notebook_fields f
          WHERE f.notebook_id = ?1 AND f.deleted_at IS NULL
          ORDER BY f.position`,
        notebookId,
      )
      .map(rowToField);
  }

  /**
   * One field definition by id, or null. Resolved by the list route so a sort by a field
   * is built from its type and an unknown id is a 400 before any note is read.
   *
   * A tombstone answers null: sorting or filtering by a field whose notebook was deleted
   * is a 400, the same as an id that never existed. The values it still keys are readable
   * on the notes that hold them, but it is no longer something to query by.
   */
  fieldById(id: string): FieldDef | null {
    const row = this.sql.first<FieldRow>(
      `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
         FROM notebook_fields WHERE id = ?1 AND deleted_at IS NULL`,
      id,
    );
    return row ? rowToField(row) : null;
  }

  /**
   * Every field defined, across notebooks, for a listing that shows them all. Tombstones
   * are excluded: their notebook is gone, so there is nothing to list them under.
   */
  listAllFields(): FieldDef[] {
    return this.sql
      .exec<FieldRow>(
        `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
           FROM notebook_fields WHERE deleted_at IS NULL
          ORDER BY notebook_id, position`,
      )
      .map(rowToField);
  }

  /**
   * Adds a field to a notebook, at the end.
   *
   * Names are checked before the insert rather than caught on the unique constraint so
   * the three outcomes stay distinct — a missing notebook, a taken name and a full
   * notebook each get their own status upstream.
   */
  createField(
    notebookId: string,
    input: {
      name: string;
      type: FieldType;
      options: string[];
      scale?: FieldScale | null | undefined;
      currency?: string | null | undefined;
    },
  ): FieldDef | 'missing' | 'conflict' | 'full' {
    return this.sql.tx(() => {
      const owned = this.sql.first(`SELECT 1 AS hit FROM notebooks WHERE id = ?1`, notebookId);
      if (!owned) return 'missing';

      const count = this.sql.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM notebook_fields WHERE notebook_id = ?1 AND deleted_at IS NULL`,
        notebookId,
      );
      if ((count?.n ?? 0) >= MAX_FIELDS_PER_NOTEBOOK) return 'full';

      const clash = this.sql.first(
        `SELECT 1 AS hit FROM notebook_fields
          WHERE notebook_id = ?1 AND name = ?2 COLLATE NOCASE AND deleted_at IS NULL`,
        notebookId,
        input.name,
      );
      if (clash) return 'conflict';

      const id = crypto.randomUUID();
      const scale = scaleColumns(input.type, input.scale);
      this.sql.exec(
        `INSERT INTO notebook_fields
           (id, notebook_id, name, type, options, scale_max, scale_step, currency, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM notebook_fields
                   WHERE notebook_id = ?2 AND deleted_at IS NULL),
                 ?9)`,
        id,
        notebookId,
        input.name,
        input.type,
        optionsColumn(input.type, input.options),
        scale.max,
        scale.step,
        currencyColumn(input.type, input.scale, input.currency),
        Date.now(),
      );

      // A notebook row covers its definitions, so a field change is a notebook change.
      this.feed.record([{ entity: 'notebook', id: notebookId }]);
      return this.getField(notebookId, id) ?? 'missing';
    });
  }

  /**
   * Renames a field, replaces its options, changes its type, or re-scales a rating.
   *
   * A type change converts the values first (see `convertFieldValues`) and reports how
   * many it had to clear. Converting to `select` seeds the options from the existing
   * values, which then take precedence over any options in the same patch: a caller
   * cannot both pick a new type and hand-write an option list that would orphan values.
   *
   * Tightening a scale converts too, and for the same reason: dropping a rating from 10 to
   * 5 cannot keep a 7, and dropping half steps cannot keep a 3.5. Those are cleared and
   * counted in `cleared`, exactly as a type change's casualties are, so one confirmation
   * covers both. Widening keeps everything, because every value legal on the old scale is
   * legal on the wider one.
   */
  updateField(
    notebookId: string,
    fieldId: string,
    patch: {
      name?: string | undefined;
      type?: FieldType | undefined;
      options?: string[] | undefined;
      scale?: FieldScale | null | undefined;
      currency?: string | null | undefined;
    },
  ): { field: FieldDef; cleared: number } | 'missing' | 'conflict' {
    return this.sql.tx(() => {
      const current = this.getField(notebookId, fieldId);
      if (!current) return 'missing';

      if (patch.name !== undefined && patch.name.toLowerCase() !== current.name.toLowerCase()) {
        const clash = this.sql.first(
          `SELECT 1 AS hit FROM notebook_fields
            WHERE notebook_id = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3
              AND deleted_at IS NULL`,
          notebookId,
          patch.name,
          fieldId,
        );
        if (clash) return 'conflict';
      }

      let options = patch.options ?? current.options;
      let cleared = 0;
      let touched: Change[] = [];
      const type = patch.type ?? current.type;
      // `undefined` leaves the scale alone; `null` clears it back to a plain number.
      const scale = patch.scale === undefined ? current.scale : patch.scale;
      const stored = scaleColumns(type, scale);
      // The same rule: absent leaves it, null clears it. Display only, so nothing to convert.
      const currency = currencyColumn(
        type,
        scale,
        patch.currency === undefined ? current.currency : patch.currency,
      );
      if (type !== current.type || scaleTightens(current.scale, stored)) {
        const converted = this.convertFieldValues(fieldId, current.type, type, scale);
        cleared = converted.cleared;
        touched = converted.touched;
        if (converted.seededOptions) options = converted.seededOptions;
      }

      this.sql.exec(
        `UPDATE notebook_fields
            SET name = ?1, type = ?2, options = ?3, scale_max = ?4, scale_step = ?5, currency = ?6
          WHERE id = ?7 AND notebook_id = ?8`,
        patch.name ?? current.name,
        type,
        optionsColumn(type, options),
        stored.max,
        stored.step,
        currency,
        fieldId,
        notebookId,
      );

      // The definition's notebook, and every note whose stored value the conversion
      // rewrote or cleared: their rendered values changed without a write of their own.
      this.feed.record([{ entity: 'notebook', id: notebookId }, ...touched]);
      const field = this.getField(notebookId, fieldId);
      return field ? { field, cleared } : 'missing';
    });
  }

  /**
   * What a type change would do, without doing it. The same plan the write uses, so the
   * number the confirmation names is the number that will be cleared.
   *
   * `'fit'` asks for the rating scale the field's own values suggest (`fitRatingScale`),
   * and the answer names the scale it chose so the write can send exactly that one. It is
   * answered here rather than by the client because the values are here: the editor holds
   * the field's definition, not every note's value for it.
   */
  previewConversion(
    notebookId: string,
    fieldId: string,
    to: FieldType,
    toScale?: FieldScale | null | 'fit' | undefined,
  ): { values: number; incompatible: number; scale: FieldScale | null } | null {
    const field = this.getField(notebookId, fieldId);
    if (!field) return null;
    const rows = this.fieldValueRows(fieldId);
    // Matches `updateField`: an absent scale in the patch means the current one stands, so
    // previewing a rename or a pure type change does not silently unbound the field.
    const scale =
      toScale === 'fit'
        ? fitRatingScale(field.type, rows)
        : toScale === undefined
          ? field.scale
          : toScale;
    const plan = planConversion(field.type, to, rows, scale);
    return { values: rows.length, incompatible: plan.drop.length, scale };
  }

  /** Sets a notebook's field order. `ids` must be exactly its fields, each once. */
  reorderFields(notebookId: string, ids: string[]): boolean {
    return this.sql.tx(() => {
      const have = new Set(
        this.sql
          .exec<{ id: string }>(
            `SELECT id FROM notebook_fields WHERE notebook_id = ?1 AND deleted_at IS NULL`,
            notebookId,
          )
          .map((r) => r.id),
      );
      if (have.size === 0 || have.size !== ids.length || !ids.every((id) => have.has(id))) {
        return false;
      }
      if (new Set(ids).size !== ids.length) return false;

      ids.forEach((id, position) => {
        this.sql.exec(`UPDATE notebook_fields SET position = ?1 WHERE id = ?2`, position, id);
      });
      this.feed.record([{ entity: 'notebook', id: notebookId }]);
      return true;
    });
  }

  /**
   * Deletes a field and every value held under it.
   *
   * The values go explicitly, in the same transaction, although the cascade from
   * `notebook_fields` would take them: written out, the statement says what the delete
   * means, and it does not depend on the reader knowing the schema's clauses are live.
   */
  deleteField(notebookId: string, fieldId: string): boolean {
    return this.sql.tx(() => {
      const field = this.getField(notebookId, fieldId);
      if (!field) return false;
      const held = this.sql.exec<{ note_id: string }>(`DELETE FROM note_fields WHERE field_id = ?1 RETURNING note_id`, fieldId);
      this.sql.exec(`DELETE FROM notebook_fields WHERE id = ?1`, fieldId);
      this.feed.record([
        { entity: 'notebook', id: notebookId },
        ...held.map((r) => ({ entity: 'note' as const, id: r.note_id })),
      ]);
      return true;
    });
  }

  /**
   * How many notes hold `option` on this select or multi-select field.
   *
   * A select stores the option as the whole `value_text`; a multi-select stores a JSON
   * list, so the option is a member of that list. This is the same distinction the note
   * filter's `eq` op draws, and it is drawn the same way here — the plain compare first,
   * then `json_each` guarded by `json_valid` so it never runs on a select's bare text.
   *
   * Null when the field is not one with options, so the caller can tell "no such field"
   * (or wrong type) from "an option no note uses", which is `0`.
   */
  countOptionUsage(notebookId: string, fieldId: string, option: string): number | null {
    const field = this.getField(notebookId, fieldId);
    if (!field || !fieldHasOptions(field.type)) return null;

    const row = this.sql.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM note_fields
        WHERE field_id = ?1
          AND (value_text = ?2 OR (json_valid(value_text)
               AND json_type(value_text) = 'array'
               AND EXISTS (SELECT 1 FROM json_each(value_text) WHERE json_each.value = ?2)))`,
      fieldId,
      option,
    );
    return row?.n ?? 0;
  }

  /**
   * Removes an option from a select or multi-select, optionally taking it off the notes
   * that hold it.
   *
   * The default leaves those values in place — a select that no longer lists the option
   * still shows it as "(no longer an option)", and nothing about the note changes. That
   * is the whole point of keeping a stored value legible after its option is gone, and it
   * is what this method does when `clear` is false. Removing the option from the list is
   * done by rewriting the field's options, the same path the options editor takes.
   *
   * With `clear`, the value is also removed from every note that held it — a deliberate
   * cleanup, confirmed by name and count in the UI, not a silent side effect of tidying
   * the list. A select's value is the option itself, so the whole row goes; a
   * multi-select's is one member of a list, so the member is dropped and the row deleted
   * only when nothing is left, the same rule an emptied multi-select follows.
   *
   * Returns the count of notes whose value changed, or null when there is no such field
   * or the option is not one it has (so a stale client cannot report a phantom cleanup).
   */
  removeFieldOption(
    notebookId: string,
    fieldId: string,
    option: string,
    clear: boolean,
  ): { field: FieldDef; cleared: number } | null {
    return this.sql.tx(() => {
      const field = this.getField(notebookId, fieldId);
      if (!field || !fieldHasOptions(field.type)) return null;
      if (!field.options.includes(option)) return null;

      let cleared = 0;
      const touched: Change[] = [];
      if (clear) {
        for (const { noteId, text } of this.fieldValueRows(fieldId)) {
          // A multi-select stores a JSON list; a select stores the bare option. Only rows
          // that actually hold the option are touched, so an unrelated value is never
          // rewritten (which would bump its row for no reason).
          if (field.type === 'multiselect' && isJsonArray(text)) {
            const list = JSON.parse(text) as string[];
            if (!list.includes(option)) continue;
            const remaining = list.filter((o) => o !== option);
            if (remaining.length === 0) {
              this.sql.exec(`DELETE FROM note_fields WHERE note_id = ?1 AND field_id = ?2`, noteId, fieldId);
            } else {
              this.sql.exec(
                `UPDATE note_fields SET value_text = ?1 WHERE note_id = ?2 AND field_id = ?3`,
                JSON.stringify(remaining),
                noteId,
                fieldId,
              );
            }
            cleared += 1;
            touched.push({ entity: 'note', id: noteId });
          } else if (text === option) {
            this.sql.exec(`DELETE FROM note_fields WHERE note_id = ?1 AND field_id = ?2`, noteId, fieldId);
            cleared += 1;
            touched.push({ entity: 'note', id: noteId });
          }
        }
      }

      // The notebook itself is recorded by `updateField` below.
      this.feed.record(touched);
      const updated = this.updateField(notebookId, fieldId, {
        options: field.options.filter((o) => o !== option),
      });
      if (typeof updated === 'string') return null;
      return { field: updated.field, cleared };
    });
  }

  private getField(notebookId: string, fieldId: string): FieldDef | null {
    const row = this.sql.first<FieldRow>(
      `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
         FROM notebook_fields
        WHERE id = ?1 AND notebook_id = ?2 AND deleted_at IS NULL`,
      fieldId,
      notebookId,
    );
    return row ? rowToField(row) : null;
  }

  private fieldValueRows(fieldId: string): Array<{ noteId: string; text: string }> {
    return this.sql
      .exec<{ note_id: string; value_text: string }>(
        `SELECT note_id, value_text FROM note_fields WHERE field_id = ?1`,
        fieldId,
      )
      .map((r) => ({ noteId: r.note_id, text: r.value_text }));
  }

  /**
   * Rewrites a field's stored values for a new type.
   *
   * Done here rather than in SQL because SQLite cannot be trusted to say whether text is
   * a number — `CAST('abc' AS REAL)` is 0.0, not an error. The rows are read, planned by
   * the shared codec, and written back inside the caller's transaction, so a conversion
   * either lands whole or not at all.
   */
  private convertFieldValues(
    fieldId: string,
    from: FieldType,
    to: FieldType,
    toScale?: FieldScale | null | undefined,
  ): { cleared: number; touched: Change[]; seededOptions?: string[] } {
    const rows = this.fieldValueRows(fieldId);
    const plan = planConversion(from, to, rows, toScale);

    for (const k of plan.keep) {
      this.sql.exec(
        `UPDATE note_fields SET value_text = ?1, value_num = ?2 WHERE note_id = ?3 AND field_id = ?4`,
        k.text,
        k.num,
        k.row.noteId,
        fieldId,
      );
    }
    for (const r of plan.drop) {
      this.sql.exec(`DELETE FROM note_fields WHERE note_id = ?1 AND field_id = ?2`, r.noteId, fieldId);
    }

    return {
      cleared: plan.drop.length,
      touched: [...plan.keep.map((k) => k.row.noteId), ...plan.drop.map((r) => r.noteId)].map((id) => ({ entity: 'note', id })),
      ...(plan.seededOptions ? { seededOptions: plan.seededOptions } : {}),
    };
  }

  /**
   * Turns a values patch into the statements that apply it, validating every value first.
   *
   * Split from the write so that `update` can validate before it touches the note: a bad
   * value must fail the whole patch, not land after the title has already changed. Throws
   * `InvalidFieldValue` naming the field, which the route turns into a 400 and the MCP
   * tool into an error the model can correct. (The write is inside a transaction now, so
   * a throw would roll the title back too; validating first is kept because it is the
   * cheaper order and because the error should be about the value, not about a rollback.)
   *
   * A field id from another account's notebook is reported exactly like one that does
   * not exist — no such row is in this database — so an id from elsewhere confirms nothing.
   *
   * Merge semantics, unlike `setTags`: only the keys in the patch change. The editor sends
   * every field anyway, and a caller setting one value should not have to know the rest.
   *
   * An option the list has dropped stays legal on notes that already hold it, for the
   * reason `withHeldOptions` gives: the editor resends every field, and failing that
   * resend would refuse the title and body too. Looked up here so a new choice that is not
   * in the list is still a 400. A value that is exactly what is stored is not written at
   * all — that resend is the common case, and a statement for it would only re-date the
   * note.
   *
   * Tombstoned definitions resolve here, deliberately, where every listing excludes them:
   * a value they key is still the note's own data, and clearing it is the only way to take
   * it off the note short of deleting the note. The editor shows such a value read-only
   * with a Clear, so the write that reaches this point is that Clear.
   *
   * The ids go in as one JSON array rather than a placeholder each. The engine binds at
   * most a hundred values, and the shared-database version of this bound the note id
   * beside a hundred field ids — a hundred-and-one, which the cap refuses; the limit on
   * the patch is kept as a sanity bound on the size of one change.
   */
  private prepareFieldWrites(noteId: string, patch: NoteFieldsPatch): Statement[] {
    const ids = Object.keys(patch);
    if (ids.length === 0) return [];
    if (ids.length > 100) throw new InvalidFieldValue('fields', 'Too many fields in one change');

    const defs = new Map(
      this.sql
        .exec<FieldRow>(
          `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
             FROM notebook_fields
            WHERE id IN (SELECT value FROM json_each(?1))`,
          JSON.stringify(ids),
        )
        .map((r) => [r.id, rowToField(r)]),
    );

    const held = new Map(
      this.sql
        .exec<{ field_id: string; value_text: string }>(
          `SELECT field_id, value_text FROM note_fields
            WHERE note_id = ?1 AND field_id IN (SELECT value FROM json_each(?2))`,
          noteId,
          JSON.stringify(ids),
        )
        .map((r) => [r.field_id, r.value_text]),
    );

    const statements: Statement[] = [];
    for (const id of ids) {
      const def = defs.get(id);
      if (!def) throw new InvalidFieldValue(id, 'No such field');

      const value = patch[id];
      const stored = held.get(id);
      const encoded =
        value === null || value === undefined
          ? 'clear'
          : encodeFieldValue(withHeldOptions(def, stored), value);
      if (encoded === null) throw new InvalidFieldValue(def.name, expectedFieldValue(def));
      if (encoded !== 'clear' && encoded.text === stored) continue;
      // A clear of a value the note does not hold writes nothing. `update` strips those
      // before it gets here (`changedKeysOnly`); a bulk call does not, and without this
      // every note it cleared a field on would be counted as changed and re-dated.
      if (encoded === 'clear' && stored === undefined) continue;

      statements.push(
        encoded === 'clear'
          ? [`DELETE FROM note_fields WHERE note_id = ?1 AND field_id = ?2`, [noteId, id]]
          : [
              `INSERT INTO note_fields (note_id, field_id, value_text, value_num)
               VALUES (?1, ?2, ?3, ?4)
               ON CONFLICT(note_id, field_id)
               DO UPDATE SET value_text = excluded.value_text, value_num = excluded.value_num`,
              [noteId, id, encoded.text, encoded.num],
            ],
      );
    }
    return statements;
  }

  /**
   * One notebook by the name a person or a model gives it, with its field definitions, or
   * null when there is none.
   *
   * For a caller that has a name and needs the ids behind it — a filter on the fields of
   * the notebook a list is scoped to — on every page of a walk. The overview answers the
   * same question and was what that caller used, but it reads every notebook, the count
   * of unfiled notes and every definition in the account to use one notebook's. Matched
   * as the list's own notebook filter matches, so a name that finds its fields here finds
   * its notes there.
   */
  notebookByName(name: string): { id: string; name: string; fields: FieldDef[] } | null {
    const row = this.sql.first<{ id: string; name: string }>(
      `SELECT id, name FROM notebooks WHERE name = ?1 COLLATE NOCASE`,
      name.trim(),
    );
    return row ? { id: row.id, name: row.name, fields: this.listFields(row.id) ?? [] } : null;
  }

  /**
   * Where a set of notes is filed, for a caller about to write field values to them by
   * name: which of the ids are live notes, the notebooks they are in with a count and one
   * note of each, and — when they are all in one — that notebook's field definitions.
   *
   * It exists so the question is asked of every note rather than guessed from one. A name
   * means nothing until it is known which notebook's field it names, and a caller that
   * read a single note to find out got an answer that depended on which note it happened
   * to read: an unfiled one among fifty filed ones said the field did not exist. One read
   * here, with the definitions in the same call, also replaces the three a caller made to
   * learn the same thing (see rule 5 in AGENTS.md: a call is a billable request).
   *
   * No definitions for a mixed set or an unfiled one: there is no notebook to resolve
   * against, and the caller's answer is to say so. A row a note, by primary key.
   */
  fieldTargets(ids: string[]): {
    matched: string[];
    notebooks: Array<{ id: string | null; name: string | null; notes: number; example: string }>;
    fields: FieldDef[];
  } {
    const matched: string[] = [];
    const notebooks = new Map<string | null, { id: string | null; name: string | null; notes: number; example: string }>();
    for (const run of runs([...new Set(ids)])) {
      const rows = this.sql.exec<{ id: string; notebook_id: string | null }>(
        `SELECT n.id, n.notebook_id
           FROM notes n
          WHERE +n.deleted_at IS NULL
            AND n.id IN (${placeholders(1, run.length)})`,
        ...run,
      );
      for (const r of rows) {
        matched.push(r.id);
        const seen = notebooks.get(r.notebook_id);
        if (seen) seen.notes += 1;
        else notebooks.set(r.notebook_id, { id: r.notebook_id, name: null, notes: 1, example: r.id });
      }
    }
    // Named after grouping, one read a notebook: joined to each note it was a read a
    // note, a third of the call for five hundred notes that share one notebook.
    for (const nb of notebooks.values()) {
      if (nb.id) nb.name = this.sql.first<{ name: string }>(`SELECT name FROM notebooks WHERE id = ?1`, nb.id)?.name ?? null;
    }
    const all = [...notebooks.values()];
    const only = all.length === 1 ? all[0]!.id : null;
    return { matched, notebooks: all, fields: only ? (this.listFields(only) ?? []) : [] };
  }

  /**
   * `prepareFieldWrites` for a set of notes: the statements for each note that has any,
   * after checking that every field belongs to the notebook each note will be in.
   *
   * The membership check reads the definitions once for the set; the per-note read is
   * `prepareFieldWrites`' own, so the validation and encoding stay one piece of code. A
   * tombstoned definition is not a member — its notebook is gone — so bulk writes can
   * neither set nor clear values left over from a deleted notebook, which a note's own
   * editor can still do one at a time.
   */
  private prepareBulkFieldWrites(
    notes: Array<{ id: string; notebookId: string | null }>,
    patch: NoteFieldsPatch,
  ): Map<string, Statement[]> {
    const ids = Object.keys(patch);
    if (ids.length > 100) throw new InvalidFieldValue('fields', 'Too many fields in one change');
    const owners = new Map(
      this.sql
        .exec<{ id: string; notebook_id: string; name: string }>(
          `SELECT id, notebook_id, name FROM notebook_fields
            WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?1))`,
          JSON.stringify(ids),
        )
        .map((r) => [r.id, r]),
    );
    for (const id of ids) if (!owners.has(id)) throw new InvalidFieldValue(id, 'No such field');

    for (const n of notes) {
      for (const id of ids) {
        const owner = owners.get(id)!;
        if (owner.notebook_id === n.notebookId) continue;
        const where = n.notebookId
          ? `the notebook "${this.sql.first<{ name: string }>(`SELECT name FROM notebooks WHERE id = ?1`, n.notebookId)?.name}", where note ${n.id} is filed`
          : `any notebook note ${n.id} is in, since it is in none`;
        throw new InvalidFieldValue(owner.name, `is not a field of ${where}`);
      }
    }

    const writes = new Map<string, Statement[]>();
    for (const n of notes) {
      const statements = this.prepareFieldWrites(n.id, patch);
      if (statements.length > 0) writes.set(n.id, statements);
    }
    return writes;
  }

  /** Runs statements built earlier, inside whatever transaction the caller holds. */
  private run(statements: Statement[]): void {
    for (const [sql, binds] of statements) this.sql.exec(sql, ...binds);
  }

  /**
   * Applies imported values, which arrive by field *name* — the interchange form.
   *
   * A name with no definition in the notebook creates one, typed from the value, so a
   * vault exported elsewhere lands with its properties intact; a list value makes a
   * multi-select with the list as its first options. An option a select or multi-select
   * lacks is added rather than the value dropped — see `addImportedOptions`. Anything
   * that still cannot be stored (a reserved name, a value the field's type cannot read, a
   * notebook already at its limit) is skipped and named, rather than failing the note: an
   * import is judged by what it kept. With `onlyMissing`, a value a note already holds is
   * left alone — the content-hash skip path restores what a deleted field lost without
   * undoing an edit.
   */
  private applyImportedFields(
    noteId: string,
    notebookId: string,
    fields: Record<string, FieldValue>,
    onlyMissing: boolean,
  ): { skipped: string[]; changed: boolean } {
    const skipped: string[] = [];
    let changed = false;
    for (const [rawName, value] of Object.entries(fields)) {
      const name = rawName.trim();
      if (!name || isReservedFieldName(name)) {
        skipped.push(rawName);
        continue;
      }

      const row = this.sql.first<FieldRow>(
        `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
           FROM notebook_fields
          WHERE notebook_id = ?1 AND name = ?2 COLLATE NOCASE AND deleted_at IS NULL`,
        notebookId,
        name,
      );
      let def = row ? rowToField(row) : null;

      if (!def) {
        const seeded = Array.isArray(value) ? fieldOptionsSchema.safeParse(value) : null;
        if (seeded && !seeded.success) {
          skipped.push(rawName);
          continue;
        }
        const created = this.createField(notebookId, {
          name,
          type: inferFieldType(value),
          options: seeded?.data ?? [],
        });
        if (typeof created === 'string') {
          skipped.push(rawName);
          continue;
        }
        def = created;
      }

      let encoded = encodeFieldValue(def, value);
      if (encoded === null && fieldHasOptions(def.type)) {
        const widened = this.addImportedOptions(notebookId, def, value);
        if (widened) {
          def = widened;
          encoded = encodeFieldValue(def, value);
        }
      }
      if (encoded === null || encoded === 'clear') {
        skipped.push(rawName);
        continue;
      }

      const written = this.sql.exec<{ note_id: string }>(
        `INSERT INTO note_fields (note_id, field_id, value_text, value_num)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(note_id, field_id) DO ${
           onlyMissing
             ? 'NOTHING'
             : 'UPDATE SET value_text = excluded.value_text, value_num = excluded.value_num'
         }
         RETURNING note_id`,
        noteId,
        def.id,
        encoded.text,
        encoded.num,
      );
      changed ||= written.length > 0;
    }
    return { skipped, changed };
  }

  /**
   * Adds the options an imported value needs to a select or multi-select, when it can.
   *
   * The rule `importNotebook` applies to a definitions file — add, never alter — applied
   * to a value: an option the notebook lacks is created rather than the value dropped.
   * That is what lets a vault written by hand, with no `notebooks/` file to declare its
   * options, land with its values intact, and what puts back an option that was pruned
   * after the export was taken. Nothing is removed and nothing retyped. Null when the list
   * is full or the value is not made of names an option can have, and the caller then
   * skips the value and says so.
   */
  private addImportedOptions(notebookId: string, def: FieldDef, value: FieldValue): FieldDef | null {
    const wanted = fieldOptionsSchema.safeParse(Array.isArray(value) ? value : [String(value)]);
    if (!wanted.success) return null;
    const missing = wanted.data.filter((o) => !def.options.includes(o));
    if (missing.length === 0 || def.options.length + missing.length > MAX_SELECT_OPTIONS) return null;
    const updated = this.updateField(notebookId, def.id, {
      options: [...def.options, ...missing],
    });
    return typeof updated === 'string' ? null : updated.field;
  }

  /**
   * Applies a notebook's definitions from an export's `notebooks/<slug>.yaml`, ahead of
   * the notes that will carry values for them.
   *
   * The rule is *add, never alter*. A field the notebook does not have is created as the
   * file describes it — that is the whole point, and how a URL comes back a URL and a
   * rating a rating. A field it already has keeps its type and its scale, because
   * changing either clears every value that cannot be read the new way, and an import is
   * not the place to decide that on someone's behalf; the mismatch is reported instead,
   * so the person can convert it themselves with the confirmation that step deserves.
   * The one merge is a select's or multi-select's options: the file's are added after the
   * notebook's own, which cannot lose anything and lets the incoming values land.
   *
   * Existing fields keep their positions and new ones append in file order, so a fresh
   * notebook comes out in exactly the exported order and an existing one is not shuffled
   * under the person who arranged it. The notebook itself is created if it is new.
   *
   * The emoji and the purpose follow the same rule: set when the notebook has none, which
   * covers every notebook this import just created, and otherwise left as they are. A
   * notebook someone has already given its own icon or its own guidance for Auto-fill has
   * had a decision made about it, and the archive's older one is reported rather than
   * written over it. Each comes back with a `kind` so the log can say which it was; a
   * skipped field has none, which is also what a server from before these keys sends.
   */
  importNotebook(definition: NotebookDefinition): {
    id: string;
    skipped: Array<{ name: string; reason: string; kind?: 'emoji' | 'purpose' }>;
  } {
    return this.sql.tx(() => {
      const notebookId = this.resolveNotebook(definition.name);
      if (!notebookId) throw new Error('Notebook name is empty');

      const skipped: Array<{ name: string; reason: string; kind?: 'emoji' | 'purpose' }> = [];

      if (definition.emoji || definition.purpose) {
        const current = this.sql.first<{ emoji: string | null; purpose: string | null }>(
          `SELECT emoji, purpose FROM notebooks WHERE id = ?1`,
          notebookId,
        );
        const patch: { emoji?: string; purpose?: string } = {};
        if (definition.emoji) {
          if (!current?.emoji) patch.emoji = definition.emoji;
          else if (current.emoji !== definition.emoji) {
            skipped.push({
              kind: 'emoji',
              name: definition.emoji,
              reason: `Already ${current.emoji} here; left as it is`,
            });
          }
        }
        if (definition.purpose) {
          if (!current?.purpose) patch.purpose = definition.purpose;
          else if (current.purpose !== definition.purpose) {
            skipped.push({
              kind: 'purpose',
              name: definition.purpose,
              reason: 'Already has a purpose of its own; left as it is',
            });
          }
        }
        if (patch.emoji || patch.purpose) this.updateNotebook(notebookId, patch);
      }

      const existing = this.listFields(notebookId) ?? [];
      const byName = new Map(existing.map((f) => [f.name.toLowerCase(), f]));

      for (const field of definition.fields) {
        const current = byName.get(field.name.toLowerCase());

        if (!current) {
          const created = this.createField(notebookId, {
            name: field.name,
            type: field.type,
            options: field.options ?? [],
            scale: field.scale ?? null,
            currency: field.currency ?? null,
          });
          if (created === 'full') {
            skipped.push({ name: field.name, reason: 'This notebook has as many fields as it can hold' });
          } else if (typeof created === 'string') {
            skipped.push({ name: field.name, reason: 'Could not be created' });
          } else {
            byName.set(field.name.toLowerCase(), created);
          }
          continue;
        }

        if (current.type !== field.type) {
          skipped.push({
            name: field.name,
            reason: `Already here as ${current.type}, not ${field.type}; left as it is`,
          });
          continue;
        }

        /*
           A currency is display only, so giving a plain number one clears nothing and is
           an add; a number already drawn in another currency is left as it is and said so,
           like a type. A rating never takes one.
        */
        if (field.currency && current.type === 'number' && !current.scale) {
          if (!current.currency) {
            const result = this.updateField(notebookId, current.id, { currency: field.currency });
            if (typeof result === 'string') {
              skipped.push({ name: field.name, reason: 'Currency could not be applied' });
            }
          } else if (current.currency !== field.currency) {
            skipped.push({
              name: field.name,
              reason: `Already here in ${current.currency}, not ${field.currency}; left as it is`,
            });
          }
        }

        if (fieldHasOptions(field.type)) {
          const have = new Set(current.options.map((o) => o.toLowerCase()));
          const added = (field.options ?? []).filter((o) => !have.has(o.toLowerCase()));
          if (added.length > 0) {
            const options = [...current.options, ...added].slice(0, MAX_SELECT_OPTIONS);
            const result = this.updateField(notebookId, current.id, { options });
            if (typeof result === 'string') {
              skipped.push({ name: field.name, reason: 'Options could not be added' });
            }
          }
        }
      }

      return { id: notebookId, skipped };
    });
  }

  /**
   * Replaces a note's tags. Callers must already have verified the note exists.
   *
   * Inside the caller's transaction, so a note is never observed with half its tags. Tag
   * rows are get-or-create; a tag whose last note lets it go keeps its row, since
   * `listTags` only shows tags with a live count and the purge sweeps the rest.
   */
  private setTags(noteId: string, tags: string[]): void {
    const unique = uniqueTags(tags);
    this.sql.exec(`DELETE FROM note_tags WHERE note_id = ?1`, noteId);
    for (const name of unique) {
      this.ensureTag(name);
      this.sql.exec(`INSERT INTO note_tags (note_id, tag_id) SELECT ?1, id FROM tags WHERE name = ?2`, noteId, name);
    }
  }

  /**
   * Get-or-create of a tag row by name, recording the row when it is new. The one place
   * tags come into being, so the feed cannot miss one: a tag's id is what a client
   * renames or deletes it by, and a note's tags are names, so the row has to arrive by
   * its own entry.
   */
  private ensureTag(name: string): void {
    const created = this.sql.exec<{ id: string }>(
      `INSERT INTO tags (id, name) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING RETURNING id`,
      crypto.randomUUID(),
      name,
    );
    this.feed.record(created.map((r) => ({ entity: 'tag', id: r.id })));
  }
}

/** A list row as the client sees it. */
function toSummary(r: SummaryRow): NoteSummary {
  const fields = decodeFieldsJson(r.fields, r.notebook_id);
  const attachments = decodeAttachmentsJson(r.attachments);
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    tags: splitTags(r.tags),
    notebook: r.notebook,
    notebookId: r.notebook_id,
    // Omitted when empty: most rows in a large archive have none, and a page of fifty
    // should not carry fifty empty arrays. Same for the files.
    ...(fields.length > 0 ? { fields } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    excerpt: excerptMarkdown(r.body),
    deletedAt: r.deleted_at ?? undefined,
  };
}
