import {
  decodeFieldValue,
  endOfDay,
  fieldRangeBound,
  fieldHasOptions,
  startOfDay,
  UNFILED,
  type FieldDef,
  type FieldFilter,
  type FieldScale,
  type FieldType,
  type FieldValue,
  type Note,
  type NoteFieldValue,
  type NoteSort,
  type NoteSummary,
  type SearchResult,
  fieldSortKey,
  fieldSortsNumerically,
  NOTE_FTS_WEIGHTS,
  SNIPPET_ARGS,
  toFtsQuery,
  foldNoCase,
} from '@unbent/shared';

// The query builder is shared with the web's local index; re-exported for the importers it has always had here.
export { toFtsQuery };

/**
 * The pure half of the notes repository: row shapes, SQL fragments, the search tiers, the
 * sort and cursor codec, and the small functions that turn rows into API objects.
 *
 * Nothing here touches a database. It is the part of `NotesRepo` that had no reason to
 * live beside the statements and every reason to be shared: the per-user store
 * (`store/notes.ts`) builds its queries from these, and the Worker-side facade in
 * `lib/notes-repo.ts` needs the cursor codec and the FTS query builder for the routes,
 * which import `nextCursor` and `toFtsQuery` from there as they always have.
 *
 * Everything in this file is written for the per-user database: no `user_id` anywhere,
 * because the database *is* the user. Where the shared-database version of a query had to
 * steer the planner away from a `user_id` index, the note is kept on the fragment and the
 * steering moved to the column that took its place on every index, `deleted_at`.
 */

export interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
  notebook: string | null;
  notebook_id: string | null;
}

/** A whole note with the names of its files: what one export page carries. */
export type ExportedNote = Note & Pick<NoteSummary, 'attachments'>;

export interface SummaryRow {
  id: string;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  notebook: string | null;
  notebook_id: string | null;
  tags: string | null;
  /** JSON array of `FieldJson`, from the correlated subquery in `list`. */
  fields: string | null;
  /** JSON array of `{filename, contentType}`, from the correlated subquery in `list`. */
  attachments: string | null;
}

export interface FieldRow {
  id: string;
  notebook_id: string;
  name: string;
  type: string;
  options: string | null;
  scale_max: number | null;
  scale_step: number | null;
  currency: string | null;
  position: number;
  value_count?: number;
}

/** One value as the list's `json_group_array` subquery emits it. */
export interface FieldJson {
  fieldId: string;
  name: string;
  type: string;
  text: string;
  scaleMax: number | null;
  scaleStep: number | null;
  currency: string | null;
  position: number;
  notebookId: string;
  notebook: string;
}

export function rowToField(row: FieldRow): FieldDef {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    name: row.name,
    type: row.type as FieldType,
    options: row.options ? (JSON.parse(row.options) as string[]) : [],
    // Both columns or neither: a half-written scale would make the star control guess.
    scale:
      row.scale_max !== null && row.scale_step !== null
        ? { max: row.scale_max, step: row.scale_step === 0.5 ? 0.5 : 1 }
        : null,
    currency: row.currency,
    position: row.position,
    ...(row.value_count !== undefined ? { valueCount: row.value_count } : {}),
  };
}

/** Options are only stored for the types that carry them; every other type gets NULL, whatever was sent. */
export function optionsColumn(type: FieldType, options: string[]): string | null {
  return fieldHasOptions(type) ? JSON.stringify(options) : null;
}

/**
 * Whether stored text is a JSON array, the form a multi-select's value takes. Guards the
 * one place a value is read back and rewritten rather than compared, where a row that is
 * somehow not the expected shape must be left alone, not thrown on.
 */
export function isJsonArray(text: string): boolean {
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * A currency belongs only to a plain `number`: a field converted away from number drops
 * it, for the reason `scaleColumns` gives, and a rating drops it because a rating is not
 * an amount of money — the schema refuses both in one patch, and this keeps it true when
 * a scale arrives on a field that had a currency.
 */
export function currencyColumn(
  type: FieldType,
  scale: FieldScale | null | undefined,
  currency: string | null | undefined,
): string | null {
  return type === 'number' && !scale && currency ? currency : null;
}

/**
 * A scale belongs only to a `number`. A field converted away from number drops it, the
 * same way `optionsColumn` drops options when a field stops being a select — otherwise a
 * scale would lie in wait and re-bound the field if it ever became a number again.
 */
export function scaleColumns(type: FieldType, scale: FieldScale | null | undefined) {
  return type === 'number' && scale
    ? { max: scale.max, step: scale.step }
    : { max: null, step: null };
}

/**
 * Whether moving to `next` can invalidate a value that was legal under `prev`.
 *
 * Only a tightening needs the values re-planned, and re-planning is a read plus a write of
 * every row — worth skipping when nothing can fail. A lower max cuts the top off, and a
 * coarser step (0.5 to 1) outlaws every half. Gaining a scale where there was none tightens
 * by definition, since a plain number is unbounded and may hold 0, 12 or -3. Losing one
 * never does, and neither does widening.
 */
export function scaleTightens(
  prev: FieldScale | null,
  next: { max: number | null; step: number | null },
): boolean {
  if (next.max === null || next.step === null) return false;
  if (!prev) return true;
  return next.max < prev.max || next.step > prev.step;
}

/**
 * A note's values in the order the editor and the list show them: the note's own
 * notebook's fields in definition order, then anything left over from a notebook the note
 * has since left. Ordered here rather than in SQL because `json_group_array(... ORDER BY)`
 * needs a newer SQLite than D1 promises.
 */
export function decodeFieldsJson(json: string | null, ownNotebookId: string | null): NoteFieldValue[] {
  if (!json) return [];
  const rows = JSON.parse(json) as FieldJson[];
  return rows
    .sort((a, b) => {
      const aOwn = a.notebookId === ownNotebookId ? 0 : 1;
      const bOwn = b.notebookId === ownNotebookId ? 0 : 1;
      return aOwn - bOwn || a.notebook.localeCompare(b.notebook) || a.position - b.position;
    })
    .map((r) => ({
      fieldId: r.fieldId,
      name: r.name,
      type: r.type as FieldType,
      value: decodeFieldValue(r.type as FieldType, r.text),
      // Both columns or neither, as `rowToField` does: a list row would otherwise have to
      // guess how many glyphs a half-written scale means.
      scale:
        r.scaleMax !== null && r.scaleStep !== null
          ? { max: r.scaleMax, step: r.scaleStep === 0.5 ? (0.5 as const) : (1 as const) }
          : null,
      currency: r.currency,
      notebookId: r.notebookId,
      notebook: r.notebook,
    }));
}

/**
 * The correlated subquery that hands `list` and `get` a note's values as one JSON
 * column — the same shape as the tags subquery beside it, so the per-row cost is one
 * primary-key lookup rather than a join that multiplies rows. `json_object` rather than
 * a delimited string because a value can contain any character a delimiter could be.
 *
 * The name falls back to `f.notebook_name`, because a definition outlives the notebook it
 * belonged to (0017). An inner join here would have dropped the value from the note
 * entirely once the notebook row went, which is the data loss the tombstone exists to
 * prevent — a value is a note's own data, and a deleted notebook is not a reason to stop
 * showing it.
 *
 * Nearly every value belongs to the note's own notebook, whose name both callers have
 * already joined as `nb`, so that is used first; only a value left over from another
 * notebook looks its notebook up. Joining `notebooks` once per value, as this did, was
 * most of a list page's cost in a notebook with fields: a page of a 770-note notebook
 * with nine fields read 2.2k rows at 13k notes, now 1.6k. `COALESCE` stops at the first
 * name it finds, so the lookup runs only for a leftover.
 *
 * Callers must join the note's notebook as `nb`.
 */
export const FIELDS_SUBQUERY = `(SELECT json_group_array(json_object(
                 'fieldId', f.id, 'name', f.name, 'type', f.type, 'text', nf.value_text,
                 'scaleMax', f.scale_max, 'scaleStep', f.scale_step, 'currency', f.currency,
                 'position', f.position, 'notebookId', f.notebook_id,
                 'notebook', COALESCE(
                   CASE WHEN f.notebook_id = n.notebook_id THEN nb.name END,
                   (SELECT name FROM notebooks WHERE id = f.notebook_id),
                   f.notebook_name)))
            FROM note_fields nf
            JOIN notebook_fields f ON f.id = nf.field_id
           WHERE nf.note_id = n.id) AS fields`;

/**
 * Unit separator (U+001F): cannot occur in a tag name, so it is a safe group_concat
 * delimiter. Written as an escape rather than a literal so the invisible byte cannot be
 * mangled by an editor or a copy-paste.
 */
export const TAG_SEP = '\u001F';

/**
 * The files a note stores, for its list row: name and declared type, in the order they
 * were attached, so the first one shown is the first one filed.
 *
 * From the attachment rows rather than from links in the body. The rows are what the
 * note actually holds — a file whose link was deleted from the text is still there, and
 * a link can name a file that was never uploaded — and the row is the same source the
 * attachments panel lists from, so the two agree. The excerpt drops attachment links for
 * the same reason: the files are shown once, here.
 *
 * An inner SELECT for the order: `json_group_array` collects in scan order, and only a
 * recent SQLite accepts ORDER BY inside the aggregate itself.
 */
export const ATTACHMENTS_SUBQUERY = `(SELECT json_group_array(json_object(
                 'filename', a.filename, 'contentType', a.content_type))
            FROM (SELECT filename, content_type FROM attachments
                   WHERE note_id = n.id ORDER BY created_at, filename) a) AS attachments`;

export function decodeAttachmentsJson(json: string | null): NonNullable<NoteSummary['attachments']> {
  if (!json) return [];
  return JSON.parse(json) as NonNullable<NoteSummary['attachments']>;
}

/**
 * How many rows past the page each later search tier reads, as a multiple of the limit.
 *
 * A tag, field or file tier yields one row per matching tag, value or file, not per note:
 * a note tagged with three matching tags is three rows until the window function keeps its
 * best one. The tier is read in rank order and cut off at this multiple of the page, so
 * the page is exact unless the top of a tier averages more than this many rows per note —
 * in which case the page comes back short rather than wrong. Four is well past what an
 * archive shows (most notes carry one or two files) and still bounded.
 */
export const SEARCH_OVERFETCH = 4;

/**
 * The most notes a search's notebook or tag filter can name and still be searched note by
 * note rather than match by match. See `scopeDrivenSearchSql`.
 *
 * The two shapes cost differently: the FTS-driven one pays for every archive-wide match
 * until it has a page inside the scope, the scope-driven one about 20–40 rows per note in
 * scope whatever the query. Measured at 13k notes, a common word in a 4-note notebook read
 * 64k rows FTS-driven and 83 scope-driven; at 120 notes scope-driven read 2.2k, and by 770
 * it read 30k, worse than the FTS-driven page. A hundred keeps the scope-driven worst case
 * to a few thousand rows.
 */
export const SCOPE_DRIVEN_SEARCH_MAX = 100;

/**
 * The four sources a search reads, in tier order, and what a row from each says about its
 * match: the FTS table, which of its columns the snippet comes from, and which of the
 * matched columns it fills. `weights` is the bm25 weighting, where a source has one — the
 * note's title counts ten times its body.
 *
 * Both query shapes — `scopeDrivenSearchSql` and the FTS-driven query in `search` — select
 * exactly these columns for every tier and differ only in how they reach the rows, so the
 * columns are written once, in `tierColumns`. A snippet's width, a tier's place or a fifth
 * source changed in one shape and not the other would rank the same note differently
 * depending on how large the filter was.
 */
export interface SearchTier {
  tier: number;
  fts: string;
  /** Which of the FTS table's columns the snippet is cut from. */
  snippet: number;
  weights: string | null;
  /** The matched columns this source fills; the rest are NULL. */
  matched: { file?: string; field?: string; tag?: string };
}

export const SEARCH_TIERS: Record<'note' | 'tag' | 'field' | 'file', SearchTier> = {
  note: { tier: 0, fts: 'notes_fts', snippet: 1, weights: NOTE_FTS_WEIGHTS, matched: {} },
  tag: { tier: 1, fts: 'tags_fts', snippet: 0, weights: null, matched: { tag: 't.name' } },
  field: { tier: 2, fts: 'note_fields_fts', snippet: 0, weights: null, matched: { field: 'f.name' } },
  file: { tier: 3, fts: 'attachment_text_fts', snippet: 0, weights: null, matched: { file: 'at.filename' } },
};

/**
 * One tier's SELECT list. `row` is the alias the note's own columns come from. `rank` is
 * how the shape reads relevance: the FTS-driven query orders by the vtab's `rank` column,
 * which streams in rank order so its LIMIT can stop early (the weights are applied in its
 * WHERE, by `tierRankMatch`); the scope-driven one probes a row at a time and calls
 * `bm25()` with the weights directly. Both give the same numbers.
 */
export function tierColumns(source: keyof typeof SEARCH_TIERS, row: 'n' | 's', rank: 'vtab' | 'bm25'): string {
  const t = SEARCH_TIERS[source];
  const score = rank === 'vtab' ? `${t.fts}.rank` : `bm25(${t.fts}${t.weights ? `, ${t.weights}` : ''})`;
  return `${row}.id, ${row}.title, ${row}.updated_at,
                   snippet(${t.fts}, ${t.snippet}, ${SNIPPET_ARGS}) AS snippet,
                   ${t.matched.file ?? 'NULL'} AS matched_file,
                   ${t.matched.field ?? 'NULL'} AS matched_field,
                   ${t.matched.tag ?? 'NULL'} AS matched_tag,
                   ${score} AS rank,
                   ${t.tier} AS tier`;
}

/** The weighting the FTS-driven query's `rank` column applies. Only the note tier has one. */
export function tierRankMatch(source: keyof typeof SEARCH_TIERS): string {
  return `${SEARCH_TIERS[source].fts}.rank MATCH 'bm25(${SEARCH_TIERS[source].weights})'`;
}

export interface SearchRow {
  id: string;
  title: string;
  updated_at: number;
  snippet: string;
  matched_file: string | null;
  matched_field: string | null;
  matched_tag: string | null;
}

export function toSearchResult(r: SearchRow): SearchResult {
  return {
    id: r.id,
    title: r.title,
    updatedAt: r.updated_at,
    snippet: r.snippet,
    ...(r.matched_file ? { matchedFile: r.matched_file } : {}),
    ...(r.matched_field ? { matchedField: r.matched_field } : {}),
    ...(r.matched_tag ? { matchedTag: r.matched_tag } : {}),
  };
}

/**
 * Search for a small notebook or tag: start from the notes in scope and ask each FTS table
 * about those rows only.
 *
 * The FTS-driven query in `search` reads the archive's matches in rank order and throws
 * away the ones outside the filter, which is right for a large scope — a page fills early —
 * and wrong for a small one: a common word in a four-note notebook walked every match in
 * the archive to find none. Here every source is a CROSS JOIN from the scope, which pins
 * the join order (the planner would otherwise start from the MATCH, having no statistics
 * to say the scope is smaller), and each FTS table is probed by rowid with its MATCH
 * applied to that one row. bm25 reads the whole index's statistics either way, so ranks
 * are the ones the FTS-driven query would give. Same tiers, same one-row-per-note rule;
 * the scope is small, so nothing needs cutting off early.
 *
 * On the shared database each joined row also carried a `+user_id` check, hidden from the
 * planner because left visible it reached each note's files through the user index and
 * read every file the account has once per note in scope. There is no such column here
 * and no such index; the CROSS JOINs alone fix the order.
 *
 * `live` is the `deleted_at` condition — see `liveCondition` for why it hides the index
 * when a tag filter is present — and `scoped` the filter clauses, bound as in `search`.
 * The FTS query is `?1` and the limit `?2`; the filters bind after them.
 */
export function scopeDrivenSearchSql(live: string, scoped: string): string {
  return `WITH scope AS MATERIALIZED (
            SELECT n.rowid AS rid, n.id, n.title, n.updated_at
              FROM notes n
             WHERE ${live}
               ${scoped}
          ),
          note_hits AS (
            SELECT ${tierColumns('note', 's', 'bm25')}
              FROM scope s
             CROSS JOIN notes_fts ON notes_fts.rowid = s.rid
             WHERE notes_fts MATCH ?1
          ),
          tag_hits AS (
            SELECT ${tierColumns('tag', 's', 'bm25')}
              FROM scope s
             CROSS JOIN note_tags nt ON nt.note_id = s.id
             CROSS JOIN tags t ON t.id = nt.tag_id
             CROSS JOIN tags_fts ON tags_fts.rowid = t.rowid
             WHERE tags_fts MATCH ?1
          ),
          field_hits AS (
            SELECT ${tierColumns('field', 's', 'bm25')}
              FROM scope s
             CROSS JOIN note_fields nf ON nf.note_id = s.id
             CROSS JOIN note_fields_fts ON note_fields_fts.rowid = nf.rowid
             CROSS JOIN notebook_fields f ON f.id = nf.field_id
             WHERE note_fields_fts MATCH ?1
          ),
          file_hits AS (
            SELECT ${tierColumns('file', 's', 'bm25')}
              FROM scope s
             CROSS JOIN attachment_text at ON at.note_id = s.id
             CROSS JOIN attachment_text_fts ON attachment_text_fts.rowid = at.rowid
             WHERE attachment_text_fts MATCH ?1
          ),
          combined AS (
            SELECT * FROM note_hits
            UNION ALL SELECT * FROM tag_hits
            UNION ALL SELECT * FROM field_hits
            UNION ALL SELECT * FROM file_hits
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
           LIMIT ?2`;
}

/**
 * The `deleted_at` condition `list`, `count` and `search` open with.
 *
 * With a tag filter it is written `+n.deleted_at`: the unary plus is SQLite's documented
 * way to keep a column's index out of the plan while still applying the condition. Every
 * notes index leads with `deleted_at` (or with the notebook and then it), and without
 * statistics the planner takes an equality on an index's first column to be selective
 * and starts there — when `IS NULL` matches every live note. Hiding that index leaves the
 * tag's `n.id IN (…)` as the way in, and the query reads the tagged notes and nothing else.
 * On the shared database the same trick was played on `user_id`, for the same reason.
 *
 * Only with a tag. With none, the `deleted_at` indexes are the ones that return rows in
 * sort order and let a page stop after fifty. With one, starting from the tag can cost
 * more than walking the sort index when the tag is on most notes — but never more than
 * the count beside the first page, which has to read every tagged note anyway.
 */
export function liveCondition(
  trashed: boolean | undefined,
  tags: string[] | undefined,
  ids?: string[] | undefined,
): string {
  // Named notes are the same case as a tag, more so: each id is a primary-key lookup, and
  // a plan that walked a `deleted_at` index would read every live note to test it against
  // the list — the hazard `ID_RUN`'s comment measured on the batch writes.
  const byKey = (tags && tags.length > 0) || (ids && ids.length > 0);
  const column = byKey ? '+n.deleted_at' : 'n.deleted_at';
  return trashed ? `${column} IS NOT NULL` : `${column} IS NULL`;
}

/**
 * SQL conditions for the `notebook`, `tags`, `fields`, `untagged` and date filters, shared
 * by `list`, `count` and `search`.
 *
 * All three call sites need identical semantics — a filter has to mean the same thing
 * whether or not a query is also typed — so the clauses live here rather than being
 * written three times.
 *
 * Binds are positional: parameters are appended to the caller's array and the placeholder
 * index is taken from its length, so the same clause is right after however many values
 * the caller bound first — `search` binds the FTS query and the limit before these.
 */
export function filterConditions(
  opts: {
    tags?: string[] | undefined;
    notebook?: string | undefined;
    fields?: FieldFilter[] | undefined;
    /** Only notes carrying no tag at all. */
    untagged?: boolean | undefined;
    from?: string | undefined;
    to?: string | undefined;
    /** Column the date range applies to. */
    dateColumn?: string;
    /**
     * Only these notes: an export of a selection. Bound in one statement, so at most
     * `ID_RUN` of them; the caller passes `liveCondition` the same list.
     */
    ids?: string[] | undefined;
  },
  binds: unknown[],
): string[] {
  const conditions: string[] = [];

  if (opts.ids && opts.ids.length > 0) {
    if (opts.ids.length > ID_RUN) throw new Error(`At most ${ID_RUN} ids in one filter`);
    const first = binds.length + 1;
    binds.push(...opts.ids);
    conditions.push(`n.id IN (${placeholders(first, opts.ids.length)})`);
  }

  /**
   * The range filters whichever column the caller is ordering by, so "oldest first" and
   * "everything before 2020" agree about which date they mean. Search has no sort, so it
   * passes `created_at`: for an archive, "filed in 2023" is the question being asked.
   *
   * Both ends are inclusive — see `endOfDay`.
   */
  const dateColumn = opts.dateColumn ?? 'n.created_at';
  if (opts.from) {
    binds.push(startOfDay(opts.from));
    conditions.push(`${dateColumn} >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(endOfDay(opts.to));
    conditions.push(`${dateColumn} <= ?${binds.length}`);
  }

  /*
   * With a tag filter beside it, the notebook condition is written `+n.notebook_id`, for
   * the reason `liveCondition` hides `deleted_at`: the per-notebook indexes lead with
   * this column, and the planner would otherwise start from the notebook and test every
   * note in it against the tag — 606 rows to count a tag on three notes in a 600-note
   * notebook (measured at 3k notes). On the shared database the same index led with
   * `user_id`, so hiding that column hid this one too; here it has to be said. Without a
   * tag the notebook is the way in and its index is exactly what a page wants.
   */
  const notebookColumn = opts.tags && opts.tags.length > 0 ? '+n.notebook_id' : 'n.notebook_id';
  if (opts.notebook === UNFILED) {
    conditions.push(`${notebookColumn} IS NULL`);
  } else if (opts.notebook) {
    binds.push(opts.notebook);
    // Matched by name, case-insensitively, so a URL filter written in any case works.
    conditions.push(
      `${notebookColumn} = (SELECT id FROM notebooks WHERE name = ?${binds.length} COLLATE NOCASE)`,
    );
  }

  /*
   * One IN per tag, AND'd together: the note must carry every one of them.
   *
   * Conjunction is what makes this a widening rather than a change — a single tag
   * produces exactly the clause a single filter produced before, so the existing
   * behaviour is the one-element case rather than a case handled alongside it. Each
   * clause is an independent semi-join on note_tags, so nothing here fans out the row
   * count the way joining the table once per tag would.
   *
   * IN rather than a correlated EXISTS because only IN can be the side the query starts
   * from: tag by name, its note_tags rows, then those notes by primary key. An EXISTS is
   * evaluated per note, so the query walked every note the user has and asked each one —
   * a tag on one note cost a read of the whole archive, twice with the count beside it.
   * The IN alone is not enough, though; see `liveCondition`.
   *
   * Matched by name without case, as a notebook is, and for the same reason: `?tag=receipts`
   * finds the notes tagged Receipts. `COLLATE NOCASE` on the comparison is what lets it use
   * the NOCASE index (0006-tags-nocase); the plain `UNIQUE(name)` would not serve it.
   */
  for (const tag of opts.tags ?? []) {
    binds.push(tag);
    conditions.push(
      `n.id IN (SELECT nt2.note_id FROM tags t2 JOIN note_tags nt2 ON nt2.tag_id = t2.id
                 WHERE t2.name = ?${binds.length} COLLATE NOCASE)`,
    );
  }

  /*
   * Notes with no tag, the question "what is left to file".
   *
   * A NOT EXISTS, unlike the tags' IN above, because there is nothing to start from: the
   * notes are the way in — the notebook's index, or the `deleted_at` ones — and each is
   * asked once by the primary key of `note_tags`, one read a note. It is why this is never
   * a stored count and why it is not hidden behind `+`: the indexes on the notes' side
   * are what let a page stop early — when there is a page's worth to find. That is the
   * cheap case and not the usual one: the filter is for finding what is left, and the
   * nearer an account is to tidy, the further a page walks before it fills, until a
   * notebook with three untagged notes is read to its end, two rows a note, to return
   * them. Nothing here can make that cheaper; what can be saved is counting the same
   * notes again afterwards, which `listPage` does not do for a page that came up short.
   * Beside a tag filter the two contradict and match nothing, which is the right answer;
   * the MCP refuses the pair before it gets here.
   */
  if (opts.untagged) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM note_tags nt4 WHERE nt4.note_id = n.id)`);
  }

  /*
   * One EXISTS per field filter, in the tags' shape, against the value row for that field.
   *
   * Type-agnostic on purpose. This is a synchronous SQL builder and looking a definition
   * up to learn its type would make it neither; instead `eq` compares the stored text,
   * which is canonical for every type (`encodeFieldValue` is the only writer), and a
   * range compares the numeric shadow that every number and date carries. A filter on a
   * field of the wrong type for its op matches nothing, which is the right answer to a
   * question that does not apply. A field id from another account's notebook matches
   * nothing here either, because no such row exists in this database. The indexes are
   * 0027's.
   *
   * The one text that is not one value is a multi-select's, which `encodeFieldValue`
   * writes as a JSON list. `eq` on that means "holds this option", so the stored text is
   * also opened as a list and each element compared — still without knowing the type,
   * since only a multi-select stores a JSON array. The `CASE` is what keeps `json_each`
   * off text that is not JSON, where it would raise rather than return nothing.
   */
  for (const f of opts.fields ?? []) {
    binds.push(f.fieldId);
    const held =
      `SELECT 1 FROM note_fields nf3 WHERE nf3.note_id = n.id` +
      ` AND nf3.field_id = ?${binds.length}`;
    switch (f.op) {
      case 'set':
        conditions.push(`EXISTS (${held})`);
        break;
      case 'empty':
        conditions.push(`NOT EXISTS (${held})`);
        break;
      case 'eq': {
        binds.push(f.value ?? '');
        const v = `?${binds.length}`;
        conditions.push(
          `EXISTS (${held} AND (nf3.value_text = ${v} OR CASE WHEN json_valid(nf3.value_text)` +
            ` THEN json_type(nf3.value_text) = 'array'` +
            ` AND EXISTS (SELECT 1 FROM json_each(nf3.value_text) WHERE json_each.value = ${v})` +
            ` ELSE 0 END))`,
        );
        break;
      }
      case 'gte':
      case 'lte': {
        const bound = fieldRangeBound(f.op, f.value ?? '');
        // The schema has already refused an unreadable bound; this is belt and braces.
        if (bound === null) {
          conditions.push('0');
          break;
        }
        binds.push(bound);
        conditions.push(
          `EXISTS (${held} AND nf3.value_num ${f.op === 'gte' ? '>=' : '<='} ?${binds.length})`,
        );
        break;
      }
    }
  }

  return conditions;
}

/**
 * The sort column and its cursor, in one place.
 *
 * Keyset pagination compares against the column it ordered by, so the two must always
 * agree: ordering by title while paging on `updated_at` skips and repeats rows. Pairing
 * them here means a new sort cannot be added with a mismatched cursor.
 *
 * `title` is compared `COLLATE NOCASE` so paging matches the order the rows came back in;
 * a binary comparison would put every lowercase title after every uppercase one and drop
 * rows from the middle of the sequence.
 */
export const SORTS: Record<
  NoteSort,
  {
    column: string;
    /**
     * The column a `from`/`to` range applies to under this sort: the date the rows show.
     * For the two date sorts that is the sort column itself. Under the title sort the rows
     * show when they were updated — see NoteListItem and the Android NoteRow — so the
     * range reads that column; comparing epoch-ms against `n.title`, which is what falling
     * back to the sort column did, matched nothing at all.
     */
    dateColumn: string;
    collate?: string;
    text?: boolean;
    keyOf: (row: NoteSummary) => string | number;
  }
> = {
  updated: { column: 'n.updated_at', dateColumn: 'n.updated_at', keyOf: (r) => r.updatedAt },
  created: { column: 'n.created_at', dateColumn: 'n.created_at', keyOf: (r) => r.createdAt },
  title: {
    column: 'n.title',
    dateColumn: 'n.updated_at',
    collate: 'COLLATE NOCASE',
    text: true,
    keyOf: (r) => r.title,
  },
};

/** Trash is ordered by when it was deleted, whatever sort the live list is using. */
export const TRASH_SORT = {
  column: 'n.deleted_at',
  dateColumn: 'n.deleted_at',
  keyOf: (r: NoteSummary) => r.deletedAt ?? r.updatedAt,
};

/**
 * A sort by one custom field's value, built per request from its definition.
 *
 * Not an entry in `SORTS` because the column depends on the type: the numeric types
 * order by their `value_num` shadow and the rest by `value_text`, the same split
 * `fieldSortsNumerically` draws for the cursor. The column names the value row aliased
 * `sf`, which `pageRows` walks in order; notes without a value come after every note with
 * one, whichever direction. The rows show their updated date under this sort, as under the
 * title sort, so that is what a date range reads.
 */
export function fieldSort(def: FieldDef) {
  const numeric = fieldSortsNumerically(def.type);
  return {
    column: numeric ? 'sf.value_num' : 'sf.value_text',
    dateColumn: 'n.updated_at',
    collate: numeric ? '' : ' COLLATE NOCASE',
    text: !numeric,
    keyOf: (r: NoteSummary) => fieldSortKey(def, r.fields),
  };
}

/**
 * The cursor is the sort key *and* the id of the last row.
 *
 * Comparing the sort key alone is only safe when it is unique. Titles are not — an
 * archive is full of notes called "Receipt" — and a strict `<` on the key would step
 * over every row sharing the boundary value. Carrying the id makes the comparison a
 * lexicographic one on `(key, id)`, which is exactly the order the rows came back in.
 *
 * The id is appended after a separator that cannot occur in a uuid, so a title containing
 * the separator still round-trips: only the final segment is the id.
 */
export const CURSOR_SEP = '\u001F';

export function encodeCursor(key: string | number, id: string): string {
  return `${key}${CURSOR_SEP}${id}`;
}

export function decodeCursor(cursor: string): { key: string; id: string } | null {
  const at = cursor.lastIndexOf(CURSOR_SEP);
  if (at === -1) return null;
  return { key: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

/**
 * The cursor for the next page, or null if this page was not full.
 *
 * Lives beside `SORTS` rather than in the route so the column that ordered the query is
 * the column that pages it — the route no longer needs to know how a sort is implemented.
 */
export function nextCursor(
  items: NoteSummary[],
  opts: {
    limit: number;
    sort: NoteSort;
    trashed?: boolean | undefined;
    /** The field the page was sorted by, when it was; see `fieldSort`. */
    sortField?: FieldDef | undefined;
  },
): string | null {
  const last = items[items.length - 1];
  if (items.length < opts.limit || !last) return null;
  return cursorAfter(last, opts);
}

/**
 * The cursor that resumes after `last`, whatever the page's length. `nextCursor` treats a
 * short page as the end; a page cut short for another reason — the export's byte budget —
 * has to say where it stopped explicitly, or the client would take the cut as the end.
 */
export function cursorAfter(
  last: NoteSummary,
  opts: { sort: NoteSort; trashed?: boolean | undefined; sortField?: FieldDef | undefined },
): string {
  const spec = opts.trashed
    ? TRASH_SORT
    : opts.sortField
      ? fieldSort(opts.sortField)
      : SORTS[opts.sort];
  return encodeCursor(spec.keyOf(last), last.id);
}

export function splitTags(joined: string | null): string[] {
  if (!joined) return [];
  return joined.split(TAG_SEP).filter((t) => t.length > 0);
}

/**
 * Attachment keys that belong to notes a purge actually deleted.
 *
 * The SELECT that finds keys and the DELETE that removes notes are separate statements,
 * and a restore from another tab or over MCP can land between them. Returning every key
 * the SELECT saw would then delete the files of a note that is live again. The singular
 * route already refuses to sweep blobs unless the row went; the batch paths have to do
 * the same per id.
 */
export function keysOfDeletedNotes(
  rows: Array<{ r2_key: string; note_id: string }>,
  deletedIds: string[],
): string[] {
  const gone = new Set(deletedIds);
  return rows.filter((r) => gone.has(r.note_id)).map((r) => r.r2_key);
}

/** Whether a stored value and a resent one are the same text, a list compared as a list. */
export function sameFieldText(a: FieldValue, b: FieldValue): boolean {
  return Array.isArray(a) || Array.isArray(b)
    ? JSON.stringify(a) === JSON.stringify(b)
    : String(a) === String(b);
}

/**
 * Whether a patch's tag list would leave the stored tags exactly as they are.
 *
 * Order is not significant — `note_tags` has none and `get` returns them sorted — so this
 * compares sets. Blanks and duplicates are normalized away first, matching what `setTags`
 * would have written, so `['work', 'work', ' ']` against a stored `['work']` is no edit.
 * So is case: `['receipts']` against a stored `['Receipts']` would attach the same tag,
 * since a tag is found by name without case (MAK-127), and writing it would re-date the
 * note for nothing. That is not the normalizing `changedKeysOnly` refuses for text — the
 * case of a tag on one note is not something a write can change.
 */
export function sameTagSet(patch: string[], stored: string[]): boolean {
  const next = new Set(uniqueTags(patch).map(foldNoCase));
  if (next.size !== stored.length) return false;
  return stored.every((t) => next.has(foldNoCase(t)));
}

/**
 * A tag list as `setTags` would write it: trimmed, blanks dropped, each name once — once
 * without case, as the NOCASE index has it (0006-tags-nocase), keeping the spelling that
 * came first. `['Receipts', 'receipts']` is one tag, and which spelling the note ends up
 * showing is the stored tag's in any case: `setTags` attaches an existing tag rather than
 * the name it was given.
 */
export function uniqueTags(tags: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of tags) {
    const t = raw.trim();
    if (t.length > 0 && !seen.has(foldNoCase(t))) seen.set(foldNoCase(t), t);
  }
  return [...seen.values()];
}

/**
 * The engine binds at most 100 parameters to one statement — the same cap on the object's
 * SQLite as on D1 (measured 2026-09-29) — so a set of ids is written in runs of this many,
 * leaving room for the handful of other values a statement binds. `purge` uses 99 with a
 * single other bind; the batch methods bind a few more, and one number that is safe for
 * all of them is easier to keep right than one per query.
 */
export const ID_RUN = 90;

/** Notes one `purge` call deletes: ten runs of 99 ids, so a call stays a couple of dozen statements. */
export const PURGE_PAGE = 990;

/*
 * Every statement that names notes by an `id IN (…)` run writes its trash condition as
 * `+deleted_at`. The unary plus is SQLite's way to keep a column's index out of the plan
 * while still applying the condition — the idiom `liveCondition` uses for tag filters.
 * Without it the planner, which has no statistics and so takes the first column of an
 * index to be selective, answered "these three notes" by walking `idx_notes_updated` over
 * every live note and testing each against the list: 3,025 rows read to trash three
 * notes at 3k notes (measured 2026-09-29; a SELECT of the same shape over fifty notes
 * had taken the primary key, which is why the dry run missed it). With it, each id is a
 * primary-key lookup. The shared database wrote `+user_id` in the same places for the
 * same reason.
 */

export function runs<T>(items: T[], size = ID_RUN): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `?n, ?n+1, …` — `count` placeholders numbered from `from`, for an `IN (…)` list. */
export function placeholders(from: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `?${from + i}`).join(', ');
}
