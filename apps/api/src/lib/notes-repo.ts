import { ScopedRepo } from './repo.js';
import {
  decodeFieldValue,
  encodeFieldValue,
  endOfDay,
  excerptMarkdown,
  expectedFieldValue,
  inferFieldType,
  InvalidFieldValue,
  isHeldSelectValue,
  isReservedFieldName,
  MAX_FIELDS_PER_NOTEBOOK,
  planConversion,
  startOfDay,
  UNFILED,
  type FieldDef,
  type FieldType,
  type FieldValue,
  type Note,
  type NoteFieldsPatch,
  type NoteFieldValue,
  type NoteSort,
  type NoteSummary,
  type NotebookSummary,
  type SearchResult,
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
  position: number;
  value_count?: number;
}

/** One value as the list's `json_group_array` subquery emits it. */
interface FieldJson {
  fieldId: string;
  name: string;
  type: string;
  text: string;
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
    position: row.position,
    ...(row.value_count !== undefined ? { valueCount: row.value_count } : {}),
  };
}

/** Options are only stored for `select`; every other type carries NULL, whatever was sent. */
function optionsColumn(type: FieldType, options: string[]): string | null {
  return type === 'select' ? JSON.stringify(options) : null;
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
      notebookId: r.notebookId,
      notebook: r.notebook,
    }));
}

/**
 * The correlated subquery that hands `list` and `get` a note's values as one JSON
 * column — the same shape as the tags subquery beside it, so the per-row cost is one
 * primary-key lookup rather than a join that multiplies rows. `json_object` rather than
 * a delimited string because a value can contain any character a delimiter could be.
 */
const FIELDS_SUBQUERY = `(SELECT json_group_array(json_object(
                 'fieldId', f.id, 'name', f.name, 'type', f.type, 'text', nf.value_text,
                 'position', f.position, 'notebookId', f.notebook_id, 'notebook', fnb.name))
            FROM note_fields nf
            JOIN notebook_fields f ON f.id = nf.field_id
            JOIN notebooks fnb ON fnb.id = f.notebook_id
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
   * One EXISTS per tag, AND'd together: the note must carry every one of them.
   *
   * Conjunction is what makes this a widening rather than a change — a single tag
   * produces exactly the clause a single filter produced before, so the existing
   * behaviour is the one-element case rather than a case handled alongside it. Each
   * clause is an independent semi-join on note_tags, so nothing here fans out the row
   * count the way joining the table once per tag would.
   */
  for (const tag of opts.tags ?? []) {
    binds.push(tag, userId);
    conditions.push(
      `EXISTS (SELECT 1 FROM note_tags nt2 JOIN tags t2 ON t2.id = nt2.tag_id
               WHERE nt2.note_id = n.id AND t2.name = ?${binds.length - 1} AND t2.user_id = ?${binds.length})`,
    );
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
  opts: { limit: number; sort: NoteSort; trashed?: boolean | undefined },
): string | null {
  const last = items[items.length - 1];
  if (items.length < opts.limit || !last) return null;
  const spec = opts.trashed ? TRASH_SORT : SORTS[opts.sort];
  return encodeCursor(spec.keyOf(last), last.id);
}

function splitTags(joined: string | null): string[] {
  if (!joined) return [];
  return joined.split(TAG_SEP).filter((t) => t.length > 0);
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
    sort?: NoteSort;
    order?: 'asc' | 'desc';
    from?: string;
    to?: string;
    /** List trashed notes instead of live ones. */
    trashed?: boolean;
  }): Promise<NoteSummary[]> {
    const { limit, cursor, tags, notebook, trashed, from, to } = opts;
    const sort = opts.sort ?? 'updated';
    // Trash has one meaningful order — most recently deleted first — so it ignores both.
    const spec = trashed ? TRASH_SORT : SORTS[sort];
    const descending = trashed || (opts.order ?? 'desc') === 'desc';
    const collate = 'collate' in spec && spec.collate ? ` ${spec.collate}` : '';

    const conditions = [
      'n.user_id = ?1',
      trashed ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL',
    ];
    const binds: unknown[] = [this.userId];

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
      binds.push(isText ? decoded.key : Number(decoded.key), decoded.id);
      const keyBind = `?${binds.length - 1}`;
      const idBind = `?${binds.length}`;
      conditions.push(
        `(${spec.column}${collate} ${op} ${keyBind}` +
          ` OR (${spec.column}${collate} = ${keyBind} AND n.id ${op} ${idBind}))`,
      );
    }
    conditions.push(
      // The range applies to the column being sorted, so the filter and the order agree.
      ...filterConditions({ tags, notebook, from, to, dateColumn: spec.dateColumn }, binds, this.userId),
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
          WHERE ${conditions.join(' AND ')}
          ORDER BY ${spec.column}${collate} ${direction}, n.id ${direction}
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
    trashed?: boolean;
    from?: string;
    to?: string;
    sort?: NoteSort;
  }): Promise<number> {
    const conditions = [
      'n.user_id = ?1',
      opts?.trashed ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL',
    ];
    const binds: unknown[] = [this.userId];

    conditions.push(
      ...filterConditions(
        {
          tags: opts?.tags,
          notebook: opts?.notebook,
          from: opts?.from,
          to: opts?.to,
          dateColumn: opts?.trashed ? TRASH_SORT.dateColumn : SORTS[opts?.sort ?? 'updated'].dateColumn,
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

    const { results } = await this.db
      .prepare(
        `SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
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

  /** Returns null when the note does not exist *or* belongs to someone else. */
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
    // Field values are validated before anything is written: a value the field cannot
    // hold fails the whole patch rather than landing after the title has changed.
    const fieldWrites =
      patch.fields !== undefined ? await this.prepareFieldWrites(id, patch.fields) : [];

    const sets: string[] = [];
    const binds: unknown[] = [];

    if (patch.title !== undefined) {
      binds.push(patch.title);
      sets.push(`title = ?${binds.length}`);
    }
    if (patch.body !== undefined) {
      binds.push(patch.body);
      sets.push(`body = ?${binds.length}`);
    }
    if (patch.notebook !== undefined) {
      binds.push(await this.resolveNotebook(patch.notebook));
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
      if (res.meta.changes === 0) return null;
    } else {
      // A tags- or fields-only edit still needs an ownership check before touching the
      // side tables.
      const owned = await this.db
        .prepare(`SELECT 1 FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
        .bind(id, this.userId)
        .first();
      if (!owned) return null;
    }

    if (patch.tags !== undefined) await this.setTags(id, patch.tags);
    if (fieldWrites.length > 0) await this.db.batch(fieldWrites);
    if (patch.tags !== undefined || fieldWrites.length > 0) {
      await this.db
        .prepare(`UPDATE notes SET updated_at = ?1 WHERE id = ?2 AND user_id = ?3`)
        .bind(Date.now(), id, this.userId)
        .run();
    }

    return this.get(id);
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

    return { deleted: res.meta.changes > 0, keys: results.map((r) => r.r2_key) };
  }

  /**
   * Creates a note from an import, or returns the existing one with the same content hash.
   *
   * Idempotency is what makes a large import resumable. A 3GB file takes tens of minutes
   * and will be interrupted; re-running must not duplicate the thousands of notes that
   * already landed. The hash covers title and body, so re-importing an unchanged export is
   * a no-op while a genuinely edited note still comes through as new.
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
     */
    const existing =
      (input.id ? await this.liveNoteById(input.id) : null) ??
      (await this.db
        .prepare(
          `SELECT id FROM notes
            WHERE user_id = ?1 AND content_hash = ?2 AND deleted_at IS NULL
            LIMIT 1`,
        )
        .bind(this.userId, input.contentHash)
        .first<{ id: string }>());

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
    const id = input.id && !(await this.idTaken(input.id)) ? input.id : crypto.randomUUID();
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
   */
  async purge(scope: 'trashed' | 'all'): Promise<{ notes: number; keys: string[] }> {
    const where =
      scope === 'trashed' ? 'user_id = ?1 AND deleted_at IS NOT NULL' : 'user_id = ?1';

    const { results: keyRows } = await this.db
      .prepare(
        `SELECT a.r2_key FROM attachments a
           JOIN notes n ON n.id = a.note_id
          WHERE n.${where} AND a.user_id = ?1`,
      )
      .bind(this.userId)
      .all<{ r2_key: string }>();

    const { results: idRows } = await this.db
      .prepare(`SELECT id FROM notes WHERE ${where}`)
      .bind(this.userId)
      .all<{ id: string }>();

    if (idRows.length === 0) return { notes: 0, keys: [] };

    // Delete in batches: D1 caps bound parameters at 100 per statement, and note_tags,
    // attachments, and attachment_text all cascade from notes.
    const ids = idRows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 99) {
      const batch = ids.slice(i, i + 99);
      const placeholders = batch.map((_, j) => `?${j + 2}`).join(', ');
      await this.db
        .prepare(`DELETE FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`)
        .bind(this.userId, ...batch)
        .run();
    }

    // Tag rows are per-user and survive their notes; drop the ones nothing references.
    await this.db
      .prepare(
        `DELETE FROM tags
          WHERE user_id = ?1
            AND id NOT IN (SELECT tag_id FROM note_tags)`,
      )
      .bind(this.userId)
      .run();

    return { notes: ids.length, keys: keyRows.map((r) => r.r2_key) };
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
   * Notes' `updated_at` is left alone, as `renameNotebook` leaves it: nothing about the
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
        `SELECT nb.id, nb.name,
                COUNT(n.id) AS count,
                (SELECT COUNT(*) FROM notebook_fields f WHERE f.notebook_id = nb.id) AS fields
           FROM notebooks nb
           LEFT JOIN notes n
             ON n.notebook_id = nb.id AND n.deleted_at IS NULL AND n.user_id = ?1
          WHERE nb.user_id = ?1
          GROUP BY nb.id, nb.name
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
   * Renames a notebook. Returns 'conflict' when another notebook already has the name.
   *
   * Every note follows automatically because they reference the id — the rename is a single
   * row update, which is the point of the notebook being an entity at all.
   */
  async renameNotebook(id: string, name: string): Promise<'ok' | 'conflict' | 'missing'> {
    const trimmed = name.trim();
    if (!trimmed) return 'missing';

    const clash = await this.db
      .prepare(
        `SELECT 1 FROM notebooks
          WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3`,
      )
      .bind(this.userId, trimmed, id)
      .first();
    if (clash) return 'conflict';

    const res = await this.db
      .prepare(`UPDATE notebooks SET name = ?1 WHERE id = ?2 AND user_id = ?3`)
      .bind(trimmed, id, this.userId)
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
      // The notebook's fields and their values go with it, explicitly, for the same
      // reason the notes are unfiled by hand rather than by ON DELETE.
      this.db
        .prepare(
          `DELETE FROM note_fields
            WHERE user_id = ?1
              AND field_id IN (SELECT id FROM notebook_fields WHERE notebook_id = ?2)`,
        )
        .bind(this.userId, id),
      this.db
        .prepare(`DELETE FROM notebook_fields WHERE notebook_id = ?1 AND user_id = ?2`)
        .bind(id, this.userId),
      this.db.prepare(`DELETE FROM notebooks WHERE id = ?1 AND user_id = ?2`).bind(id, this.userId),
    ]);

    return true;
  }

  // --- Custom fields -------------------------------------------------------------------

  /**
   * A notebook's field definitions in display order, with how many notes hold a value for
   * each (the management page names that count before a delete). Null when the notebook
   * is not this user's, so the route can answer 404 without a second query.
   */
  async listFields(notebookId: string): Promise<FieldDef[] | null> {
    const owned = await this.db
      .prepare(`SELECT 1 FROM notebooks WHERE id = ?1 AND user_id = ?2`)
      .bind(notebookId, this.userId)
      .first();
    if (!owned) return null;

    const { results } = await this.db
      .prepare(
        `SELECT f.id, f.notebook_id, f.name, f.type, f.options, f.position,
                (SELECT COUNT(*) FROM note_fields nf WHERE nf.field_id = f.id) AS value_count
           FROM notebook_fields f
          WHERE f.notebook_id = ?1 AND f.user_id = ?2
          ORDER BY f.position`,
      )
      .bind(notebookId, this.userId)
      .all<FieldRow>();
    return results.map(rowToField);
  }

  /** Every field this user has defined, across notebooks, for a listing that shows them all. */
  async listAllFields(): Promise<FieldDef[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, notebook_id, name, type, options, position
           FROM notebook_fields WHERE user_id = ?1
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
    input: { name: string; type: FieldType; options: string[] },
  ): Promise<FieldDef | 'missing' | 'conflict' | 'full'> {
    const owned = await this.db
      .prepare(`SELECT 1 FROM notebooks WHERE id = ?1 AND user_id = ?2`)
      .bind(notebookId, this.userId)
      .first();
    if (!owned) return 'missing';

    const count = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM notebook_fields WHERE notebook_id = ?1`)
      .bind(notebookId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_FIELDS_PER_NOTEBOOK) return 'full';

    const clash = await this.db
      .prepare(
        `SELECT 1 FROM notebook_fields WHERE notebook_id = ?1 AND name = ?2 COLLATE NOCASE`,
      )
      .bind(notebookId, input.name)
      .first();
    if (clash) return 'conflict';

    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO notebook_fields (id, user_id, notebook_id, name, type, options, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM notebook_fields WHERE notebook_id = ?3),
                 ?7)`,
      )
      .bind(
        id,
        this.userId,
        notebookId,
        input.name,
        input.type,
        optionsColumn(input.type, input.options),
        Date.now(),
      )
      .run();

    return (await this.getField(notebookId, id)) ?? 'missing';
  }

  /**
   * Renames a field, replaces its options, or changes its type.
   *
   * A type change converts the values first (see `convertFieldValues`) and reports how
   * many it had to clear. Converting to `select` seeds the options from the existing
   * values, which then take precedence over any options in the same patch: a caller
   * cannot both pick a new type and hand-write an option list that would orphan values.
   */
  async updateField(
    notebookId: string,
    fieldId: string,
    patch: { name?: string; type?: FieldType; options?: string[] },
  ): Promise<{ field: FieldDef; cleared: number } | 'missing' | 'conflict'> {
    const current = await this.getField(notebookId, fieldId);
    if (!current) return 'missing';

    if (patch.name !== undefined && patch.name.toLowerCase() !== current.name.toLowerCase()) {
      const clash = await this.db
        .prepare(
          `SELECT 1 FROM notebook_fields
            WHERE notebook_id = ?1 AND name = ?2 COLLATE NOCASE AND id <> ?3`,
        )
        .bind(notebookId, patch.name, fieldId)
        .first();
      if (clash) return 'conflict';
    }

    let options = patch.options ?? current.options;
    let cleared = 0;
    const type = patch.type ?? current.type;
    if (type !== current.type) {
      const converted = await this.convertFieldValues(fieldId, current.type, type);
      cleared = converted.cleared;
      if (converted.seededOptions) options = converted.seededOptions;
    }

    await this.db
      .prepare(
        `UPDATE notebook_fields SET name = ?1, type = ?2, options = ?3
          WHERE id = ?4 AND notebook_id = ?5 AND user_id = ?6`,
      )
      .bind(patch.name ?? current.name, type, optionsColumn(type, options), fieldId, notebookId, this.userId)
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
  ): Promise<{ values: number; incompatible: number } | null> {
    const field = await this.getField(notebookId, fieldId);
    if (!field) return null;
    const rows = await this.fieldValueRows(fieldId);
    const plan = planConversion(field.type, to, rows);
    return { values: rows.length, incompatible: plan.drop.length };
  }

  /** Sets a notebook's field order. `ids` must be exactly its fields, each once. */
  async reorderFields(notebookId: string, ids: string[]): Promise<boolean> {
    const { results } = await this.db
      .prepare(`SELECT id FROM notebook_fields WHERE notebook_id = ?1 AND user_id = ?2`)
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

  private async getField(notebookId: string, fieldId: string): Promise<FieldDef | null> {
    const row = await this.db
      .prepare(
        `SELECT id, notebook_id, name, type, options, position
           FROM notebook_fields
          WHERE id = ?1 AND notebook_id = ?2 AND user_id = ?3`,
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
  ): Promise<{ cleared: number; seededOptions?: string[] }> {
    const rows = await this.fieldValueRows(fieldId);
    const plan = planConversion(from, to, rows);

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
   * A select value the option list has dropped is left on notes that already hold it, for
   * the reason `isHeldSelectValue` gives: the editor resends every field, and failing that
   * resend would refuse the title and body too. Looked up here so a new choice that is not
   * in the list is still a 400.
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
        `SELECT id, notebook_id, name, type, options, position
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
      const encoded = value === null || value === undefined ? 'clear' : encodeFieldValue(def, value);
      if (encoded === null) {
        if (isHeldSelectValue(def, value, held.get(id))) continue;
        throw new InvalidFieldValue(def.name, expectedFieldValue(def));
      }

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
   * vault exported elsewhere lands with its properties intact. Anything that cannot be
   * stored (a reserved name, a value the field's type cannot read, a notebook already at
   * its limit) is skipped and named, rather than failing the note: an import is judged by
   * what it kept. With `onlyMissing`, a value a note already holds is left alone — the
   * content-hash skip path restores what a deleted field lost without undoing an edit.
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
          `SELECT id, notebook_id, name, type, options, position
             FROM notebook_fields WHERE notebook_id = ?1 AND name = ?2 COLLATE NOCASE`,
        )
        .bind(notebookId, name)
        .first<FieldRow>()
        .then((r) => (r ? rowToField(r) : null));

      if (!def) {
        const created = await this.createField(notebookId, {
          name,
          type: inferFieldType(value),
          options: [],
        });
        if (typeof created === 'string') {
          skipped.push(rawName);
          continue;
        }
        def = created;
      }

      const encoded = encodeFieldValue(def, value);
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
