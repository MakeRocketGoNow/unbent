import { type AttachmentInfo, splitExt } from '@unbent/shared';
import type { Feed } from './feed.js';
import type { Sql } from './sql.js';

export interface AttachmentRow {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
}

/** One file still to be read, as `needingText` and `needingVision` list them. */
export interface PendingFile {
  id: string;
  noteId: string;
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
}

/**
 * The files the vision model has still to read, as two queries whose union is the answer:
 * behind both `needingVision` and `visionPending`, written once so the count and the list
 * cannot disagree about what is pending.
 *
 * Pictures with no text row, and PDFs whose text layer came back empty and that the model
 * has not been asked about. This was one predicate over a LEFT JOIN of every attachment to
 * its text, which SQLite could only answer by walking every attachment the account has.
 * Split, each half reads its own partial index, so each costs a row per file still
 * waiting and nothing once the backlog is read. The halves cannot overlap: one is
 * pictures, the other PDFs.
 *
 * The conditions repeat the indexes' WHERE clauses exactly, which is what lets SQLite use
 * them. The image types are the vision model's (`VISION_IMAGE_TYPES`), spelled out because
 * a query cannot take a Set.
 *
 * `noteParam` is the placeholder for a note id, for the callers that read one note. Those
 * name the per-note indexes outright: left to itself the planner prefers the partial
 * indexes, which are account-wide, and walks the whole backlog to find the one note's
 * files. `INDEXED BY` also makes a missing index an error rather than a quiet walk of the
 * archive.
 */
function visionPendingHalves(noteParam: string | null): { pictures: string; pdfs: string } {
  const columns = 'a.id, a.note_id, a.filename, a.content_type, a.size, a.r2_key, a.created_at';
  return {
    pictures: `SELECT ${columns}
                 FROM attachments a${noteParam ? ' INDEXED BY idx_attachments_note' : ''}
                 JOIN notes n ON n.id = a.note_id
                WHERE a.content_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
                  AND a.has_text = 0
                  AND n.deleted_at IS NULL
                  ${noteParam ? `AND a.note_id = ${noteParam}` : ''}`,
    pdfs: `SELECT ${columns}
             FROM attachment_text t${noteParam ? ' INDEXED BY idx_attachment_text_note' : ''}
             JOIN attachments a ON a.id = t.attachment_id
             JOIN notes n ON n.id = a.note_id
            WHERE t.text = '' AND t.read_by IS NULL
              ${noteParam ? `AND t.note_id = ${noteParam}` : ''}
              AND a.content_type = 'application/pdf'
              AND n.deleted_at IS NULL`,
  };
}

interface PendingRow {
  id: string;
  note_id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
}

const toPending = (r: PendingRow): PendingFile => ({
  id: r.id,
  noteId: r.note_id,
  filename: r.filename,
  contentType: r.content_type,
  size: r.size,
  r2Key: r.r2_key,
});

/**
 * Attachment metadata for one account, inside that account's own SQLite.
 *
 * `AttachmentsRepo` moved onto the per-user store, with the same three differences
 * `NotesStore` notes: no `user_id`, synchronous, real transactions. The ownership checks
 * that used to ride on `user_id` joins are gone because there is nothing here that is not
 * this account's; what remains is the check that matters to the caller, whether the note
 * is live.
 *
 * R2 keys are stored here and handed back, never built: the key names the user, and the
 * Worker builds it from the session (`buildKey` on the facade). Bytes never come this way.
 */
export class AttachmentsStore {
  constructor(
    private readonly sql: Sql,
    private readonly feed: Feed,
  ) {}

  /**
   * Resolves `files/<filename>` within a live note. Null when there is no such file.
   *
   * `includeTrashed` is for `GET /notes/:id/files/:filename` alone, so a note open in the
   * trash still draws its images and PDFs. Copying, renaming and re-reading a file all
   * resolve it too, and none of those may start from the trash.
   */
  resolve(noteId: string, filename: string, opts: { includeTrashed?: boolean | undefined } = {}): AttachmentRow | null {
    return this.sql.first<AttachmentRow>(
      `SELECT a.id, a.filename, a.content_type, a.size, a.r2_key
         FROM attachments a
         JOIN notes n ON n.id = a.note_id
        WHERE a.note_id = ?1 AND a.filename = ?2${opts.includeTrashed ? '' : ' AND n.deleted_at IS NULL'}`,
      noteId,
      filename,
    );
  }

  listForNote(noteId: string): AttachmentInfo[] {
    return this.sql
      .exec<{ filename: string; content_type: string; size: number }>(
        `SELECT filename, content_type, size FROM attachments WHERE note_id = ?1`,
        noteId,
      )
      .map((r) => ({ filename: r.filename, contentType: r.content_type, size: r.size }));
  }

  /** True when the note exists and is not deleted. What `ownsNote` asked on the shared database. */
  noteIsLive(noteId: string): boolean {
    return this.sql.first(`SELECT 1 AS hit FROM notes WHERE id = ?1 AND deleted_at IS NULL`, noteId) !== null;
  }

  /** True when the note exists, live or in the trash. For reads only; see `NotesStore.get`. */
  noteExists(noteId: string): boolean {
    return this.sql.first(`SELECT 1 AS hit FROM notes WHERE id = ?1`, noteId) !== null;
  }

  /**
   * Picks a filename that is free within the note, suffixing `-2`, `-3`, … on collision.
   *
   * Overwriting instead would silently corrupt an existing note: two pasted screenshots
   * both named `image.png` would leave the first note's link pointing at the second image.
   */
  availableFilename(noteId: string, desired: string): string {
    const taken = new Set(
      this.sql
        .exec<{ filename: string }>(`SELECT filename FROM attachments WHERE note_id = ?1`, noteId)
        .map((r) => r.filename),
    );
    if (!taken.has(desired)) return desired;

    const [stem, ext] = splitExt(desired);
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${stem}-${n}${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${stem}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  }

  record(input: {
    id: string;
    noteId: string;
    filename: string;
    contentType: string;
    size: number;
    r2Key: string;
  }): AttachmentInfo {
    return this.sql.tx(() => {
      this.sql.exec(
        `INSERT INTO attachments (id, note_id, filename, content_type, size, r2_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        input.id,
        input.noteId,
        input.filename,
        input.contentType,
        input.size,
        input.r2Key,
        Date.now(),
      );
      // The file, and the note it changes the shape of: a client keeps a note's files
      // with the note, and a row on its own would leave the note's list stale.
      this.feed.record([
        { entity: 'attachment', id: input.id },
        { entity: 'note', id: input.noteId },
      ]);
      return { filename: input.filename, contentType: input.contentType, size: input.size };
    });
  }

  /** Returns the R2 key to delete, or null when there is no such file on a live note. */
  remove(noteId: string, filename: string): string | null {
    return this.sql.tx(() => {
      const row = this.resolve(noteId, filename);
      if (!row) return null;
      this.sql.exec(`DELETE FROM attachments WHERE id = ?1`, row.id);
      this.feed.record([
        { entity: 'attachment', id: row.id, deleted: true },
        { entity: 'note', id: noteId },
      ]);
      return row.r2_key;
    });
  }

  /**
   * Stores text extracted from an attachment, for search.
   *
   * Kept out of notes.body: OCR output is thousands of characters of noisy text that
   * would be unpleasant to edit around and would bloat every export. Indexed separately
   * so a hit can name the file it matched.
   */
  recordText(input: {
    attachmentId: string;
    noteId: string;
    filename: string;
    text: string;
    /**
     * `'vision'` when the vision model wrote the row, whatever it found. Absent or null
     * for a text layer, which is what every row was before.
     */
    readBy?: 'vision' | null | undefined;
  }): void {
    this.sql.tx(() => {
      this.sql.exec(
        `INSERT INTO attachment_text (attachment_id, note_id, filename, text, read_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(attachment_id) DO UPDATE SET text = excluded.text, read_by = excluded.read_by`,
        input.attachmentId,
        input.noteId,
        input.filename,
        input.text,
        input.readBy ?? null,
        Date.now(),
      );
      // Text arriving is a change to the file's row (`hasText`), not to the note.
      this.feed.record([{ entity: 'attachment', id: input.attachmentId }]);
    });
  }

  /**
   * Carries one attachment's extracted text over to a copy of it.
   *
   * The copy is a new row with a new id, and `attachment_text` is keyed on that id, so
   * without this a copied PDF would drop out of search until a backfill pass re-read it —
   * on the client, from the bytes, for a result the source row already holds. A source
   * with no text yet leaves the copy without one too, and the backfill finds it there.
   */
  copyText(fromAttachmentId: string, to: { attachmentId: string; noteId: string; filename: string }): void {
    this.sql.tx(() => {
      const copied = this.sql.exec<{ attachment_id: string }>(
        `INSERT INTO attachment_text (attachment_id, note_id, filename, text, read_by, created_at)
         SELECT ?1, ?2, ?3, text, read_by, ?4
           FROM attachment_text
          WHERE attachment_id = ?5
         RETURNING attachment_id`,
        to.attachmentId,
        to.noteId,
        to.filename,
        Date.now(),
        fromAttachmentId,
      );
      this.feed.record(copied.map((r) => ({ entity: 'attachment', id: r.attachment_id })));
    });
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
   * the desktop asks unscoped for everything.
   */
  needingText(limit: number, noteId?: string): PendingFile[] {
    // `content_type` and `has_text` are written exactly as the partial index states them,
    // which is what lets SQLite use it: the walk is over unread PDFs alone, in order,
    // instead of every PDF with a lookup each to see whether it has text. For one note the
    // note's own index is named outright, for the reason `visionPendingHalves` gives: left
    // to itself the planner takes the partial index and walks the account's whole backlog
    // to find one note's files.
    return this.sql
      .exec<PendingRow>(
        `SELECT a.id, a.note_id, a.filename, a.content_type, a.size, a.r2_key
           FROM attachments a${noteId ? ' INDEXED BY idx_attachments_note' : ''}
           JOIN notes n ON n.id = a.note_id
          WHERE a.content_type = 'application/pdf' AND a.has_text = 0
            AND n.deleted_at IS NULL
            ${noteId ? 'AND a.note_id = ?2' : ''}
          ORDER BY a.created_at
          LIMIT ?1`,
        limit,
        ...(noteId ? [noteId] : []),
      )
      .map(toPending);
  }

  /**
   * Files still waiting for the vision model: a picture with no text row, or a PDF whose
   * text layer was read and found empty and that the model has not been asked about.
   *
   * The second half is what `read_by` exists for. An empty row from a text layer and an
   * empty row from the model look the same in `text`, and only one of them should be
   * offered to a reader that costs a request per file.
   *
   * `noteId` narrows to one note, for the same reason it does in `needingText`: auto-fill
   * reads the note in front of the person before it suggests, and must never be handed the
   * account's backlog — every file here is a paid request, and the backlog is the Import
   * panel's to run on purpose.
   */
  needingVision(limit: number, noteId?: string): PendingFile[] {
    const { pictures, pdfs } = visionPendingHalves(noteId ? '?2' : null);
    /*
       `created_at` is selected although nothing reads it. SQLite only runs a compound
       subquery as a merge of its halves when the outer ORDER BY names one of the outer
       result columns; without it the union was materialised and the whole backlog sorted
       in a temp B-tree to hand back three files — 9.4k rows per call of Maintenance's
       "Read N images" at 13k notes. With it, each half walks its partial index in
       `created_at` order and the LIMIT stops them: 283 rows.
    */
    return this.sql
      .exec<PendingRow>(
        `SELECT id, note_id, filename, content_type, size, r2_key, created_at
           FROM (${pictures} UNION ALL ${pdfs})
          ORDER BY created_at
          LIMIT ?1`,
        limit,
        ...(noteId ? [noteId] : []),
      )
      .map(toPending);
  }

  /**
   * How many files `needingVision` would still offer, for a pass to say what is left —
   * on one note when `noteId` is given, as `pendingTextCount` scopes its count.
   */
  visionPending(noteId?: string): number {
    const { pictures, pdfs } = visionPendingHalves(noteId ? '?1' : null);
    const row = this.sql.first<{ pending: number }>(
      `SELECT (SELECT COUNT(*) FROM (${pictures})) + (SELECT COUNT(*) FROM (${pdfs})) AS pending`,
      ...(noteId ? [noteId] : []),
    );
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
  pendingTextCount(noteId?: string): number {
    const row = this.sql.first<{ pending: number }>(
      `SELECT COUNT(*) AS pending
         FROM attachments a${noteId ? ' INDEXED BY idx_attachments_note' : ''}
         JOIN notes n ON n.id = a.note_id
        WHERE a.content_type = 'application/pdf' AND a.has_text = 0
          AND n.deleted_at IS NULL
          ${noteId ? 'AND a.note_id = ?1' : ''}`,
      ...(noteId ? [noteId] : []),
    );
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
   * `null` when the attachment does not exist, and an empty string when it exists but has
   * no text yet — extraction is asynchronous, and "not indexed yet" is a different answer
   * from "no such file".
   */
  textFor(noteId: string, filename: string): string | null {
    const row = this.sql.first<{ text: string }>(
      `SELECT COALESCE(t.text, '') AS text
         FROM attachments a
         LEFT JOIN attachment_text t ON t.attachment_id = a.id
        WHERE a.note_id = ?1 AND a.filename = ?2`,
      noteId,
      filename,
    );
    return row?.text ?? null;
  }

  /**
   * Every file on a live note with whatever text it has, for auto-fill to read the note
   * whole.
   *
   * The same three answers `textFor` gives, per file: `null` while no text has been
   * recorded — a PDF still being read, or never read — and `''` for one read and found
   * empty. The type rides along because a caller telling "still being read" from "a file
   * nothing here reads" needs to know which it is looking at, and `readBy` because text
   * the language model wrote opens with a name for the file, which auto-fill can use.
   */
  textsForNote(noteId: string): Array<{ filename: string; contentType: string; text: string | null; readBy: 'vision' | null }> {
    return this.sql
      .exec<{ filename: string; content_type: string; text: string | null; read_by: string | null }>(
        `SELECT a.filename, a.content_type, t.text, t.read_by
           FROM attachments a
           JOIN notes n ON n.id = a.note_id
           LEFT JOIN attachment_text t ON t.attachment_id = a.id
          WHERE a.note_id = ?1 AND n.deleted_at IS NULL
          ORDER BY a.created_at`,
        noteId,
      )
      .map((r) => ({
        filename: r.filename,
        contentType: r.content_type,
        text: r.text,
        readBy: r.read_by === 'vision' ? 'vision' : null,
      }));
  }

  /**
   * The text held for every file on a page of notes, for the export to write beside them.
   *
   * A statement of its own rather than a column on the page's attachments subquery, which
   * builds one JSON string per note; a note with a few long scans would build one past
   * the size a single value should be. A row per file stays small, since each text is
   * capped at half a million characters when it is stored. Only rows with text come back
   * — an empty row has nothing to carry.
   *
   * The ids go in as one JSON array because the engine binds at most a hundred values and
   * a page may be a hundred notes. The caller chunks by note so the answer stays under
   * the RPC payload ceiling.
   */
  textsForNotes(noteIds: string[]): Array<{ noteId: string; filename: string; text: string; readBy: 'vision' | null }> {
    if (noteIds.length === 0) return [];
    return this.sql
      .exec<{ note_id: string; filename: string; text: string; read_by: string | null }>(
        `SELECT a.note_id, a.filename, t.text, t.read_by
           FROM attachment_text t
           JOIN attachments a ON a.id = t.attachment_id
          WHERE t.note_id IN (SELECT value FROM json_each(?1))
            AND t.text <> ''`,
        JSON.stringify(noteIds),
      )
      .map((r) => ({
        noteId: r.note_id,
        filename: r.filename,
        text: r.text,
        readBy: r.read_by === 'vision' ? 'vision' : null,
      }));
  }

  /** Attachment id for a filename within a live note. */
  idFor(noteId: string, filename: string): string | null {
    return this.resolve(noteId, filename)?.id ?? null;
  }

  /**
   * Every key under a note, for cleanup.
   *
   * Not called on note deletion: that is a soft delete and the note is restorable, so its
   * blobs must survive. The trash purge is where reclaiming that storage belongs, and it
   * reads keys through `NotesStore.purge*`, which take them in the same transaction as
   * the delete.
   */
  keysForNote(noteId: string): string[] {
    return this.sql
      .exec<{ r2_key: string }>(`SELECT r2_key FROM attachments WHERE note_id = ?1`, noteId)
      .map((r) => r.r2_key);
  }

  /**
   * A page of every R2 key the account references, by rowid, for the blob sweep to check
   * the bucket against. Paged because an archive holds thousands and the answer crosses
   * RPC; the sweep walks until `nextRowid` is null.
   */
  blobKeys(afterRowid = 0, limit = 1000): { keys: string[]; nextRowid: number | null } {
    const rows = this.sql.exec<{ rowid: number; r2_key: string }>(
      `SELECT rowid, r2_key FROM attachments WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`,
      afterRowid,
      limit,
    );
    const last = rows[rows.length - 1];
    return { keys: rows.map((r) => r.r2_key), nextRowid: rows.length === limit && last ? last.rowid : null };
  }
}
