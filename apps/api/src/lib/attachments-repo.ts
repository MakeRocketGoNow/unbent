import { ScopedRepo } from './repo.js';
import type { AttachmentInfo } from '@unbent/shared';

interface AttachmentRow {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
}

/** Splits `name.ext` so a collision can be suffixed as `name-2.ext`. */
function splitExt(filename: string): [string, string] {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return [filename, ''];
  return [filename.slice(0, dot), filename.slice(dot)];
}

/**
 * Attachment metadata for one user.
 *
 * Ownership is checked in the same query that fetches the R2 key — a note id from a URL is
 * never trusted on its own. R2 keys are built from `this.userId`, so even a wrong query
 * cannot produce a key outside the user's own prefix.
 */
export class AttachmentsRepo extends ScopedRepo {
  /** Resolves `files/<filename>` within a note, scoped to this user. Null if not theirs. */
  async resolve(noteId: string, filename: string): Promise<AttachmentRow | null> {
    return this.db
      .prepare(
        `SELECT a.id, a.filename, a.content_type, a.size, a.r2_key
           FROM attachments a
           JOIN notes n ON n.id = a.note_id
          WHERE a.note_id = ?1 AND a.filename = ?2 AND a.user_id = ?3
            AND n.user_id = ?3 AND n.deleted_at IS NULL`,
      )
      .bind(noteId, filename, this.userId)
      .first<AttachmentRow>();
  }

  async listForNote(noteId: string): Promise<AttachmentInfo[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.filename, a.content_type, a.size
           FROM attachments a
           JOIN notes n ON n.id = a.note_id
          WHERE a.note_id = ?1 AND a.user_id = ?2 AND n.user_id = ?2`,
      )
      .bind(noteId, this.userId)
      .all<{ filename: string; content_type: string; size: number }>();

    return results.map((r) => ({
      filename: r.filename,
      contentType: r.content_type,
      size: r.size,
    }));
  }

  /** True when this user owns the note and it is not deleted. */
  async ownsNote(noteId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
      .bind(noteId, this.userId)
      .first();
    return row !== null;
  }

  /**
   * Picks a filename that is free within the note, suffixing `-2`, `-3`, … on collision.
   *
   * Overwriting instead would silently corrupt an existing note: two pasted screenshots
   * both named `image.png` would leave the first note's link pointing at the second image.
   */
  async availableFilename(noteId: string, desired: string): Promise<string> {
    const { results } = await this.db
      .prepare(`SELECT filename FROM attachments WHERE note_id = ?1 AND user_id = ?2`)
      .bind(noteId, this.userId)
      .all<{ filename: string }>();

    const taken = new Set(results.map((r) => r.filename));
    if (!taken.has(desired)) return desired;

    const [stem, ext] = splitExt(desired);
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${stem}-${n}${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${stem}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  }

  /** R2 key for a new attachment. Built from the session; never from client input. */
  buildKey(noteId: string, attachmentId: string, filename: string): string {
    return `users/${this.userId}/notes/${noteId}/files/${attachmentId}-${filename}`;
  }

  async record(input: {
    id: string;
    noteId: string;
    filename: string;
    contentType: string;
    size: number;
    r2Key: string;
    md5?: string;
  }): Promise<AttachmentInfo> {
    await this.db
      .prepare(
        `INSERT INTO attachments
           (id, note_id, user_id, filename, content_type, size, md5, r2_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        input.id,
        input.noteId,
        this.userId,
        input.filename,
        input.contentType,
        input.size,
        input.md5 ?? null,
        input.r2Key,
        Date.now(),
      )
      .run();

    return { filename: input.filename, contentType: input.contentType, size: input.size };
  }

  /** Returns the R2 key to delete, or null when the attachment is not this user's. */
  async remove(noteId: string, filename: string): Promise<string | null> {
    const row = await this.resolve(noteId, filename);
    if (!row) return null;

    await this.db
      .prepare(`DELETE FROM attachments WHERE id = ?1 AND user_id = ?2`)
      .bind(row.id, this.userId)
      .run();

    return row.r2_key;
  }

  /**
   * Every key under a note, for cleanup. Scoped so it cannot enumerate another user's.
   *
   * Not called on note deletion: that is a soft delete and the note is restorable, so its
   * blobs must survive. This exists for a future trash purge, which is where reclaiming
   * that storage belongs.
   */
  async keysForNote(noteId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(`SELECT r2_key FROM attachments WHERE note_id = ?1 AND user_id = ?2`)
      .bind(noteId, this.userId)
      .all<{ r2_key: string }>();
    return results.map((r) => r.r2_key);
  }
}
