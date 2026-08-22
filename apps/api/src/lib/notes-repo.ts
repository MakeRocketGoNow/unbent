import { ScopedRepo } from './repo.js';
import type { Note, NoteSummary, SearchResult } from '@unbent/shared';

interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
}

interface SummaryRow {
  id: string;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
  tags: string | null;
}

/**
 * Unit separator (U+001F): cannot occur in a tag name, so it is a safe group_concat
 * delimiter. Written as an escape rather than a literal so the invisible byte cannot be
 * mangled by an editor or a copy-paste.
 */
const TAG_SEP = '\u001F';

/** First non-empty line of the body, stripped of markdown heading syntax. */
function excerptOf(body: string, max = 140): string {
  const line = body
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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
  /** Newest first, with tags. Keyset pagination on updated_at keeps deep pages cheap. */
  async list(opts: { limit: number; cursor?: string; tag?: string }): Promise<NoteSummary[]> {
    const { limit, cursor, tag } = opts;

    const conditions = ['n.user_id = ?1', 'n.deleted_at IS NULL'];
    const binds: unknown[] = [this.userId];

    if (cursor) {
      binds.push(Number(cursor));
      conditions.push(`n.updated_at < ?${binds.length}`);
    }
    if (tag) {
      binds.push(tag, this.userId);
      conditions.push(
        `EXISTS (SELECT 1 FROM note_tags nt2 JOIN tags t2 ON t2.id = nt2.tag_id
                 WHERE nt2.note_id = n.id AND t2.name = ?${binds.length - 1} AND t2.user_id = ?${binds.length})`,
      );
    }
    binds.push(limit);

    const { results } = await this.db
      .prepare(
        `SELECT n.id, n.title, n.body, n.created_at, n.updated_at,
                (SELECT group_concat(t.name, char(31)) FROM note_tags nt
                   JOIN tags t ON t.id = nt.tag_id
                  WHERE nt.note_id = n.id) AS tags
           FROM notes n
          WHERE ${conditions.join(' AND ')}
          ORDER BY n.updated_at DESC
          LIMIT ?${binds.length}`,
      )
      .bind(...binds)
      .all<SummaryRow>();

    return results.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      tags: splitTags(r.tags),
      excerpt: excerptOf(r.body),
    }));
  }

  /** Scoped by user_id despite `id` being the primary key. Never returns another user's note. */
  async get(id: string): Promise<Note | null> {
    const row = await this.db
      .prepare(
        `SELECT id, title, body, created_at, updated_at
           FROM notes
          WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
      )
      .bind(id, this.userId)
      .first<NoteRow>();
    if (!row) return null;

    const { results } = await this.db
      .prepare(
        `SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
          WHERE nt.note_id = ?1 AND t.user_id = ?2 ORDER BY t.name`,
      )
      .bind(id, this.userId)
      .all<{ name: string }>();

    return {
      id: row.id,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tags: results.map((t) => t.name),
    };
  }

  async create(input: { id: string; title: string; body: string; tags: string[] }): Promise<Note> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO notes (id, user_id, title, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      )
      .bind(input.id, this.userId, input.title, input.body, now)
      .run();

    if (input.tags.length > 0) await this.setTags(input.id, input.tags);

    return {
      id: input.id,
      title: input.title,
      body: input.body,
      createdAt: now,
      updatedAt: now,
      tags: input.tags,
    };
  }

  /** Returns null when the note does not exist *or* belongs to someone else. */
  async update(
    id: string,
    patch: { title?: string; body?: string; tags?: string[] },
  ): Promise<Note | null> {
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
      // A tags-only edit still needs an ownership check before touching the join table.
      const owned = await this.db
        .prepare(`SELECT 1 FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
        .bind(id, this.userId)
        .first();
      if (!owned) return null;
    }

    if (patch.tags !== undefined) {
      await this.setTags(id, patch.tags);
      await this.db
        .prepare(`UPDATE notes SET updated_at = ?1 WHERE id = ?2 AND user_id = ?3`)
        .bind(Date.now(), id, this.userId)
        .run();
    }

    return this.get(id);
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
   * Creates a note from an import, or returns the existing one with the same content hash.
   *
   * Idempotency is what makes a large import resumable. A 3GB file takes tens of minutes
   * and will be interrupted; re-running must not duplicate the thousands of notes that
   * already landed. The hash covers title and body, so re-importing an unchanged export is
   * a no-op while a genuinely edited note still comes through as new.
   */
  async importNote(input: {
    title: string;
    body: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
    contentHash: string;
    sourceEnex?: string;
  }): Promise<{ id: string; created: boolean }> {
    const existing = await this.db
      .prepare(
        `SELECT id FROM notes
          WHERE user_id = ?1 AND content_hash = ?2 AND deleted_at IS NULL
          LIMIT 1`,
      )
      .bind(this.userId, input.contentHash)
      .first<{ id: string }>();

    if (existing) return { id: existing.id, created: false };

    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO notes
           (id, user_id, title, body, created_at, updated_at, content_hash, source_enex)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
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
      )
      .run();

    if (input.tags.length > 0) await this.setTags(id, input.tags);

    return { id, created: true };
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
  async search(rawQuery: string, limit: number): Promise<SearchResult[]> {
    const query = toFtsQuery(rawQuery);
    if (!query) return [];

    /**
     * Two indexes, one result set.
     *
     * Most notes in an imported Evernote corpus are a scanned PDF with an empty body, so
     * searching note text alone misses the majority of them. attachment_text_fts carries
     * the OCR text those files already contained; a match there surfaces the note and
     * names the file it came from.
     *
     * Note matches rank ahead of attachment matches at equal relevance: what the user
     * wrote is a better answer than what a scanner read.
     */
    const { results } = await this.db
      .prepare(
        `WITH note_hits AS (
           SELECT n.id, n.title, n.updated_at,
                  snippet(notes_fts, 1, '<<', '>>', '…', 24) AS snippet,
                  NULL AS matched_file,
                  bm25(notes_fts, 10.0, 1.0) AS rank,
                  0 AS tier
             FROM notes_fts
             JOIN notes n ON n.rowid = notes_fts.rowid
            WHERE notes_fts MATCH ?1 AND n.user_id = ?2 AND n.deleted_at IS NULL
         ),
         file_hits AS (
           SELECT n.id, n.title, n.updated_at,
                  snippet(attachment_text_fts, 0, '<<', '>>', '…', 24) AS snippet,
                  at.filename AS matched_file,
                  bm25(attachment_text_fts) AS rank,
                  1 AS tier
             FROM attachment_text_fts
             JOIN attachment_text at ON at.rowid = attachment_text_fts.rowid
             JOIN notes n ON n.id = at.note_id
            WHERE attachment_text_fts MATCH ?1 AND at.user_id = ?2
              AND n.user_id = ?2 AND n.deleted_at IS NULL
         ),
         combined AS (SELECT * FROM note_hits UNION ALL SELECT * FROM file_hits)
         SELECT id, title, updated_at, snippet, matched_file, MIN(tier) AS tier, MIN(rank) AS rank
           FROM combined
          GROUP BY id
          ORDER BY tier, rank
          LIMIT ?3`,
      )
      .bind(query, this.userId, limit)
      .all<{
        id: string;
        title: string;
        updated_at: number;
        snippet: string;
        matched_file: string | null;
      }>();

    return results.map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      snippet: r.snippet,
      ...(r.matched_file ? { matchedFile: r.matched_file } : {}),
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

  /** Every tag this user has in use, with note counts, for the sidebar. */
  async listTags(): Promise<Array<{ name: string; count: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT t.name, COUNT(nt.note_id) AS count
           FROM tags t
           JOIN note_tags nt ON nt.tag_id = t.id
           JOIN notes n ON n.id = nt.note_id AND n.deleted_at IS NULL
          WHERE t.user_id = ?1
          GROUP BY t.id, t.name
          ORDER BY t.name`,
      )
      .bind(this.userId)
      .all<{ name: string; count: number }>();
    return results;
  }

  /**
   * Replace a note's tags. Callers must already have verified ownership of `noteId`.
   *
   * D1 has no interactive transactions, so this uses batch() for atomicity. Tag rows are
   * per-user, so two users using "work" get separate rows and never observe each other's.
   */
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
