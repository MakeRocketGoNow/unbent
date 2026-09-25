import { ScopedRepo } from './repo.js';
import { type AttachmentInfo, splitExt } from '@unbent/shared';

interface AttachmentRow {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
}

/**
 * The files the vision model has still to read, as two queries whose union is the answer:
 * behind both `needingVision` and `visionPending`, written once so the count and the list
 * cannot disagree about what is pending.
 *
 * Pictures with no text row, and PDFs whose text layer came back empty and that the model
 * has not been asked about. This was one predicate over a LEFT JOIN of every attachment to
 * its text, which SQLite could only answer by walking every attachment the account has.
 * Split, each half reads its own partial index from 0025, so each costs a row per file
 * still waiting and nothing once the backlog is read. The halves cannot overlap: one is
 * pictures, the other PDFs.
 *
 * The conditions repeat the indexes' WHERE clauses exactly, which is what lets SQLite use
 * them. The image types are the vision model's (`VISION_IMAGE_TYPES`), spelled out because
 * a query cannot take a Set.
 *
 * `noteParam` is the placeholder for a note id, for the callers that read one note. Those
 * name the per-note indexes outright: left to itself the planner prefers 0025's, which are
 * account-wide, and walks the whole backlog to find the one note's files. `INDEXED BY`
 * also makes a missing index an error rather than a quiet walk of the archive.
 */
function visionPendingHalves(noteParam: string | null): { pictures: string; pdfs: string } {
  const columns = 'a.id, a.note_id, a.filename, a.content_type, a.size, a.r2_key, a.created_at';
  const live = 'n.user_id = ?1 AND n.deleted_at IS NULL';
  return {
    pictures: `SELECT ${columns}
                 FROM attachments a${noteParam ? ' INDEXED BY idx_attachments_note' : ''}
                 JOIN notes n ON n.id = a.note_id
                WHERE a.user_id = ?1
                  AND a.content_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
                  AND a.has_text = 0
                  AND ${live}
                  ${noteParam ? `AND a.note_id = ${noteParam}` : ''}`,
    pdfs: `SELECT ${columns}
             FROM attachment_text t${noteParam ? ' INDEXED BY idx_attachment_text_note' : ''}
             JOIN attachments a ON a.id = t.attachment_id
             JOIN notes n ON n.id = a.note_id
            WHERE t.user_id = ?1 AND t.text = '' AND t.read_by IS NULL
              ${noteParam ? `AND t.note_id = ${noteParam}` : ''}
              AND a.user_id = ?1 AND a.content_type = 'application/pdf'
              AND ${live}`,
  };
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
   * Stores text extracted from an attachment, for search.
   *
   * Kept out of notes.body: OCR output is thousands of characters of noisy text that
   * would be unpleasant to edit around and would bloat every export. Indexed separately
   * so a hit can name the file it matched.
   */
  async recordText(input: {
    attachmentId: string;
    noteId: string;
    filename: string;
    text: string;
    /**
     * `'vision'` when the vision model wrote the row, whatever it found — see migration
     * 0020. Absent or null for a text layer, which is what every row was before.
     */
    readBy?: 'vision' | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO attachment_text (attachment_id, note_id, user_id, filename, text, read_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(attachment_id) DO UPDATE SET text = excluded.text, read_by = excluded.read_by`,
      )
      .bind(
        input.attachmentId,
        input.noteId,
        this.userId,
        input.filename,
        input.text,
        input.readBy ?? null,
        Date.now(),
      )
      .run();
  }

  /**
   * Carries one attachment's extracted text over to a copy of it.
   *
   * The copy is a new row with a new id, and `attachment_text` is keyed on that id, so
   * without this a copied PDF would drop out of search until a backfill pass re-read it —
   * on the client, from the bytes, for a result the source row already holds. A source
   * with no text yet leaves the copy without one too, and the backfill finds it there.
   */
  async copyText(
    fromAttachmentId: string,
    to: { attachmentId: string; noteId: string; filename: string },
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO attachment_text (attachment_id, note_id, user_id, filename, text, read_by, created_at)
         SELECT ?1, ?2, user_id, ?3, text, read_by, ?4
           FROM attachment_text
          WHERE attachment_id = ?5 AND user_id = ?6`,
      )
      .bind(to.attachmentId, to.noteId, to.filename, Date.now(), fromAttachmentId, this.userId)
      .run();
  }

  /**
   * Attachments that could carry searchable text but have none stored yet.
   *
   * Drives backfill for notes imported before extraction existed, and for any upload where
   * extraction failed. Re-importing cannot fix those: import is idempotent on content
   * hash, so an already-imported note is skipped along with its attachments.
   *
   * `noteId` narrows the answer to one note. The phone asks for its own capture this way,
   * because it must never be handed a thirteen-thousand-note backlog to pull over a radio;
   * the desktop asks unscoped for everything. Ownership needs no separate check: a note id
   * belonging to someone else fails the `user_id` join and yields nothing, the same way
   * `resolve` does.
   */
  async needingText(
    limit: number,
    noteId?: string,
  ): Promise<
    Array<{ id: string; noteId: string; filename: string; contentType: string; size: number; r2Key: string }>
  > {
    // `content_type` and `has_text` are written exactly as 0024's partial index states
    // them, which is what lets SQLite use it: the walk is over unread PDFs alone, in order,
    // instead of every PDF with a lookup each to see whether it has text. For one note the
    // note's own index is named outright, for the reason `visionPendingHalves` gives: left
    // to itself the planner takes the partial index and walks the account's whole backlog
    // to find one note's files.
    const { results } = await this.db
      .prepare(
        `SELECT a.id, a.note_id, a.filename, a.content_type, a.size, a.r2_key
           FROM attachments a${noteId ? ' INDEXED BY idx_attachments_note' : ''}
           JOIN notes n ON n.id = a.note_id
          WHERE a.user_id = ?1
            AND a.content_type = 'application/pdf' AND a.has_text = 0
            AND n.user_id = ?1
            AND n.deleted_at IS NULL
            ${noteId ? 'AND a.note_id = ?3' : ''}
          ORDER BY a.created_at
          LIMIT ?2`,
      )
      .bind(this.userId, limit, ...(noteId ? [noteId] : []))
      .all<{ id: string; note_id: string; filename: string; content_type: string; size: number; r2_key: string }>();

    return results.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      filename: r.filename,
      contentType: r.content_type,
      size: r.size,
      r2Key: r.r2_key,
    }));
  }

  /**
   * Files still waiting for the vision model: a picture with no text row, or a PDF whose
   * text layer was read and found empty and that the model has not been asked about.
   *
   * The second half is what `read_by` exists for. An empty row from a text layer and an
   * empty row from the model look the same in `text`, and only one of them should be
   * offered to a reader that costs a request per file. Ownership rides on the joins, as
   * it does in `needingText`.
   *
   * `noteId` narrows to one note, for the same reason it does in `needingText`: auto-fill
   * reads the note in front of the person before it suggests, and must never be handed the
   * account's backlog — every file here is a paid request, and the backlog is the Import
   * panel's to run on purpose.
   */
  async needingVision(
    limit: number,
    noteId?: string,
  ): Promise<
    Array<{ id: string; noteId: string; filename: string; contentType: string; size: number; r2Key: string }>
  > {
    const { pictures, pdfs } = visionPendingHalves(noteId ? '?3' : null);
    /*
       `created_at` is selected although nothing reads it. SQLite only runs a compound
       subquery as a merge of its halves when the outer ORDER BY names one of the outer
       result columns; without it the union was materialised and the whole backlog sorted
       in a temp B-tree to hand back three files — 9.4k rows per call of Maintenance's
       "Read N images" at 13k notes. With it, each half walks its partial index in
       `created_at` order and the LIMIT stops them: 283 rows.
    */
    const { results } = await this.db
      .prepare(
        `SELECT id, note_id, filename, content_type, size, r2_key, created_at
           FROM (${pictures} UNION ALL ${pdfs})
          ORDER BY created_at
          LIMIT ?2`,
      )
      .bind(this.userId, limit, ...(noteId ? [noteId] : []))
      .all<{ id: string; note_id: string; filename: string; content_type: string; size: number; r2_key: string }>();
    return results.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      filename: r.filename,
      contentType: r.content_type,
      size: r.size,
      r2Key: r.r2_key,
    }));
  }

  /**
   * How many files `needingVision` would still offer, for a pass to say what is left —
   * on one note when `noteId` is given, as `pendingTextCount` scopes its count.
   */
  async visionPending(noteId?: string): Promise<number> {
    const { pictures, pdfs } = visionPendingHalves(noteId ? '?2' : null);
    const row = await this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM (${pictures})) + (SELECT COUNT(*) FROM (${pdfs})) AS pending`,
      )
      .bind(this.userId, ...(noteId ? [noteId] : []))
      .first<{ pending: number }>();
    return row?.pending ?? 0;
  }

  /**
   * How many PDFs `needingText` would still offer, for a pass to say what is left.
   *
   * Scoped to one note when `noteId` is given, so a caller that asked for one note's
   * pending files is told how many that note has left rather than how many the account has.
   *
   * This counts only what is unread, through the same partial index as `needingText`.
   * It replaced a count of every PDF and of every PDF with text, whose difference was the
   * one number any caller used; producing the other two meant reading every PDF, on
   * every open of the app.
   */
  async pendingTextCount(noteId?: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS pending
           FROM attachments a${noteId ? ' INDEXED BY idx_attachments_note' : ''}
           JOIN notes n ON n.id = a.note_id
          WHERE a.user_id = ?1
            AND a.content_type = 'application/pdf' AND a.has_text = 0
            AND n.user_id = ?1 AND n.deleted_at IS NULL
            ${noteId ? 'AND a.note_id = ?2' : ''}`,
      )
      .bind(this.userId, ...(noteId ? [noteId] : []))
      .first<{ pending: number }>();
    return row?.pending ?? 0;
  }

  /**
   * The text extracted from an attachment, when there is any.
   *
   * Added for the MCP server, where it is the difference between an assistant being able to
   * answer a question about a scanned bill and having to say it cannot read PDFs. The bytes
   * are useless to a language model; this text is what search already indexes, so returning
   * it costs nothing new.
   *
   * `null` when the attachment does not exist or belongs to someone else, and an empty
   * string when it exists but has no text yet — extraction is asynchronous, and "not indexed
   * yet" is a different answer from "no such file".
   */
  async textFor(noteId: string, filename: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(t.text, '') AS text
           FROM attachments a
           LEFT JOIN attachment_text t ON t.attachment_id = a.id
          WHERE a.note_id = ?1 AND a.filename = ?2 AND a.user_id = ?3`,
      )
      .bind(noteId, filename, this.userId)
      .first<{ text: string }>();
    return row?.text ?? null;
  }

  /**
   * Every file on a note with whatever text it has, for auto-fill to read the note whole.
   *
   * The same three answers `textFor` gives, per file: `null` while no text has been
   * recorded — a PDF still being read, or never read — and `''` for one read and found
   * empty. The type rides along because a caller telling "still being read" from "a file
   * nothing here reads" needs to know which it is looking at, and `readBy` because text
   * the language model wrote opens with a name for the file, which auto-fill can use.
   */
  async textsForNote(noteId: string): Promise<
    Array<{ filename: string; contentType: string; text: string | null; readBy: 'vision' | null }>
  > {
    const { results } = await this.db
      .prepare(
        `SELECT a.filename, a.content_type, t.text, t.read_by
           FROM attachments a
           JOIN notes n ON n.id = a.note_id
           LEFT JOIN attachment_text t ON t.attachment_id = a.id
          WHERE a.note_id = ?1 AND a.user_id = ?2 AND n.user_id = ?2 AND n.deleted_at IS NULL
          ORDER BY a.created_at`,
      )
      .bind(noteId, this.userId)
      .all<{ filename: string; content_type: string; text: string | null; read_by: string | null }>();
    return results.map((r) => ({
      filename: r.filename,
      contentType: r.content_type,
      text: r.text,
      readBy: r.read_by === 'vision' ? 'vision' : null,
    }));
  }

  /** Attachment id for a filename within a note, scoped to this user. */
  async idFor(noteId: string, filename: string): Promise<string | null> {
    const row = await this.resolve(noteId, filename);
    return row?.id ?? null;
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
