import { ScopedRepo } from './repo.js';
import type { Note, NoteSummary } from '@unbent/shared';

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
