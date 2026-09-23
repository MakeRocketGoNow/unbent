import { ScopedRepo } from './repo.js';
import {
  decodeFieldValue,
  encodeFieldValue,
  endOfDay,
  excerptMarkdown,
  expectedFieldValue,
  fieldRangeBound,
  fieldHasOptions,
  fieldOptionsSchema,
  inferFieldType,
  InvalidFieldValue,
  withHeldOptions,
  isReservedFieldName,
  MAX_FIELDS_PER_NOTEBOOK,
  MAX_SELECT_OPTIONS,
  planConversion,
  startOfDay,
  UNFILED,
  type FieldDef,
  type FieldFilter,
  type FieldScale,
  type FieldType,
  type FieldValue,
  type Note,
  type NoteFieldsPatch,
  type NoteFieldValue,
  type NoteSort,
  type NoteSummary,
  type NotebookDefinition,
  type NotebookSummary,
  type SearchResult,
  fieldSortKey,
  fieldSortsNumerically,
} from '@unbent/shared';

interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
  notebook: string | null;
  notebook_id: string | null;
}

interface SummaryRow {
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

interface FieldRow {
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
interface FieldJson {
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

function rowToField(row: FieldRow): FieldDef {
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
function optionsColumn(type: FieldType, options: string[]): string | null {
  return fieldHasOptions(type) ? JSON.stringify(options) : null;
}

/**
 * Whether stored text is a JSON array, the form a multi-select's value takes. Guards the
 * one place a value is read back and rewritten rather than compared, where a row that is
 * somehow not the expected shape must be left alone, not thrown on.
 */
function isJsonArray(text: string): boolean {
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
function currencyColumn(
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
function scaleColumns(type: FieldType, scale: FieldScale | null | undefined) {
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
function scaleTightens(
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
function decodeFieldsJson(json: string | null, ownNotebookId: string | null): NoteFieldValue[] {
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
 * The notebook join is LEFT and the name falls back to `f.notebook_name`, because a
 * definition outlives the notebook it belonged to (0017). An inner join here would have
 * dropped the value from the note entirely once the notebook row went, which is the data
 * loss the tombstone exists to prevent — a value is a note's own data, and a deleted
 * notebook is not a reason to stop showing it.
 */
const FIELDS_SUBQUERY = `(SELECT json_group_array(json_object(
                 'fieldId', f.id, 'name', f.name, 'type', f.type, 'text', nf.value_text,
                 'scaleMax', f.scale_max, 'scaleStep', f.scale_step, 'currency', f.currency,
                 'position', f.position, 'notebookId', f.notebook_id,
                 'notebook', COALESCE(fnb.name, f.notebook_name)))
            FROM note_fields nf
            JOIN notebook_fields f ON f.id = nf.field_id
            LEFT JOIN notebooks fnb ON fnb.id = f.notebook_id
           WHERE nf.note_id = n.id) AS fields`;

/**
 * Unit separator (U+001F): cannot occur in a tag name, so it is a safe group_concat
 * delimiter. Written as an escape rather than a literal so the invisible byte cannot be
 * mangled by an editor or a copy-paste.
 */
const TAG_SEP = '\u001F';

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
const ATTACHMENTS_SUBQUERY = `(SELECT json_group_array(json_object(
                 'filename', a.filename, 'contentType', a.content_type))
            FROM (SELECT filename, content_type FROM attachments
                   WHERE note_id = n.id ORDER BY created_at, filename) a) AS attachments`;

function decodeAttachmentsJson(json: string | null): NonNullable<NoteSummary['attachments']> {
  if (!json) return [];
  return JSON.parse(json) as NonNullable<NoteSummary['attachments']>;
}

/**
 * Turns arbitrary user input into a valid FTS5 MATCH expression.
 *
 * FTS5 query syntax is a real grammar: a stray quote, a bare `*`, or a reserved word like
 * `AND` raises a SQL error rather than returning nothing. Users type search boxes, not
 * query languages, so every term is quoted as a literal phrase and the last one gets a
 * prefix `*` so results appear while typing.
 */
export function toFtsQuery(raw: string): string {
  const terms = raw
    .replace(/["*()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (terms.length === 0) return '';

  return terms
    .map((term, i) => {
      const quoted = `"${term}"`;
      // Prefix-match only the final term: mid-query terms are complete words.
      return i === terms.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

/**
 * The `user_id` condition `list` and `count` open with, bound as `?1`.
 *
 * With a tag filter it is written `+n.user_id`: the unary plus is SQLite's documented way
 * to keep a column's index out of the plan, while still applying the condition. Every
 * notes index leads with `user_id`, and without statistics the planner takes an equality
 * on an index's first column to be selective and starts there. On an instance with one
 * user it matches every row, so a tag on three notes was answered by reading all of them.
 * Hiding that index leaves the tag's `n.id IN (…)` as the way in, and the query reads the
 * tagged notes and nothing else.
 *
 * Only with a tag. With none, the `user_id` indexes are the ones that return rows in sort
 * order and let a page stop after fifty. With one, starting from the tag can cost more than
 * walking the sort index when the tag is on most notes — but never more than the count
 * beside the first page, which has to read every tagged note anyway.
 */
function ownerCondition(tags: string[] | undefined): string {
  return tags && tags.length > 0 ? '+n.user_id = ?1' : 'n.user_id = ?1';
}

/**
 * SQL conditions for the `notebook` and `tags` filters, shared by `list` and `search`.
 *
 * Both call sites need identical semantics — a filter has to mean the same thing whether
 * or not a query is also typed — so the clauses live here rather than being written twice.
 *
 * Binds are positional: parameters are appended to the caller's array and the placeholder
 * index is taken from its length. The user id is bound explicitly rather than assumed to
 * be `?1`, because it is only in `list` and `count` that it happens to land there —
 * `search` binds the FTS query first, and reusing `?1` there silently compared `user_id`
 * against the search text and matched nothing.
 */
function filterConditions(
  opts: {
    tags?: string[] | undefined;
    notebook?: string | undefined;
    fields?: FieldFilter[] | undefined;
    from?: string | undefined;
    to?: string | undefined;
    /** Column the date range applies to. */
    dateColumn?: string;
  },
  binds: unknown[],
  userId: string,
): string[] {
  const conditions: string[] = [];

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

  if (opts.notebook === UNFILED) {
    conditions.push('n.notebook_id IS NULL');
  } else if (opts.notebook) {
    binds.push(userId, opts.notebook);
    // Matched by name, case-insensitively, so a URL filter written in any case works.
    conditions.push(
      `n.notebook_id = (SELECT id FROM notebooks
                         WHERE user_id = ?${binds.length - 1} AND name = ?${binds.length} COLLATE NOCASE)`,
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
   * The IN alone is not enough, though; see `ownerCondition`.
   */
  for (const tag of opts.tags ?? []) {
    binds.push(tag, userId);
    conditions.push(
      `n.id IN (SELECT nt2.note_id FROM tags t2 JOIN note_tags nt2 ON nt2.tag_id = t2.id
                 WHERE t2.name = ?${binds.length - 1} AND t2.user_id = ?${binds.length})`,
    );
  }

  /*
   * One EXISTS per field filter, in the tags' shape, against the value row for that field.
   *
   * Type-agnostic on purpose. This is a synchronous SQL builder and looking a definition
   * up to learn its type would make it neither; instead `eq` compares the stored text,
   * which is canonical for every type (`encodeFieldValue` is the only writer), and a
   * range compares the numeric shadow that every number and date carries. A filter on a
   * field of the wrong type for its op matches nothing, which is the right answer to a
   * question that does not apply. The `user_id` on the value row is what keeps a guessed
   * field id from reading across tenants; the indexes are 0014's.
   *
   * The one text that is not one value is a multi-select's, which `encodeFieldValue`
   * writes as a JSON list. `eq` on that means "holds this option", so the stored text is
   * also opened as a list and each element compared — still without knowing the type,
   * since only a multi-select stores a JSON array. The `CASE` is what keeps `json_each`
   * off text that is not JSON, where it would raise rather than return nothing.
   */
  for (const f of opts.fields ?? []) {
    binds.push(f.fieldId, userId);
    const held =
      `SELECT 1 FROM note_fields nf3 WHERE nf3.note_id = n.id` +
      ` AND nf3.field_id = ?${binds.length - 1} AND nf3.user_id = ?${binds.length}`;
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
const SORTS: Record<
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
const TRASH_SORT = {
  column: 'n.deleted_at',
  dateColumn: 'n.deleted_at',
  keyOf: (r: NoteSummary) => r.deletedAt ?? r.updatedAt,
};

/**
 * A sort by one custom field's value, built per request from its definition.
 *
 * Not an entry in `SORTS` because the column depends on the type: the numeric types
 * order by their `value_num` shadow and the rest by `value_text`, the same split
 * `fieldSortsNumerically` draws for the cursor. The value comes in through a LEFT JOIN
 * aliased `sf`, so notes without one are still rows — ordered last, whichever direction,
 * by the `IS NULL` term the ORDER BY leads with. The rows show their updated date under
 * this sort, as under the title sort, so that is what a date range reads.
 */
function fieldSort(def: FieldDef) {
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
const CURSOR_SEP = '\u001F';

function encodeCursor(key: string | number, id: string): string {
  return `${key}${CURSOR_SEP}${id}`;
}

function decodeCursor(cursor: string): { key: string; id: string } | null {
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
  const spec = opts.trashed
    ? TRASH_SORT
    : opts.sortField
      ? fieldSort(opts.sortField)
      : SORTS[opts.sort];
  return encodeCursor(spec.keyOf(last), last.id);
}

function splitTags(joined: string | null): string[] {
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

/**
 * Whether a patch's tag list would leave the stored tags exactly as they are.
 *
 * Order is not significant — `note_tags` has none and `get` returns them sorted — so this
 * compares sets. Blanks and duplicates are normalized away first, matching what `setTags`
 * would have written, so `['work', 'work', ' ']` against a stored `['work']` is no edit.
 */
/** Whether a stored value and a resent one are the same text, a list compared as a list. */
function sameFieldText(a: FieldValue, b: FieldValue): boolean {
  return Array.isArray(a) || Array.isArray(b)
    ? JSON.stringify(a) === JSON.stringify(b)
    : String(a) === String(b);
}

function sameTagSet(patch: string[], stored: string[]): boolean {
  const next = new Set(patch.map((t) => t.trim()).filter((t) => t.length > 0));
  if (next.size !== stored.length) return false;
  return stored.every((t) => next.has(t));
}

/**
 * A tag list as `setTags` would write it: trimmed, blanks dropped, each name once.
 * Compared exactly, as the UNIQUE index compares them — "Receipt" and "receipt" are two tags.
 */
function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))];
}

/**
 * D1 binds at most 100 parameters to one statement, so a set of ids is written in runs of
 * this many, leaving room for the handful of other values a statement binds. `purge` uses
 * 99 with a single other bind; the batch methods below bind a few more, and one number
 * that is safe for all of them is easier to keep right than one per query.
 */
const ID_RUN = 90;

function runs<T>(items: T[], size = ID_RUN): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `?n, ?n+1, …` — `count` placeholders numbered from `from`, for an `IN (…)` list. */
function placeholders(from: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `?${from + i}`).join(', ');
}

/**
 * All note access for one user.
 *
 * Every method injects `this.userId` — no method accepts a user id as a parameter, which
 * is what makes an unscoped query unexpressible rather than merely discouraged. Lookups
 * are scoped even when the id is a primary key: an unguessable uuid is not authorization.
 */
export class NotesRepo extends ScopedRepo {
  /**
   * A page of notes, ordered by the requested sort. Keyset pagination keeps deep pages
   * cheap: each page resumes from the last row's sort key rather than counting past
   * everything before it.
   */
  async list(opts: {
    limit: number;
    cursor?: string;
    tags?: string[];
    notebook?: string;
    fields?: FieldFilter[];
    sort?: NoteSort;
    order?: 'asc' | 'desc';
    from?: string;
    to?: string;
    /** List trashed notes instead of live ones. */
    trashed?: boolean;
    /**
     * Order by this field's value instead of `sort`. The resolved definition rather than
     * an id, so the SQL is built knowing the type — the same reason `filterConditions`
     * takes definitions. Ignored for the trash.
     */
    sortField?: FieldDef;
  }): Promise<NoteSummary[]> {
    const { limit, cursor, tags, notebook, fields, trashed, from, to } = opts;
    const sort = opts.sort ?? 'updated';
    // Trash has one meaningful order — most recently deleted first — so it ignores both.
    const byField = !trashed && opts.sortField ? opts.sortField : undefined;
    const spec = trashed ? TRASH_SORT : byField ? fieldSort(byField) : SORTS[sort];
    const descending = trashed || (opts.order ?? 'desc') === 'desc';
    const collate = 'collate' in spec && spec.collate ? ` ${spec.collate.trim()}` : '';

    const conditions = [
      ownerCondition(tags),
      trashed ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL',
    ];
    const binds: unknown[] = [this.userId];
    /*
     * The value being sorted by, one row per note or none. Bound second, straight after
     * the user id, so the join can name it as ?2 whatever else the filters bind later.
     */
    let sortJoin = '';
    if (byField) {
      binds.push(byField.id);
      sortJoin = `LEFT JOIN note_fields sf
             ON sf.note_id = n.id AND sf.field_id = ?2 AND sf.user_id = ?1`;
    }

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (decoded) {
      /**
       * `(key, id) < (?, ?)` spelled out, because SQLite has no row-value comparison in
       * this position: strictly past the boundary key, or on it and past that row's id.
       *
       * Titles compare as text; the timestamp columns are numbers and must bind as
       * numbers or SQLite compares them as strings, where '9' sorts after '10'.
       */
      const isText = !trashed && 'text' in spec && spec.text === true;
      const op = descending ? '<' : '>';
      if (byField && decoded.key === '') {
        /*
         * The boundary row had no value. Those rows come after every row with one, in
         * both directions (see `fieldSort`), so the rest of the page is the remaining
         * valueless rows past that id — never a row with a value, which is why the
         * key is not compared at all. `''` is the marker `fieldSortKey` writes.
         */
        binds.push(decoded.id);
        conditions.push(`(${spec.column} IS NULL AND n.id ${op} ?${binds.length})`);
      } else {
        binds.push(isText ? decoded.key : Number(decoded.key), decoded.id);
        const keyBind = `?${binds.length - 1}`;
        const idBind = `?${binds.length}`;
        // Past the boundary in the sort's own order; for a field sort the valueless
        // rows still lie ahead, so a NULL passes too.
        const nullsAhead = byField ? `${spec.column} IS NULL OR ` : '';
        conditions.push(
          `(${nullsAhead}${spec.column}${collate} ${op} ${keyBind}` +
            ` OR (${spec.column}${collate} = ${keyBind} AND n.id ${op} ${idBind}))`,
        );
      }
    }
    conditions.push(
      // The range applies to the column being sorted, so the filter and the order agree.
      ...filterConditions(
        { tags, notebook, fields, from, to, dateColumn: spec.dateColumn },
        binds,
        this.userId,
      ),
    );
    binds.push(limit);

    const direction = descending ? 'DESC' : 'ASC';

    const { results } = await this.db
      .prepare(
        `SELECT n.id, n.title, n.body, n.created_at, n.updated_at, n.deleted_at,
                nb.name AS notebook, n.notebook_id,
                (SELECT group_concat(t.name, char(31)) FROM note_tags nt
                   JOIN tags t ON t.id = nt.tag_id
                  WHERE nt.note_id = n.id) AS tags,
                ${FIELDS_SUBQUERY},
                ${ATTACHMENTS_SUBQUERY}
           FROM notes n
           LEFT JOIN notebooks nb ON nb.id = n.notebook_id
           ${sortJoin}
          WHERE ${conditions.join(' AND ')}
          ORDER BY ${byField ? `(${spec.column} IS NULL) ASC, ` : ''}${spec.column}${collate} ${direction}, n.id ${direction}
          LIMIT ?${binds.length}`,
      )
      .bind(...binds)
      .all<SummaryRow>();

    return results.map((r) => {
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
    });
  }

  /**
   * Total live notes, optionally within a notebook and/or some tags.
   *
   * Reported separately from `list` because the list is paginated: counting what a page
   * returned would show "50 notes" for an account holding hundreds.
   */
  async count(opts?: {
    tags?: string[];
    notebook?: string;
    fields?: FieldFilter[];
    trashed?: boolean;
    from?: string;
    to?: string;
    sort?: NoteSort;
    /** Sorting by a field, which decides the column a date range reads; see `fieldSort`. */
    sortField?: FieldDef;
  }): Promise<number> {
    const conditions = [
      ownerCondition(opts?.tags),
      opts?.trashed ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL',
    ];
    const binds: unknown[] = [this.userId];

    conditions.push(
      ...filterConditions(
        {
          tags: opts?.tags,
          notebook: opts?.notebook,
          fields: opts?.fields,
          from: opts?.from,
          to: opts?.to,
          dateColumn: opts?.trashed
            ? TRASH_SORT.dateColumn
            : opts?.sortField
              ? fieldSort(opts.sortField).dateColumn
              : SORTS[opts?.sort ?? 'updated'].dateColumn,
        },
        binds,
        this.userId,
      ),
    );

    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM notes n WHERE ${conditions.join(' AND ')}`)
      .bind(...binds)
      .first<{ n: number }>();

    return row?.n ?? 0;
  }

  /** Scoped by user_id despite `id` being the primary key. Never returns another user's note. */
  async get(id: string): Promise<Note | null> {
    const row = await this.db
      .prepare(
        `SELECT n.id, n.title, n.body, n.created_at, n.updated_at, nb.name AS notebook,
                n.notebook_id, ${FIELDS_SUBQUERY}
           FROM notes n
           LEFT JOIN notebooks nb ON nb.id = n.notebook_id
          WHERE n.id = ?1 AND n.user_id = ?2 AND n.deleted_at IS NULL`,
      )
      .bind(id, this.userId)
      .first<NoteRow & { fields: string | null }>();
    if (!row) return null;

    /*
     * CROSS JOIN is SQLite's way of fixing the join order, and the order is the point.
     * Written as a plain JOIN, the planner walked the user's whole tag list through the
     * UNIQUE(user_id, name) index — it is already in name order, so the ORDER BY came
     * free — and probed note_tags once per tag. That is every tag the user owns, read to
     * return two or three: on an archive with three hundred tags, opening a note read
     * three hundred rows, and D1 bills for every one. Starting from note_tags reads this
     * note's rows and sorts a handful of names.
     */
    const { results } = await this.db
      .prepare(
        `SELECT t.name FROM note_tags nt CROSS JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = ?1 AND t.user_id = ?2 ORDER BY t.name`,
      )
      .bind(id, this.userId)
      .all<{ name: string }>();

    const fields = decodeFieldsJson(row.fields, row.notebook_id);
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tags: results.map((t) => t.name),
      notebook: row.notebook,
      notebookId: row.notebook_id,
      ...(fields.length > 0 ? { fields } : {}),
    };
  }

  async create(input: {
    id: string;
    title: string;
    body: string;
    tags: string[];
    notebook?: string | null;
    fields?: NoteFieldsPatch;
  }): Promise<Note> {
    const now = Date.now();
    // Validated before the insert, so a bad value leaves no half-made note behind.
    const fieldWrites = input.fields ? await this.prepareFieldWrites(input.id, input.fields) : [];
    const notebookId = await this.resolveNotebook(input.notebook);
    await this.db
      .prepare(
        `INSERT INTO notes (id, user_id, title, body, created_at, updated_at, notebook_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)`,
      )
      .bind(input.id, this.userId, input.title, input.body, now, notebookId)
      .run();

    if (input.tags.length > 0) await this.setTags(input.id, input.tags);
    if (fieldWrites.length > 0) {
      await this.db.batch(fieldWrites);
      // Read back rather than hand-built: the values carry their definitions' names and
      // types, which only the database knows.
      return (await this.get(input.id))!;
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
  }

  /**
   * A new note with this one's title, body, filing and field values. Null when the note
   * is not this user's.
   *
   * The body is copied as it is, `files/…` links included: those resolve within the copy
   * once its files exist, which is the caller's next step (`copyAttachments`), and the
   * copy is created first so the files have a note to belong to. Values are carried by
   * field id through the same validation a create gets, so a foreign field the note
   * kept from an earlier notebook comes along too. The title is kept rather than marked
   * "(copy)": the duplicate is opened at once, so which is which is never in doubt, and
   * a name the user did not choose is one they would only have to remove.
   */
  async duplicate(id: string, newId: string): Promise<Note | null> {
    const source = await this.get(id);
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
  }

  /**
   * Returns null when the note does not exist *or* belongs to someone else.
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
   * Costs nothing on top of what this already did. The note was always read at the end to
   * build the return value, and a tags- or fields-only patch did a separate ownership
   * SELECT that this read replaces — it returns null for a note the user does not own. A
   * no-op patch is now strictly cheaper than before: it reads and stops, where it used to
   * write and then read.
   *
   * Comparison is exact, deliberately. Trimming the body would make a genuine edit that
   * only adds trailing space vanish silently, and in Markdown two trailing spaces are a
   * line break.
   */
  async update(
    id: string,
    patch: {
      title?: string;
      body?: string;
      tags?: string[];
      notebook?: string | null;
      fields?: NoteFieldsPatch;
    },
  ): Promise<Note | null> {
    const current = await this.get(id);
    if (!current) return null;

    const effective = this.changedKeysOnly(patch, current);
    // Nothing in the patch differs from what is stored, so the note keeps its date.
    if (effective === null) return current;

    // Field values are validated before anything is written: a value the field cannot
    // hold fails the whole patch rather than landing after the title has changed.
    const fieldWrites =
      effective.fields !== undefined ? await this.prepareFieldWrites(id, effective.fields) : [];

    const sets: string[] = [];
    const binds: unknown[] = [];

    if (effective.title !== undefined) {
      binds.push(effective.title);
      sets.push(`title = ?${binds.length}`);
    }
    if (effective.body !== undefined) {
      binds.push(effective.body);
      sets.push(`body = ?${binds.length}`);
    }
    if (effective.notebook !== undefined) {
      binds.push(await this.resolveNotebook(effective.notebook));
      sets.push(`notebook_id = ?${binds.length}`);
    }

    if (sets.length > 0) {
      binds.push(Date.now());
      sets.push(`updated_at = ?${binds.length}`);
      binds.push(id, this.userId);

      const res = await this.db
        .prepare(
          `UPDATE notes SET ${sets.join(', ')}
            WHERE id = ?${binds.length - 1} AND user_id = ?${binds.length} AND deleted_at IS NULL`,
        )
        .bind(...binds)
        .run();

      // No rows changed means no such note for this user — do not fall through to tags.
      // The read above already established ownership; this catches a delete that landed
      // in between.
      if (res.meta.changes === 0) return null;
    }

    if (effective.tags !== undefined) await this.setTags(id, effective.tags);
    if (fieldWrites.length > 0) {
      await this.db.batch(fieldWrites);
      // Clearing a value can retire the last one a tombstoned definition was holding.
      await this.sweepTombstonedFields();
    }
    if (effective.tags !== undefined || fieldWrites.length > 0) {
      await this.db
        .prepare(`UPDATE notes SET updated_at = ?1 WHERE id = ?2 AND user_id = ?3`)
        .bind(Date.now(), id, this.userId)
        .run();
    }

    return this.get(id);
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
      title?: string;
      body?: string;
      tags?: string[];
      notebook?: string | null;
      fields?: NoteFieldsPatch;
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
   * Done as one statement rather than read-modify-write because D1 has no interactive
   * transactions: two files shared together upload concurrently, and a read-modify-write
   * would let the second overwrite the first's link. Concatenating in SQL means each
   * append is atomic and both survive, though their order is then whichever commits first.
   */
  async appendToBody(id: string, markdown: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE notes
            SET body = CASE WHEN body = '' THEN ?1 ELSE body || char(10) || char(10) || ?1 END,
                updated_at = ?2
          WHERE id = ?3 AND user_id = ?4 AND deleted_at IS NULL`,
      )
      .bind(markdown, Date.now(), id, this.userId)
      .run();
    return res.meta.changes > 0;
  }

  /** Soft delete — trash, not destroy. Returns false when the note is not this user's. */
  async remove(id: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE notes SET deleted_at = ?1
          WHERE id = ?2 AND user_id = ?3 AND deleted_at IS NULL`,
      )
      .bind(Date.now(), id, this.userId)
      .run();
    return res.meta.changes > 0;
  }

  /**
   * Restores a trashed note. Returns false when it is not this user's, or not in the trash.
   *
   * `updated_at` is deliberately left alone: restoring is not an edit, and bumping it would
   * reorder the note to the top of the list as though it had just been written.
   */
  async restore(id: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE notes SET deleted_at = NULL
          WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NOT NULL`,
      )
      .bind(id, this.userId)
      .run();
    return res.meta.changes > 0;
  }

  /** Permanently deletes one trashed note, returning its R2 keys so the blobs can go too. */
  async purgeOne(id: string): Promise<{ deleted: boolean; keys: string[] }> {
    const { results } = await this.db
      .prepare(
        `SELECT a.r2_key FROM attachments a
           JOIN notes n ON n.id = a.note_id
          WHERE n.id = ?1 AND n.user_id = ?2 AND n.deleted_at IS NOT NULL`,
      )
      .bind(id, this.userId)
      .all<{ r2_key: string }>();

    const res = await this.db
      .prepare(`DELETE FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NOT NULL`)
      .bind(id, this.userId)
      .run();

    // This note may have held the last value a tombstoned definition was keeping alive.
    const deleted = res.meta.changes > 0;
    if (deleted) await this.sweepTombstonedFields();

    // No keys unless the row went: a restore between the SELECT and the DELETE would
    // otherwise leave the note live and the route would still delete its files. The
    // singular route already skips the blob sweep when `deleted` is false; returning
    // nothing here keeps that property inside the repo too.
    return { deleted, keys: deleted ? results.map((r) => r.r2_key) : [] };
  }

  /*
     Several notes at once — the list's selection acting as one.

     Each of these is the singular method above applied to a set, with two differences the
     set forces. Ids that are not this user's, or are on the wrong side of the trash, are
     skipped and counted out rather than failing the request: a selection is made from a
     list that can go stale under it — a note trashed from another tab, restored over MCP —
     and one such id must not stop the other forty-nine. And every statement names its notes
     in runs of `ID_RUN`, because D1 caps the binds a statement carries.

     Each answers with the ids it touched rather than a count, so a caller can say which
     of the ids it named were not: the MCP tools report those back to an assistant, and
     the routes reduce the list to the number the web client wants. The ids come from
     `RETURNING id`, not `meta.changes`: a note's row has an FTS trigger on it, and D1
     counts what the trigger writes to the index's shadow tables as changes too —
     trashing two notes reported ten. The singular methods only ask whether the count is
     zero, which that cannot get wrong; these report it.
  */

  /** Trashes several notes. Returns the ids that were — ids already trashed are not among them. */
  async removeMany(ids: string[]): Promise<string[]> {
    const now = Date.now();
    const trashed: string[] = [];
    for (const run of runs([...new Set(ids)])) {
      const { results } = await this.db
        .prepare(
          `UPDATE notes SET deleted_at = ?1
            WHERE user_id = ?2 AND deleted_at IS NULL AND id IN (${placeholders(3, run.length)})
            RETURNING id`,
        )
        .bind(now, this.userId, ...run)
        .all<{ id: string }>();
      trashed.push(...results.map((r) => r.id));
    }
    return trashed;
  }

  /** Restores several trashed notes. `updated_at` stays, as `restore` leaves it. */
  async restoreMany(ids: string[]): Promise<string[]> {
    const restored: string[] = [];
    for (const run of runs([...new Set(ids)])) {
      const { results } = await this.db
        .prepare(
          `UPDATE notes SET deleted_at = NULL
            WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id IN (${placeholders(2, run.length)})
            RETURNING id`,
        )
        .bind(this.userId, ...run)
        .all<{ id: string }>();
      restored.push(...results.map((r) => r.id));
    }
    return restored;
  }

  /**
   * Permanently deletes several trashed notes, returning their R2 keys so the blobs can go
   * too. Only ones already in the trash, as `purgeOne`: a live note named here is left
   * alone, because the two-step delete is the safety property.
   *
   * Keys are only those of notes this actually deleted. The SELECT and the DELETE are not
   * one transaction, and a restore can land between them — the same stale-selection case
   * the skip-not-fail rule is for. Returning every key the SELECT saw would keep the row
   * (the DELETE sees `deleted_at IS NULL` and skips it) and still destroy every file.
   *
   * Sweeps what `purge` sweeps afterwards — tag rows nothing references any more, and
   * field definitions these notes were the last to hold a value for — since a selection
   * can be most of the trash.
   */
  async purgeMany(ids: string[]): Promise<{ deleted: number; keys: string[] }> {
    const keys: string[] = [];
    let deleted = 0;
    for (const run of runs([...new Set(ids)])) {
      const { results } = await this.db
        .prepare(
          `SELECT a.r2_key, n.id AS note_id FROM attachments a
             JOIN notes n ON n.id = a.note_id
            WHERE n.user_id = ?1 AND n.deleted_at IS NOT NULL
              AND n.id IN (${placeholders(2, run.length)})`,
        )
        .bind(this.userId, ...run)
        .all<{ r2_key: string; note_id: string }>();

      const { results: gone } = await this.db
        .prepare(
          `DELETE FROM notes
            WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id IN (${placeholders(2, run.length)})
            RETURNING id`,
        )
        .bind(this.userId, ...run)
        .all<{ id: string }>();
      deleted += gone.length;
      keys.push(...keysOfDeletedNotes(results, gone.map((r) => r.id)));
    }

    if (deleted > 0) {
      await this.db
        .prepare(
          `DELETE FROM tags
            WHERE user_id = ?1
              AND id NOT IN (SELECT tag_id FROM note_tags)`,
        )
        .bind(this.userId)
        .run();
      await this.sweepTombstonedFields();
    }

    return { deleted, keys };
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
   * `matched` is which of the ids were this user's live notes; `changed` which of those
   * were actually written.
   *
   * The writes go in one `batch`, which D1 runs as a transaction, so a failure part way
   * leaves every note refiled or none of them. Tags are added and removed per note rather
   * than set — the notes need not agree with each other — and a tag in both lists is
   * added, the rule `update_note_tags` states over MCP. Tag rows are get-or-create as
   * `setTags` has them; a tag removed from its last note keeps its row, also as `setTags`
   * leaves it, since `listTags` only counts tags on live notes.
   */
  async updateMany(
    ids: string[],
    patch: { notebook?: string | null; addTags?: string[]; removeTags?: string[] },
  ): Promise<{ matched: string[]; changed: string[] }> {
    const add = uniqueTags(patch.addTags ?? []);
    const remove = uniqueTags(patch.removeTags ?? []).filter((t) => !add.includes(t));

    // What each note holds now: its notebook and its tags, one row per note.
    const rows: Array<{ id: string; notebook_id: string | null; tags: string | null }> = [];
    for (const run of runs([...new Set(ids)])) {
      const { results } = await this.db
        .prepare(
          `SELECT n.id, n.notebook_id,
                  (SELECT group_concat(t.name, char(31)) FROM note_tags nt
                     JOIN tags t ON t.id = nt.tag_id
                    WHERE nt.note_id = n.id) AS tags
             FROM notes n
            WHERE n.user_id = ?1 AND n.deleted_at IS NULL
              AND n.id IN (${placeholders(2, run.length)})`,
        )
        .bind(this.userId, ...run)
        .all<{ id: string; notebook_id: string | null; tags: string | null }>();
      rows.push(...results);
    }
    const matched = rows.map((r) => r.id);
    if (rows.length === 0) return { matched, changed: [] };

    // The destination, resolved once — created if it does not exist yet, as `update`
    // would create it for one note. Only once something is going to be filed there.
    const notebookId =
      patch.notebook === undefined ? undefined : await this.resolveNotebook(patch.notebook);

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
    }
    if (changed.size === 0) return { matched, changed: [] };

    const statements: D1PreparedStatement[] = [];

    for (const run of runs(moving)) {
      statements.push(
        this.db
          .prepare(
            `UPDATE notes SET notebook_id = ?1
              WHERE user_id = ?2 AND deleted_at IS NULL AND id IN (${placeholders(3, run.length)})`,
          )
          .bind(notebookId, this.userId, ...run),
      );
    }

    // Tag rows before the joins that look them up.
    for (const name of adding.keys()) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO tags (id, user_id, name) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, name) DO NOTHING`,
          )
          .bind(crypto.randomUUID(), this.userId, name),
      );
    }
    for (const [name, noteIds] of adding) {
      for (const run of runs(noteIds)) {
        statements.push(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
               SELECT n.id, t.id FROM notes n
                 JOIN tags t ON t.user_id = n.user_id AND t.name = ?1
                WHERE n.user_id = ?2 AND n.id IN (${placeholders(3, run.length)})`,
            )
            .bind(name, this.userId, ...run),
        );
      }
    }
    for (const [name, noteIds] of removing) {
      for (const run of runs(noteIds)) {
        statements.push(
          this.db
            .prepare(
              `DELETE FROM note_tags
                WHERE tag_id = (SELECT id FROM tags WHERE user_id = ?1 AND name = ?2)
                  AND note_id IN (${placeholders(3, run.length)})`,
            )
            .bind(this.userId, name, ...run),
        );
      }
    }

    const now = Date.now();
    for (const run of runs([...changed])) {
      statements.push(
        this.db
          .prepare(
            `UPDATE notes SET updated_at = ?1
              WHERE user_id = ?2 AND id IN (${placeholders(3, run.length)})`,
          )
          .bind(now, this.userId, ...run),
      );
    }

    await this.db.batch(statements);
    return { matched, changed: [...changed] };
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
  async importNote(input: {
    /** The id to keep if it is free, and to recognise the note by if it is already here. */
    id?: string | undefined;
    title: string;
    body: string;
    tags: string[];
    notebook?: string;
    createdAt: number;
    updatedAt: number;
    contentHash: string;
    sourceEnex?: string;
    /** By field name; see `applyImportedFields`. */
    fields?: Record<string, FieldValue>;
  }): Promise<{ id: string; created: boolean; skippedFields: string[] }> {
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
    // Whether the id is already held is settled once here: the guard below reads it, and
    // so does the mint at the foot of this method, which used to ask the database again.
    const idIsTaken = input.id ? await this.idTaken(input.id) : false;
    const existingById = input.id ? await this.liveNoteById(input.id) : null;
    // A free id is a different note however its text hashes, so there is nothing for a
    // hash hit to swallow — don't even look. The hash lookup only earns its round-trip
    // when the id is absent (an ENEX import) or taken (a remint resuming a prior run).
    const existingByHash =
      existingById || (input.id && !idIsTaken)
        ? null
        : await this.liveNoteByHash(input.contentHash);
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
      if (input.notebook) {
        const notebookId = await this.resolveNotebook(input.notebook);
        await this.db
          .prepare(
            `UPDATE notes SET notebook_id = ?1
              WHERE id = ?2 AND user_id = ?3 AND notebook_id IS NULL`,
          )
          .bind(notebookId, existing.id, this.userId)
          .run();
        // Same rule as the re-file above: restore values a deleted field took with it,
        // but never overwrite a value the person has since changed.
        if (notebookId && input.fields) {
          skippedFields = await this.applyImportedFields(existing.id, notebookId, input.fields, true);
        }
      } else if (input.fields) {
        skippedFields = Object.keys(input.fields);
      }
      return { id: existing.id, created: false, skippedFields };
    }

    /**
     * Keep the exported id when nothing holds it. The check spans every user and the
     * trash, because the column is the table's primary key: the same archive imported
     * by two people on one instance — a notebook shared as a zip — gives the second a
     * fresh id rather than a constraint error, and a trashed note keeps its id so it can
     * still be restored from the trash.
     */
    const id = input.id && !idIsTaken ? input.id : crypto.randomUUID();
    const notebookId = await this.resolveNotebook(input.notebook);
    await this.db
      .prepare(
        `INSERT INTO notes
           (id, user_id, title, body, created_at, updated_at, content_hash, source_enex, notebook_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        id,
        this.userId,
        input.title,
        input.body,
        input.createdAt,
        input.updatedAt,
        input.contentHash,
        input.sourceEnex ?? null,
        notebookId,
      )
      .run();

    if (input.tags.length > 0) await this.setTags(id, input.tags);

    // Fields belong to a notebook, so an unfiled import has nowhere to put them.
    let skippedFields: string[] = [];
    if (input.fields) {
      skippedFields = notebookId
        ? await this.applyImportedFields(id, notebookId, input.fields, false)
        : Object.keys(input.fields);
    }

    return { id, created: true, skippedFields };
  }

  /** The caller's live note with this id, if there is one. */
  private async liveNoteById(id: string): Promise<{ id: string } | null> {
    return this.db
      .prepare(`SELECT id FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
      .bind(id, this.userId)
      .first<{ id: string }>();
  }

  /** The caller's live note carrying this content hash, if there is one. */
  private async liveNoteByHash(contentHash: string): Promise<{ id: string } | null> {
    return this.db
      .prepare(
        `SELECT id FROM notes
          WHERE user_id = ?1 AND content_hash = ?2 AND deleted_at IS NULL
          LIMIT 1`,
      )
      .bind(this.userId, contentHash)
      .first<{ id: string }>();
  }

  /** True when any row — anyone's, trashed or not — already has this id. */
  private async idTaken(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS hit FROM notes WHERE id = ?1`)
      .bind(id)
      .first<{ hit: number }>();
    return row !== null;
  }

  /** Replaces a note's body after its attachment links are known. */
  async setBody(id: string, body: string): Promise<void> {
    await this.db
      .prepare(`UPDATE notes SET body = ?1 WHERE id = ?2 AND user_id = ?3`)
      .bind(body, id, this.userId)
      .run();
  }

  /**
   * Full-text search, newest-relevant first.
   *
   * notes_fts has no user_id — it indexes only title and body — so the join back to notes
   * is what scopes the result, and dropping that predicate would leak every user's notes.
   */
  async search(
    rawQuery: string,
    limit: number,
    filters: {
      tags?: string[] | undefined;
      notebook?: string | undefined;
      fields?: FieldFilter[] | undefined;
      from?: string | undefined;
      to?: string | undefined;
    } = {},
  ): Promise<SearchResult[]> {
    const query = toFtsQuery(rawQuery);
    if (!query) return [];

    /**
     * The filters bind after the three fixed parameters, and the same clauses are spliced
     * into both CTEs — each joins `notes n` on its own, so a filter applied to only one
     * would let the other leak notes from outside the current scope.
     */
    const binds: unknown[] = [query, this.userId, limit];
    const scope = filterConditions(filters, binds, this.userId);
    const scoped = scope.length > 0 ? `AND ${scope.join(' AND ')}` : '';

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
     */
    const { results } = await this.db
      .prepare(
        `WITH note_hits AS (
           SELECT n.id, n.title, n.updated_at,
                  snippet(notes_fts, 1, '<<', '>>', '…', 24) AS snippet,
                  NULL AS matched_file,
                  NULL AS matched_field,
                  NULL AS matched_tag,
                  bm25(notes_fts, 10.0, 1.0) AS rank,
                  0 AS tier
             FROM notes_fts
             JOIN notes n ON n.rowid = notes_fts.rowid
            WHERE notes_fts MATCH ?1 AND n.user_id = ?2 AND n.deleted_at IS NULL
              ${scoped}
         ),
         tag_hits AS (
           SELECT n.id, n.title, n.updated_at,
                  snippet(tags_fts, 0, '<<', '>>', '…', 24) AS snippet,
                  NULL AS matched_file,
                  NULL AS matched_field,
                  t.name AS matched_tag,
                  bm25(tags_fts) AS rank,
                  1 AS tier
             FROM tags_fts
             JOIN tags t ON t.rowid = tags_fts.rowid
             JOIN note_tags nt ON nt.tag_id = t.id
             JOIN notes n ON n.id = nt.note_id
            WHERE tags_fts MATCH ?1 AND t.user_id = ?2
              AND n.user_id = ?2 AND n.deleted_at IS NULL
              ${scoped}
         ),
         field_hits AS (
           SELECT n.id, n.title, n.updated_at,
                  snippet(note_fields_fts, 0, '<<', '>>', '…', 24) AS snippet,
                  NULL AS matched_file,
                  f.name AS matched_field,
                  NULL AS matched_tag,
                  bm25(note_fields_fts) AS rank,
                  2 AS tier
             FROM note_fields_fts
             JOIN note_fields nf ON nf.rowid = note_fields_fts.rowid
             JOIN notebook_fields f ON f.id = nf.field_id
             JOIN notes n ON n.id = nf.note_id
            WHERE note_fields_fts MATCH ?1 AND nf.user_id = ?2
              AND n.user_id = ?2 AND n.deleted_at IS NULL
              ${scoped}
         ),
         file_hits AS (
           SELECT n.id, n.title, n.updated_at,
                  snippet(attachment_text_fts, 0, '<<', '>>', '…', 24) AS snippet,
                  at.filename AS matched_file,
                  NULL AS matched_field,
                  NULL AS matched_tag,
                  bm25(attachment_text_fts) AS rank,
                  3 AS tier
             FROM attachment_text_fts
             JOIN attachment_text at ON at.rowid = attachment_text_fts.rowid
             JOIN notes n ON n.id = at.note_id
            WHERE attachment_text_fts MATCH ?1 AND at.user_id = ?2
              AND n.user_id = ?2 AND n.deleted_at IS NULL
              ${scoped}
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
          ORDER BY tier, rank
          LIMIT ?3`,
      )
      .bind(...binds)
      .all<{
        id: string;
        title: string;
        updated_at: number;
        snippet: string;
        matched_file: string | null;
        matched_field: string | null;
        matched_tag: string | null;
      }>();

    return results.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      snippet: r.snippet,
      ...(r.matched_file ? { matchedFile: r.matched_file } : {}),
      ...(r.matched_field ? { matchedField: r.matched_field } : {}),
      ...(r.matched_tag ? { matchedTag: r.matched_tag } : {}),
    }));
  }

  /**
   * Permanently removes notes, with their tags and attachment rows.
   *
   * Distinct from `remove`, which is a soft delete the user can undo. This is the
   * irreversible one, so it returns the R2 keys it orphaned rather than deleting blobs
   * itself — the caller sweeps them, and a failure there leaves recoverable garbage
   * rather than a half-deleted note.
   *
   * `scope: 'trashed'` empties the trash; `scope: 'all'` wipes the account's notes.
   *
   * Emptying the trash re-checks `deleted_at` on the DELETE, the way `purgeMany` does: a
   * restore between listing the trash and destroying it must leave the note, not take a
   * live note with it. `scope: 'all'` is a wipe, so it still deletes whatever it named.
   */
  async purge(scope: 'trashed' | 'all'): Promise<{ notes: number; keys: string[] }> {
    const where =
      scope === 'trashed' ? 'user_id = ?1 AND deleted_at IS NOT NULL' : 'user_id = ?1';

    const { results: keyRows } = await this.db
      .prepare(
        `SELECT a.r2_key, n.id AS note_id FROM attachments a
           JOIN notes n ON n.id = a.note_id
          WHERE n.${where} AND a.user_id = ?1`,
      )
      .bind(this.userId)
      .all<{ r2_key: string; note_id: string }>();

    const { results: idRows } = await this.db
      .prepare(`SELECT id FROM notes WHERE ${where}`)
      .bind(this.userId)
      .all<{ id: string }>();

    if (idRows.length === 0) return { notes: 0, keys: [] };

    // Delete in batches: D1 caps bound parameters at 100 per statement, and note_tags,
    // attachments, and attachment_text all cascade from notes. Empty-trash re-checks
    // `deleted_at` so a note restored after the listing is not destroyed as a live one.
    const stillTrashed = scope === 'trashed' ? ' AND deleted_at IS NOT NULL' : '';
    const ids = idRows.map((r) => r.id);
    const deletedIds: string[] = [];
    for (let i = 0; i < ids.length; i += 99) {
      const batch = ids.slice(i, i + 99);
      const placeholders = batch.map((_, j) => `?${j + 2}`).join(', ');
      const { results: gone } = await this.db
        .prepare(
          `DELETE FROM notes WHERE user_id = ?1${stillTrashed} AND id IN (${placeholders})
           RETURNING id`,
        )
        .bind(this.userId, ...batch)
        .all<{ id: string }>();
      deletedIds.push(...gone.map((r) => r.id));
    }

    if (deletedIds.length === 0) return { notes: 0, keys: [] };

    // Tag rows are per-user and survive their notes; drop the ones nothing references.
    await this.db
      .prepare(
        `DELETE FROM tags
          WHERE user_id = ?1
            AND id NOT IN (SELECT tag_id FROM note_tags)`,
      )
      .bind(this.userId)
      .run();

    // The same for field definitions kept alive only by the values on these notes.
    await this.sweepTombstonedFields();

    return { notes: deletedIds.length, keys: keysOfDeletedNotes(keyRows, deletedIds) };
  }

  /**
   * Every tag this user has in use, with note counts, most-used first.
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
  async listTags(): Promise<Array<{ id: string; name: string; count: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT t.id, t.name, COUNT(nt.note_id) AS count
           FROM tags t
           JOIN note_tags nt ON nt.tag_id = t.id
           JOIN notes n ON n.id = nt.note_id AND n.deleted_at IS NULL
          WHERE t.user_id = ?1
          GROUP BY t.id, t.name
          ORDER BY count DESC, t.name COLLATE NOCASE`,
      )
      .bind(this.userId)
      .all<{ id: string; name: string; count: number }>();
    return results;
  }

  /**
   * A few recent titles from each notebook and each tag, as examples of what is filed
   * where, for auto-fill to show the model beside each name.
   *
   * A notebook called "Misc" or a tag called "2019" says nothing on its own; three titles
   * from it say what a person has been putting there. Recent rather than random, so the
   * examples follow how the archive is used now. Untitled notes and the note being filed
   * are left out — one has nothing to show and the other is the question. One query per
   * kind, numbered within each group, so an archive of thirteen thousand notes costs two
   * scans rather than a query per notebook.
   */
  async sampleTitles(
    exclude: string,
    perGroup: number,
  ): Promise<{ notebooks: Map<string, string[]>; tags: Map<string, string[]> }> {
    const [byNotebook, byTag] = await this.db.batch([
      this.db
        .prepare(
          `SELECT group_id, title FROM (
             SELECT n.notebook_id AS group_id, n.title,
                    ROW_NUMBER() OVER (PARTITION BY n.notebook_id ORDER BY n.updated_at DESC) AS rn
               FROM notes n
              WHERE n.user_id = ?1 AND n.deleted_at IS NULL AND n.notebook_id IS NOT NULL
                AND n.title <> '' AND n.id <> ?2
           ) WHERE rn <= ?3`,
        )
        .bind(this.userId, exclude, perGroup),
      this.db
        .prepare(
          `SELECT group_id, title FROM (
             SELECT nt.tag_id AS group_id, n.title,
                    ROW_NUMBER() OVER (PARTITION BY nt.tag_id ORDER BY n.updated_at DESC) AS rn
               FROM note_tags nt
               JOIN tags t ON t.id = nt.tag_id AND t.user_id = ?1
               JOIN notes n ON n.id = nt.note_id AND n.user_id = ?1 AND n.deleted_at IS NULL
              WHERE n.title <> '' AND n.id <> ?2
           ) WHERE rn <= ?3`,
        )
        .bind(this.userId, exclude, perGroup),
    ]);
    const group = (rows: { results: Array<{ group_id: string; title: string }> }) => {
      const out = new Map<string, string[]>();
      for (const row of rows.results) {
        const list = out.get(row.group_id) ?? [];
        list.push(row.title);
        out.set(row.group_id, list);
      }
      return out;
    };
    return {
      notebooks: group(byNotebook as { results: Array<{ group_id: string; title: string }> }),
      tags: group(byTag as { results: Array<{ group_id: string; title: string }> }),
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
  async renameTag(
    id: string,
    name: string,
    opts?: { merge?: boolean },
  ): Promise<{ id: string; name: string; merged: boolean } | 'conflict' | 'missing'> {
    const trimmed = name.trim();
    if (!trimmed) return 'missing';

    const own = await this.db
      .prepare(`SELECT name FROM tags WHERE id = ?1 AND user_id = ?2`)
      .bind(id, this.userId)
      .first<{ name: string }>();
    if (!own) return 'missing';
    if (own.name === trimmed) return { id, name: trimmed, merged: false };

    const other = await this.db
      .prepare(`SELECT id FROM tags WHERE user_id = ?1 AND name = ?2 AND id <> ?3`)
      .bind(this.userId, trimmed, id)
      .first<{ id: string }>();

    if (!other) {
      await this.db
        .prepare(`UPDATE tags SET name = ?1 WHERE id = ?2 AND user_id = ?3`)
        .bind(trimmed, id, this.userId)
        .run();
      return { id, name: trimmed, merged: false };
    }

    if (!opts?.merge) return 'conflict';

    // Batched so a note can never be left with neither tag. The join rows are removed by
    // hand rather than by ON DELETE CASCADE, which D1 does not promise is enforced.
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO note_tags (note_id, tag_id)
             SELECT note_id, ?1 FROM note_tags WHERE tag_id = ?2`,
        )
        .bind(other.id, id),
      this.db.prepare(`DELETE FROM note_tags WHERE tag_id = ?1`).bind(id),
      this.db.prepare(`DELETE FROM tags WHERE id = ?1 AND user_id = ?2`).bind(id, this.userId),
    ]);
    return { id: other.id, name: trimmed, merged: true };
  }

  /**
   * Deletes a tag, taking it off every note that carries it — trashed notes included, so
   * a restore cannot bring a deleted tag back. The notes themselves are untouched; a tag
   * is a label, and removing a label must never remove what it labelled.
   */
  async deleteTag(id: string): Promise<boolean> {
    const owned = await this.db
      .prepare(`SELECT 1 FROM tags WHERE id = ?1 AND user_id = ?2`)
      .bind(id, this.userId)
      .first();
    if (!owned) return false;

    await this.db.batch([
      this.db.prepare(`DELETE FROM note_tags WHERE tag_id = ?1`).bind(id),
      this.db.prepare(`DELETE FROM tags WHERE id = ?1 AND user_id = ?2`).bind(id, this.userId),
    ]);
    return true;
  }

  /**
   * How many of this user's notes sit in no notebook.
   *
   * Counted separately from `listNotebooks` because unfiled notes belong to no row there:
   * the scope selector needs the number to decide whether "Unfiled" is worth offering.
   */
  async countUnfiledNotes(): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM notes
          WHERE user_id = ?1 AND notebook_id IS NULL AND deleted_at IS NULL`,
      )
      .bind(this.userId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  /**
   * Every notebook this user has, with note and field counts, for the sidebar scope
   * selector and the management page.
   */
  async listNotebooks(): Promise<NotebookSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT nb.id, nb.name, nb.purpose,
                COUNT(n.id) AS count,
                (SELECT COUNT(*) FROM notebook_fields f
                  WHERE f.notebook_id = nb.id AND f.deleted_at IS NULL) AS fields
           FROM notebooks nb
           LEFT JOIN notes n
             ON n.notebook_id = nb.id AND n.deleted_at IS NULL AND n.user_id = ?1
          WHERE nb.user_id = ?1
          GROUP BY nb.id, nb.name, nb.purpose
          ORDER BY nb.name COLLATE NOCASE`,
      )
      .bind(this.userId)
      .all<NotebookSummary>();
    return results;
  }

  /**
   * Replace a note's tags. Callers must already have verified ownership of `noteId`.
   *
   * D1 has no interactive transactions, so this uses batch() for atomicity. Tag rows are
   * per-user, so two users using "work" get separate rows and never observe each other's.
   */
  /**
   * Maps a notebook name to its id, creating the notebook if it is new.
   *
   * Get-or-create rather than reject: filing a note into a notebook that does not exist yet
   * is the ordinary way notebooks come into being, both from the editor and from an import.
   * The lookup is case-insensitive and runs after the insert, so a name differing only in
   * case resolves to the notebook that already exists rather than failing on the unique
   * constraint.
   */
  private async resolveNotebook(name: string | null | undefined): Promise<string | null> {
    const trimmed = name?.trim();
    if (!trimmed) return null;

    await this.db
      .prepare(
        `INSERT INTO notebooks (id, user_id, name, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, name) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), this.userId, trimmed, Date.now())
      .run();

    const row = await this.db
      .prepare(`SELECT id FROM notebooks WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE`)
      .bind(this.userId, trimmed)
      .first<{ id: string }>();

    return row?.id ?? null;
  }

  /** Creates an empty notebook. Returns null when the name is already taken. */
  async createNotebook(name: string): Promise<{ id: string; name: string } | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;

    const res = await this.db
      .prepare(
        `INSERT INTO notebooks (id, user_id, name, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, name) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), this.userId, trimmed, Date.now())
      .run();

    // No row inserted means the name already exists, case-insensitively.
    if (res.meta.changes === 0) return null;

    const row = await this.db
      .prepare(`SELECT id, name FROM notebooks WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE`)
      .bind(this.userId, trimmed)
      .first<{ id: string; name: string }>();

    return row ?? null;
  }

  /**
   * Updates a notebook's name and/or purpose. Returns 'conflict' when a new name is already
   * taken by another notebook, case-insensitively.
   *
   * When `name` is given, every note follows automatically because they reference the id —
   * the rename is a single row update, which is the point of the notebook being an entity at
   * all. `purpose` given as `null` clears it. An omitted key is left untouched, so the same
   * method serves the rename-only path (route, MCP) and the purpose editor without either
   * disturbing the other's column.
   */
  async updateNotebook(
    id: string,
    patch: { name?: string; purpose?: string | null },
  ): Promise<'ok' | 'conflict' | 'missing'> {
    const sets: string[] = [];
    const binds: unknown[] = [];

    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) return 'missing';

      const clash = await this.db
        .prepare(
          `SELECT 1 FROM notebooks
            WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3`,
        )
        .bind(this.userId, trimmed, id)
        .first();
      if (clash) return 'conflict';

      sets.push(`name = ?${binds.length + 1}`);
      binds.push(trimmed);
    }

    if (patch.purpose !== undefined) {
      sets.push(`purpose = ?${binds.length + 1}`);
      binds.push(patch.purpose);
    }

    // Nothing to change: still tell the caller whether the notebook is theirs, so a PATCH
    // with an empty body 404s on a bad id rather than silently reporting success.
    if (sets.length === 0) {
      const row = await this.db
        .prepare(`SELECT 1 FROM notebooks WHERE id = ?1 AND user_id = ?2`)
        .bind(id, this.userId)
        .first();
      return row ? 'ok' : 'missing';
    }

    const res = await this.db
      .prepare(
        `UPDATE notebooks SET ${sets.join(', ')}
          WHERE id = ?${binds.length + 1} AND user_id = ?${binds.length + 2}`,
      )
      .bind(...binds, id, this.userId)
      .run();

    return res.meta.changes > 0 ? 'ok' : 'missing';
  }

  /**
   * Deletes a notebook.
   *
   * Default: notes survive, unfiled. With `trashNotes`, live notes in the notebook are
   * soft-deleted into the trash (already-trashed ones keep their `deleted_at`) and then
   * unfiled — restoring later must not point at a notebook that no longer exists.
   *
   * Notes are unfiled explicitly rather than relying on `ON DELETE SET NULL`, because D1
   * does not guarantee foreign key enforcement is on for a given connection. Batched so a
   * note can never be left pointing at a notebook row that is gone.
   *
   * No value is destroyed, whichever branch runs. The field definitions are tombstoned
   * (0017) rather than deleted, so every value keyed to them stays readable on the note
   * that holds it — including on a note cascaded to the trash, which is what makes that
   * cascade the recoverable operation its button claims. The definitions carry the
   * notebook's name with them so the values keep their "from Coupons" label after this
   * row is gone.
   *
   * Deleting the values here was the older behaviour and was wrong twice: it was scoped
   * by field rather than by note, so it also stripped notes that had left the notebook
   * long before, contradicting 0014's promise that a note keeps the values it has when
   * it moves.
   */
  async deleteNotebook(id: string, opts?: { trashNotes?: boolean }): Promise<boolean> {
    const owned = await this.db
      .prepare(`SELECT 1 FROM notebooks WHERE id = ?1 AND user_id = ?2`)
      .bind(id, this.userId)
      .first();
    if (!owned) return false;

    const noteUpdate = opts?.trashNotes
      ? this.db
          .prepare(
            `UPDATE notes
                SET deleted_at = COALESCE(deleted_at, ?1), notebook_id = NULL
              WHERE notebook_id = ?2 AND user_id = ?3`,
          )
          .bind(Date.now(), id, this.userId)
      : this.db
          .prepare(`UPDATE notes SET notebook_id = NULL WHERE notebook_id = ?1 AND user_id = ?2`)
          .bind(id, this.userId);

    await this.db.batch([
      noteUpdate,
      // The definitions are tombstoned rather than deleted, taking the notebook's name
      // with them: it is the label the values are read back with, and the row that
      // carried it is about to go. Batched with that delete so a definition is never
      // briefly live with no notebook behind it.
      this.db
        .prepare(
          `UPDATE notebook_fields
              SET deleted_at = ?1,
                  notebook_name = (SELECT name FROM notebooks WHERE id = ?2)
            WHERE notebook_id = ?2 AND user_id = ?3 AND deleted_at IS NULL`,
        )
        .bind(Date.now(), id, this.userId),
      this.db.prepare(`DELETE FROM notebooks WHERE id = ?1 AND user_id = ?2`).bind(id, this.userId),
    ]);

    // A notebook with no values to preserve leaves nothing worth keeping, so its
    // tombstones go at once rather than waiting for a note that will never reference them.
    await this.sweepTombstonedFields();

    return true;
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
   * Run after any delete that can drop the last reference. It is a single statement over
   * this user's rows, and a no-op when there is nothing to sweep.
   */
  private async sweepTombstonedFields(): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM notebook_fields
          WHERE user_id = ?1 AND deleted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM note_fields nf WHERE nf.field_id = notebook_fields.id)`,
      )
      .bind(this.userId)
      .run();
  }

  // --- Custom fields -------------------------------------------------------------------

  /**
   * A notebook's field definitions in display order, with how many notes hold a value for
   * each (the management page names that count before a delete). Null when the notebook
   * is not this user's, so the route can answer 404 without a second query.
   *
   * Tombstones cannot reach here — the notebook they belonged to is gone, so the guard
   * above already answers null — but they are excluded explicitly so the query reads as
   * what it means rather than relying on that.
   */
  async listFields(notebookId: string): Promise<FieldDef[] | null> {
    const owned = await this.db
      .prepare(`SELECT 1 FROM notebooks WHERE id = ?1 AND user_id = ?2`)
      .bind(notebookId, this.userId)
      .first();
    if (!owned) return null;

    const { results } = await this.db
      .prepare(
        `SELECT f.id, f.notebook_id, f.name, f.type, f.options, f.scale_max, f.scale_step, f.currency, f.position,
                (SELECT COUNT(*) FROM note_fields nf WHERE nf.field_id = f.id) AS value_count
           FROM notebook_fields f
          WHERE f.notebook_id = ?1 AND f.user_id = ?2 AND f.deleted_at IS NULL
          ORDER BY f.position`,
      )
      .bind(notebookId, this.userId)
      .all<FieldRow>();
    return results.map(rowToField);
  }

  /**
   * One field definition by id, or null when it is not this user's. Resolved by the list
   * route so a sort by a field is built from its type and an unknown id is a 400 before
   * any note is read.
   *
   * A tombstone answers null: sorting or filtering by a field whose notebook was deleted
   * is a 400, the same as an id that never existed. The values it still keys are readable
   * on the notes that hold them, but it is no longer something to query by.
   */
  async fieldById(id: string): Promise<FieldDef | null> {
    const row = await this.db
      .prepare(
        `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
           FROM notebook_fields WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
      )
      .bind(id, this.userId)
      .first<FieldRow>();
    return row ? rowToField(row) : null;
  }

  /**
   * Every field this user has defined, across notebooks, for a listing that shows them
   * all. Tombstones are excluded: their notebook is gone, so there is nothing to list
   * them under.
   */
  async listAllFields(): Promise<FieldDef[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
           FROM notebook_fields WHERE user_id = ?1 AND deleted_at IS NULL
          ORDER BY notebook_id, position`,
      )
      .bind(this.userId)
      .all<FieldRow>();
    return results.map(rowToField);
  }

  /**
   * Adds a field to a notebook, at the end.
   *
   * Names are checked before the insert rather than caught on the unique constraint so
   * the three outcomes stay distinct — a missing notebook, a taken name and a full
   * notebook each get their own status upstream.
   */
  async createField(
    notebookId: string,
    input: {
      name: string;
      type: FieldType;
      options: string[];
      scale?: FieldScale | null;
      currency?: string | null;
    },
  ): Promise<FieldDef | 'missing' | 'conflict' | 'full'> {
    const owned = await this.db
      .prepare(`SELECT 1 FROM notebooks WHERE id = ?1 AND user_id = ?2`)
      .bind(notebookId, this.userId)
      .first();
    if (!owned) return 'missing';

    const count = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notebook_fields
          WHERE notebook_id = ?1 AND deleted_at IS NULL`,
      )
      .bind(notebookId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_FIELDS_PER_NOTEBOOK) return 'full';

    const clash = await this.db
      .prepare(
        `SELECT 1 FROM notebook_fields
          WHERE notebook_id = ?1 AND name = ?2 COLLATE NOCASE AND deleted_at IS NULL`,
      )
      .bind(notebookId, input.name)
      .first();
    if (clash) return 'conflict';

    const id = crypto.randomUUID();
    const scale = scaleColumns(input.type, input.scale);
    await this.db
      .prepare(
        `INSERT INTO notebook_fields
           (id, user_id, notebook_id, name, type, options, scale_max, scale_step, currency, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM notebook_fields
                   WHERE notebook_id = ?3 AND deleted_at IS NULL),
                 ?10)`,
      )
      .bind(
        id,
        this.userId,
        notebookId,
        input.name,
        input.type,
        optionsColumn(input.type, input.options),
        scale.max,
        scale.step,
        currencyColumn(input.type, input.scale, input.currency),
        Date.now(),
      )
      .run();

    return (await this.getField(notebookId, id)) ?? 'missing';
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
  async updateField(
    notebookId: string,
    fieldId: string,
    patch: {
      name?: string;
      type?: FieldType;
      options?: string[];
      scale?: FieldScale | null;
      currency?: string | null;
    },
  ): Promise<{ field: FieldDef; cleared: number } | 'missing' | 'conflict'> {
    const current = await this.getField(notebookId, fieldId);
    if (!current) return 'missing';

    if (patch.name !== undefined && patch.name.toLowerCase() !== current.name.toLowerCase()) {
      const clash = await this.db
        .prepare(
          `SELECT 1 FROM notebook_fields
            WHERE notebook_id = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3
              AND deleted_at IS NULL`,
        )
        .bind(notebookId, patch.name, fieldId)
        .first();
      if (clash) return 'conflict';
    }

    let options = patch.options ?? current.options;
    let cleared = 0;
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
      const converted = await this.convertFieldValues(fieldId, current.type, type, scale);
      cleared = converted.cleared;
      if (converted.seededOptions) options = converted.seededOptions;
    }

    await this.db
      .prepare(
        `UPDATE notebook_fields
            SET name = ?1, type = ?2, options = ?3, scale_max = ?4, scale_step = ?5, currency = ?6
          WHERE id = ?7 AND notebook_id = ?8 AND user_id = ?9`,
      )
      .bind(
        patch.name ?? current.name,
        type,
        optionsColumn(type, options),
        stored.max,
        stored.step,
        currency,
        fieldId,
        notebookId,
        this.userId,
      )
      .run();

    const field = await this.getField(notebookId, fieldId);
    return field ? { field, cleared } : 'missing';
  }

  /**
   * What a type change would do, without doing it. The same plan the write uses, so the
   * number the confirmation names is the number that will be cleared.
   */
  async previewConversion(
    notebookId: string,
    fieldId: string,
    to: FieldType,
    toScale?: FieldScale | null,
  ): Promise<{ values: number; incompatible: number } | null> {
    const field = await this.getField(notebookId, fieldId);
    if (!field) return null;
    const rows = await this.fieldValueRows(fieldId);
    // Matches `updateField`: an absent scale in the patch means the current one stands, so
    // previewing a rename or a pure type change does not silently unbound the field.
    const plan = planConversion(field.type, to, rows, toScale === undefined ? field.scale : toScale);
    return { values: rows.length, incompatible: plan.drop.length };
  }

  /** Sets a notebook's field order. `ids` must be exactly its fields, each once. */
  async reorderFields(notebookId: string, ids: string[]): Promise<boolean> {
    const { results } = await this.db
      .prepare(`SELECT id FROM notebook_fields
            WHERE notebook_id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
      .bind(notebookId, this.userId)
      .all<{ id: string }>();
    const have = new Set(results.map((r) => r.id));
    if (have.size === 0 || have.size !== ids.length || !ids.every((id) => have.has(id))) {
      return false;
    }
    if (new Set(ids).size !== ids.length) return false;

    await this.db.batch(
      ids.map((id, position) =>
        this.db
          .prepare(`UPDATE notebook_fields SET position = ?1 WHERE id = ?2 AND user_id = ?3`)
          .bind(position, id, this.userId),
      ),
    );
    return true;
  }

  /**
   * Deletes a field and every value held under it.
   *
   * The values go explicitly rather than by `ON DELETE CASCADE`, for the reason
   * `deleteNotebook` gives: D1 does not promise foreign keys are enforced. Batched so a
   * value can never outlive its definition.
   */
  async deleteField(notebookId: string, fieldId: string): Promise<boolean> {
    const field = await this.getField(notebookId, fieldId);
    if (!field) return false;

    await this.db.batch([
      this.db
        .prepare(`DELETE FROM note_fields WHERE field_id = ?1 AND user_id = ?2`)
        .bind(fieldId, this.userId),
      this.db
        .prepare(`DELETE FROM notebook_fields WHERE id = ?1 AND user_id = ?2`)
        .bind(fieldId, this.userId),
    ]);
    return true;
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
  async countOptionUsage(
    notebookId: string,
    fieldId: string,
    option: string,
  ): Promise<number | null> {
    const field = await this.getField(notebookId, fieldId);
    if (!field || !fieldHasOptions(field.type)) return null;

    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM note_fields
          WHERE field_id = ?1 AND user_id = ?2
            AND (value_text = ?3 OR (json_valid(value_text)
                 AND json_type(value_text) = 'array'
                 AND EXISTS (SELECT 1 FROM json_each(value_text) WHERE json_each.value = ?3)))`,
      )
      .bind(fieldId, this.userId, option)
      .first<{ n: number }>();
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
  async removeFieldOption(
    notebookId: string,
    fieldId: string,
    option: string,
    clear: boolean,
  ): Promise<{ field: FieldDef; cleared: number } | null> {
    const field = await this.getField(notebookId, fieldId);
    if (!field || !fieldHasOptions(field.type)) return null;
    if (!field.options.includes(option)) return null;

    let cleared = 0;
    if (clear) {
      const rows = await this.fieldValueRows(fieldId);
      const statements: D1PreparedStatement[] = [];
      for (const { noteId, text } of rows) {
        // A multi-select stores a JSON list; a select stores the bare option. Only rows
        // that actually hold the option are touched, so an unrelated value is never
        // rewritten (which would bump its row for no reason).
        if (field.type === 'multiselect' && isJsonArray(text)) {
          const list = JSON.parse(text) as string[];
          if (!list.includes(option)) continue;
          const remaining = list.filter((o) => o !== option);
          statements.push(
            remaining.length === 0
              ? this.db
                  .prepare(`DELETE FROM note_fields WHERE note_id = ?1 AND field_id = ?2 AND user_id = ?3`)
                  .bind(noteId, fieldId, this.userId)
              : this.db
                  .prepare(
                    `UPDATE note_fields SET value_text = ?1
                      WHERE note_id = ?2 AND field_id = ?3 AND user_id = ?4`,
                  )
                  .bind(JSON.stringify(remaining), noteId, fieldId, this.userId),
          );
          cleared += 1;
        } else if (text === option) {
          statements.push(
            this.db
              .prepare(`DELETE FROM note_fields WHERE note_id = ?1 AND field_id = ?2 AND user_id = ?3`)
              .bind(noteId, fieldId, this.userId),
          );
          cleared += 1;
        }
      }
      for (let i = 0; i < statements.length; i += 50) {
        await this.db.batch(statements.slice(i, i + 50));
      }
    }

    const updated = await this.updateField(notebookId, fieldId, {
      options: field.options.filter((o) => o !== option),
    });
    if (typeof updated === 'string') return null;
    return { field: updated.field, cleared };
  }

  private async getField(notebookId: string, fieldId: string): Promise<FieldDef | null> {
    const row = await this.db
      .prepare(
        `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
           FROM notebook_fields
          WHERE id = ?1 AND notebook_id = ?2 AND user_id = ?3 AND deleted_at IS NULL`,
      )
      .bind(fieldId, notebookId, this.userId)
      .first<FieldRow>();
    return row ? rowToField(row) : null;
  }

  private async fieldValueRows(fieldId: string): Promise<Array<{ noteId: string; text: string }>> {
    const { results } = await this.db
      .prepare(`SELECT note_id, value_text FROM note_fields WHERE field_id = ?1 AND user_id = ?2`)
      .bind(fieldId, this.userId)
      .all<{ note_id: string; value_text: string }>();
    return results.map((r) => ({ noteId: r.note_id, text: r.value_text }));
  }

  /**
   * Rewrites a field's stored values for a new type.
   *
   * Done here rather than in SQL because SQLite cannot be trusted to say whether text is
   * a number — `CAST('abc' AS REAL)` is 0.0, not an error. The rows are read, planned by
   * the shared codec, and written back in batches of fifty statements. That is not one
   * transaction across batches, but every statement is idempotent, so a retry after a
   * failure converges on the same end state.
   */
  private async convertFieldValues(
    fieldId: string,
    from: FieldType,
    to: FieldType,
    toScale?: FieldScale | null,
  ): Promise<{ cleared: number; seededOptions?: string[] }> {
    const rows = await this.fieldValueRows(fieldId);
    const plan = planConversion(from, to, rows, toScale);

    const statements: D1PreparedStatement[] = [
      ...plan.keep.map((k) =>
        this.db
          .prepare(
            `UPDATE note_fields SET value_text = ?1, value_num = ?2
              WHERE note_id = ?3 AND field_id = ?4 AND user_id = ?5`,
          )
          .bind(k.text, k.num, k.row.noteId, fieldId, this.userId),
      ),
      ...plan.drop.map((r) =>
        this.db
          .prepare(`DELETE FROM note_fields WHERE note_id = ?1 AND field_id = ?2 AND user_id = ?3`)
          .bind(r.noteId, fieldId, this.userId),
      ),
    ];
    for (let i = 0; i < statements.length; i += 50) {
      await this.db.batch(statements.slice(i, i + 50));
    }

    return {
      cleared: plan.drop.length,
      ...(plan.seededOptions ? { seededOptions: plan.seededOptions } : {}),
    };
  }

  /**
   * Turns a values patch into the statements that apply it, validating every value first.
   *
   * Split from the write so that `update` can validate before it touches the note: a bad
   * value must fail the whole patch, not land after the title has already changed. Throws
   * `InvalidFieldValue` naming the field, which the route turns into a 400 and the MCP
   * tool into an error the model can correct.
   *
   * A field id the user does not own is reported exactly like one that does not exist,
   * so an id from someone else's notebook confirms nothing.
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
   */
  private async prepareFieldWrites(
    noteId: string,
    patch: NoteFieldsPatch,
  ): Promise<D1PreparedStatement[]> {
    const ids = Object.keys(patch);
    if (ids.length === 0) return [];
    if (ids.length > 100) throw new InvalidFieldValue('fields', 'Too many fields in one change');

    const { results } = await this.db
      .prepare(
        `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
           FROM notebook_fields
          WHERE user_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')})`,
      )
      .bind(this.userId, ...ids)
      .all<FieldRow>();
    const defs = new Map(results.map((r) => [r.id, rowToField(r)]));

    const { results: heldRows } = await this.db
      .prepare(
        `SELECT field_id, value_text FROM note_fields
          WHERE note_id = ?1 AND user_id = ?2 AND field_id IN (${ids.map((_, i) => `?${i + 3}`).join(', ')})`,
      )
      .bind(noteId, this.userId, ...ids)
      .all<{ field_id: string; value_text: string }>();
    const held = new Map(heldRows.map((r) => [r.field_id, r.value_text]));

    const statements: D1PreparedStatement[] = [];
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

      statements.push(
        encoded === 'clear'
          ? this.db
              .prepare(`DELETE FROM note_fields WHERE note_id = ?1 AND field_id = ?2 AND user_id = ?3`)
              .bind(noteId, id, this.userId)
          : this.db
              .prepare(
                `INSERT INTO note_fields (note_id, field_id, user_id, value_text, value_num)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(note_id, field_id)
                 DO UPDATE SET value_text = excluded.value_text, value_num = excluded.value_num`,
              )
              .bind(noteId, id, this.userId, encoded.text, encoded.num),
      );
    }
    return statements;
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
  private async applyImportedFields(
    noteId: string,
    notebookId: string,
    fields: Record<string, FieldValue>,
    onlyMissing: boolean,
  ): Promise<string[]> {
    const skipped: string[] = [];
    for (const [rawName, value] of Object.entries(fields)) {
      const name = rawName.trim();
      if (!name || isReservedFieldName(name)) {
        skipped.push(rawName);
        continue;
      }

      let def = await this.db
        .prepare(
          `SELECT id, notebook_id, name, type, options, scale_max, scale_step, currency, position
             FROM notebook_fields
            WHERE notebook_id = ?1 AND name = ?2 COLLATE NOCASE AND deleted_at IS NULL`,
        )
        .bind(notebookId, name)
        .first<FieldRow>()
        .then((r) => (r ? rowToField(r) : null));

      if (!def) {
        const seeded = Array.isArray(value) ? fieldOptionsSchema.safeParse(value) : null;
        if (seeded && !seeded.success) {
          skipped.push(rawName);
          continue;
        }
        const created = await this.createField(notebookId, {
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
        const widened = await this.addImportedOptions(notebookId, def, value);
        if (widened) {
          def = widened;
          encoded = encodeFieldValue(def, value);
        }
      }
      if (encoded === null || encoded === 'clear') {
        skipped.push(rawName);
        continue;
      }

      await this.db
        .prepare(
          `INSERT INTO note_fields (note_id, field_id, user_id, value_text, value_num)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(note_id, field_id) DO ${
             onlyMissing
               ? 'NOTHING'
               : 'UPDATE SET value_text = excluded.value_text, value_num = excluded.value_num'
           }`,
        )
        .bind(noteId, def.id, this.userId, encoded.text, encoded.num)
        .run();
    }
    return skipped;
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
  private async addImportedOptions(
    notebookId: string,
    def: FieldDef,
    value: FieldValue,
  ): Promise<FieldDef | null> {
    const wanted = fieldOptionsSchema.safeParse(Array.isArray(value) ? value : [String(value)]);
    if (!wanted.success) return null;
    const missing = wanted.data.filter((o) => !def.options.includes(o));
    if (missing.length === 0 || def.options.length + missing.length > MAX_SELECT_OPTIONS) return null;
    const updated = await this.updateField(notebookId, def.id, {
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
   */
  async importNotebook(
    definition: NotebookDefinition,
  ): Promise<{ id: string; skipped: Array<{ name: string; reason: string }> }> {
    const notebookId = await this.resolveNotebook(definition.name);
    if (!notebookId) throw new Error('Notebook name is empty');

    const existing = (await this.listFields(notebookId)) ?? [];
    const byName = new Map(existing.map((f) => [f.name.toLowerCase(), f]));
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const field of definition.fields) {
      const current = byName.get(field.name.toLowerCase());

      if (!current) {
        const created = await this.createField(notebookId, {
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
          const result = await this.updateField(notebookId, current.id, { currency: field.currency });
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
          const result = await this.updateField(notebookId, current.id, { options });
          if (typeof result === 'string') {
            skipped.push({ name: field.name, reason: 'Options could not be added' });
          }
        }
      }
    }

    return { id: notebookId, skipped };
  }

  private async setTags(noteId: string, tags: string[]): Promise<void> {
    const unique = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))];

    const statements: D1PreparedStatement[] = [
      this.db.prepare(`DELETE FROM note_tags WHERE note_id = ?1`).bind(noteId),
    ];

    for (const name of unique) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO tags (id, user_id, name) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, name) DO NOTHING`,
          )
          .bind(crypto.randomUUID(), this.userId, name),
        this.db
          .prepare(
            `INSERT INTO note_tags (note_id, tag_id)
             SELECT ?1, id FROM tags WHERE user_id = ?2 AND name = ?3`,
          )
          .bind(noteId, this.userId, name),
      );
    }

    await this.db.batch(statements);
  }
}
