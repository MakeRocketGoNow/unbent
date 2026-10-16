import { type AttachmentInfo, type FeedAttachment, type ReadBy, splitExt } from '@unbent/shared';
import type { DeletedBlobs } from './deleted-blobs.js';
import type { Feed } from './feed.js';
import { placeholders, runs } from './notes-shared.js';
import type { Sql } from './sql.js';
import { textSummary, TEXT_SUMMARY_SOURCE_CHARS } from './text-summary.js';
import { STORAGE_FULL_CODE } from '@unbent/shared';

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
  /**
   * `assistant` when the file already has text an assistant wrote over MCP, which the
   * press is offered so the model can read the file itself. Only `needingVision` sets it.
   */
  writtenBy?: 'assistant' | null;
}

/**
 * The files of one note the vision model has still to read, as two queries whose union
 * is the answer: behind `needingVision`, which is Auto-fill's. Pictures with no text row,
 * PDFs whose text layer came back empty and that the model has not been asked about, and
 * of either kind a file whose text an assistant wrote over MCP (`read_by = 'assistant'`):
 * those words are a hint for search until a press has the model read the file itself, so
 * the press is offered them and overwrites them. The halves cannot overlap: one is
 * pictures, the other PDFs.
 *
 * Always one note's. This also listed the account's whole backlog, for a bulk pass a
 * person ran from Maintenance; that pass went with MAK-179, when the model was confined
 * to Auto-fill, and the partial indexes it walked stay in the schema, which is
 * append-only. The per-note indexes are named outright: left to itself the planner
 * prefers those partial indexes, which are account-wide, and walks the whole backlog to
 * find the one note's files. `INDEXED BY` also makes a missing index an error rather than
 * a quiet walk of the archive.
 *
 * The image types are the vision model's (`LLM_IMAGE_TYPES`), spelled out because a
 * query cannot take a Set. `noteParam` is the placeholder the caller binds the note id to.
 */
function visionPendingHalves(noteParam: string): { pictures: string; pdfs: string } {
  const columns = 'a.id, a.note_id, a.filename, a.content_type, a.size, a.r2_key, a.created_at, t.read_by';
  return {
    pictures: `SELECT ${columns}
                 FROM attachments a INDEXED BY idx_attachments_note
                 JOIN notes n ON n.id = a.note_id
                 LEFT JOIN attachment_text t ON t.attachment_id = a.id
                WHERE a.content_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
                  AND (a.has_text = 0 OR t.read_by = 'assistant')
                  AND n.deleted_at IS NULL
                  AND a.note_id = ${noteParam}`,
    pdfs: `SELECT ${columns}
             FROM attachment_text t INDEXED BY idx_attachment_text_note
             JOIN attachments a ON a.id = t.attachment_id
             JOIN notes n ON n.id = a.note_id
            WHERE ((t.text = '' AND t.read_by IS NULL) OR t.read_by = 'assistant')
              AND t.note_id = ${noteParam}
              AND a.content_type = 'application/pdf'
              AND n.deleted_at IS NULL`,
  };
}

/** An `attachments` row as the feed reads it. */
interface FeedAttachmentRow {
  id: string;
  note_id: string;
  filename: string;
  content_type: string;
  size: number;
  has_text: number;
  created_at: number;
}

const toFeedAttachment = (r: FeedAttachmentRow): FeedAttachment => ({
  id: r.id,
  noteId: r.note_id,
  filename: r.filename,
  contentType: r.content_type,
  size: r.size,
  hasText: r.has_text === 1,
  createdAt: r.created_at,
});

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
 * How a file's text came to be, as an assistant is told it beside the file (MAK-172):
 * `vision` when the language model read it, `text` from a PDF's text layer, `pending` while
 * a reader has still to look at it, and `none` when one looked and found nothing, or no
 * reader this instance has will ever look.
 */
export type FileRead = 'vision' | 'text' | 'assistant' | 'pending' | 'none';

/**
 * What `writeAssistantText` answers: written, or why not (the file is not on a live
 * note, or holds its own text layer, or the model's reading).
 */
export interface AssistantWrite {
  ok: boolean;
  /** Why not, when `ok` is false; null when it was written. One shape rather than a union, which the RPC stub's types do not carry. */
  reason: 'missing' | 'unread' | 'layer' | 'vision' | null;
}

/** The row's `read_by` as the three values it may hold; anything else reads as a text layer. */
function textWriter(readBy: string | null): ReadBy | null {
  return readBy === 'vision' || readBy === 'assistant' ? readBy : null;
}

/** One file of a note, with what it says in brief. `summary` is null unless `read` is `vision`, `text` or `assistant`. */
export interface FileSummary {
  filename: string;
  contentType: string;
  size: number;
  read: FileRead;
  summary: string | null;
}

/**
 * The most of a file's text a summary is cut from, and the most a summary may be.
 *
 * Read with `substr` in the query, so a scan of half a million characters never leaves
 * the database whole to be summarised: what crosses into the object is this much a file.
 * Six hundred holds the vision reading's name and description line with room over. A
 * text layer's summary is found in more of it (`TEXT_SUMMARY_SOURCE_CHARS`), since a
 * receipt's total is at its foot. Either is then cut to a few hundred, which is what
 * keeps a page of a hundred notes with a few files each a read rather than an export.
 */
const SUMMARY_SOURCE_CHARS = 600;
const SUMMARY_CHARS = 400;

/**
 * The PDF and picture types a reader here takes; anything else is never read. The readers'
 * own lists are `isExtractable` and `LLM_IMAGE_TYPES`, copied rather than imported because
 * the store takes nothing from the readers' modules; change them together.
 */
const READ_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * A file's summary from the head of its text, as `summariesForNotes` reads it.
 *
 * The vision reading already has one: `formatReading` writes the file's name on the first
 * line and what it is and shows on the second, then a blank line, then the transcription.
 * (`llm.test.ts` runs that layout through this cut, since nothing here imports it.)
 * Everything before that blank line is the summary: "Sushi A Go Go receipt — Receipt:
 * lunch for two, $17.27 by card", and the transcription is what get_attachment_text is
 * for. A text layer has no such head, so its summary is found in the text by pattern
 * (`textSummary`): what it opens with, then its total, dates, order number and amounts.
 * Where it finds nothing at all (a text with no word, date or amount in it) the text
 * itself, folded and cut, is the summary, as every text layer's was before (MAK-177).
 *
 * The statuses follow the readers' own rules (`visionPendingHalves`): no row at all is a
 * file not yet read, if it is a kind anything reads; an empty row from the text layer is
 * a scan the model has still to be asked about; an empty row from the model is final.
 *
 * `vision` is whether this instance has the model, which the store cannot see for itself
 * (`canUseLlm` reads the Worker's env). Without it, a picture and a scan with an empty
 * text layer wait for something that will never come, so they are `none` rather than a
 * `pending` that invites a press on each in turn for a read nothing offers. An
 * unread PDF stays `pending` either way: the browser reads a text layer wherever the
 * server does not.
 */
export function summarize(
  contentType: string,
  head: string | null,
  readBy: string | null,
  vision = true,
): Pick<FileSummary, 'read' | 'summary'> {
  if (head === null) {
    const readable = contentType === 'application/pdf' || (vision && READ_TYPES.has(contentType));
    return { read: readable ? 'pending' : 'none', summary: null };
  }
  if (head.trim() === '') {
    const waiting = vision && readBy !== 'vision' && contentType === 'application/pdf';
    return { read: waiting ? 'pending' : 'none', summary: null };
  }
  if (readBy === 'vision') {
    const lead = head.trim().split(/\n\s*\n/)[0]!;
    const lines = lead.split('\n').map((l) => l.trim()).filter(Boolean);
    return { read: 'vision', summary: clip(lines.join(' — '), SUMMARY_CHARS) };
  }
  // A head that filled the query's cut may end partway through a line ("TOTAL $12" of
  // "TOTAL $121.39"), so its last line is not read for facts.
  const cut = head.length >= TEXT_SUMMARY_SOURCE_CHARS ? head.lastIndexOf('\n') : -1;
  const whole = cut > 0 ? head.slice(0, cut) : head;
  const found = textSummary(whole) || whole.replace(/\s+/g, ' ').trim();
  // An assistant's words have no fixed shape, so they are summarised as a text layer is:
  // the opening, and whatever facts the patterns find. Only the marker differs.
  return { read: readBy === 'assistant' ? 'assistant' : 'text', summary: clip(found, SUMMARY_CHARS) };
}

/** What one answer of `textsById` carries at most; a quarter of a feed page, since it is asked for in the background. */
export const TEXT_PAGE_BYTES = 1024 * 1024;

/**
 * A file the plan's storage has no room for, thrown by `record` inside its transaction.
 * The properties are what cross RPC: the Worker reads `code` off whatever arrived, since
 * `instanceof` fails on the other side, and answers with the numbers.
 */
export class StorageExceeded extends Error {
  readonly code = STORAGE_FULL_CODE;
  constructor(
    readonly usedBytes: number,
    readonly quotaBytes: number,
    readonly addingBytes: number,
  ) {
    super(`the account holds ${usedBytes} bytes of ${quotaBytes}, and ${addingBytes} more would not fit`);
    this.name = 'StorageExceeded';
  }
}

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
  /** `deletedBlobs` is the object's one `DeletedBlobs`: `remove` adds to it and `record` takes from it. */
  constructor(
    private readonly sql: Sql,
    private readonly feed: Feed,
    private readonly deletedBlobs: DeletedBlobs,
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

  /**
   * The files of several notes at once, oldest first within a note, as the feed carries
   * a file (id and `hasText` included, so a snapshot seeds the client's files and a
   * tombstone by id matches one it holds). In runs under the bind cap;
   * `idx_attachments_note` serves each run.
   */
  filesForNotes(noteIds: string[]): Map<string, FeedAttachment[]> {
    const out = new Map<string, FeedAttachment[]>();
    for (const run of runs([...new Set(noteIds)])) {
      for (const r of this.sql.exec<FeedAttachmentRow>(
        `SELECT id, note_id, filename, content_type, size, has_text, created_at FROM attachments
          WHERE note_id IN (${placeholders(1, run.length)})
          ORDER BY note_id, created_at, filename`,
        ...run,
      )) {
        const files = out.get(r.note_id) ?? [];
        files.push(toFeedAttachment(r));
        out.set(r.note_id, files);
      }
    }
    return out;
  }

  /** Files by their own id, as the feed carries a file whose text arrived. */
  attachmentsWhole(ids: string[]): FeedAttachment[] {
    const out: FeedAttachment[] = [];
    for (const run of runs([...new Set(ids)])) {
      for (const r of this.sql.exec<FeedAttachmentRow>(
        `SELECT id, note_id, filename, content_type, size, has_text, created_at FROM attachments
          WHERE id IN (${placeholders(1, run.length)})`,
        ...run,
      )) {
        out.push(toFeedAttachment(r));
      }
    }
    return out;
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

  /**
   * Records a stored file. A name the note already holds is the unique index's error,
   * except with `ifAbsent`, which answers null and writes nothing, for a copy that must
   * not become a second file when another request is copying the same name: two replays
   * of one duplicate, say. Decided here, where the two requests are serialised, rather
   * than by a check in the Worker that both would pass.
   *
   * `quota` is the plan's storage in bytes (MAK-108), and is decided here for the same
   * reason: the bytes the account holds are the totals row's (0008), read and compared
   * in the transaction that inserts, so two uploads in flight cannot both see room for
   * the last block. Past it, nothing is written and `StorageExceeded` is thrown (plain
   * properties, since an error's class does not cross RPC) for the Worker to delete
   * the object it stored and answer the 402. A trashed note's files count; they are in
   * the bucket until the trash is emptied.
   */
  record(
    input: {
      id: string;
      noteId: string;
      filename: string;
      contentType: string;
      size: number;
      r2Key: string;
    },
    opts: { ifAbsent?: boolean | undefined; quota?: number | null | undefined } = {},
  ): AttachmentInfo | null {
    return this.sql.tx(() => {
      if (opts.quota !== undefined && opts.quota !== null) {
        const used = this.sql.first<{ n: number }>(`SELECT attachment_bytes AS n FROM note_counts WHERE id = 1`)?.n ?? 0;
        if (used + input.size > opts.quota) throw new StorageExceeded(used, opts.quota, input.size);
      }
      const inserted = this.sql.exec<{ id: string }>(
        `INSERT INTO attachments (id, note_id, filename, content_type, size, r2_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ${opts.ifAbsent ? 'ON CONFLICT(note_id, filename) DO NOTHING' : ''}
         RETURNING id`,
        input.id,
        input.noteId,
        input.filename,
        input.contentType,
        input.size,
        input.r2Key,
        Date.now(),
      );
      if (inserted.length === 0) return null;
      // The key may be one a deleted row had, if this is a replay of an upload whose
      // first copy has since been deleted: the file is live again, so its tombstone goes,
      // or the sweep would delete the object from under this row. See `DeletedBlobs.revive`.
      this.deletedBlobs.revive(input.r2Key);
      // The file, and the note it changes the shape of: a client keeps a note's files
      // with the note, and a row on its own would leave the note's list stale.
      this.feed.record([
        { entity: 'attachment', id: input.id },
        { entity: 'note', id: input.noteId },
      ]);
      return { filename: input.filename, contentType: input.contentType, size: input.size };
    });
  }

  /**
   * Deletes a file's row, and tombstones its R2 key (`DeletedBlobs`) for the sweep to
   * delete the object thirty-five days on. Returns the key, so the caller can tell a file
   * that went from one that was not there, not for the caller to delete; a store wound
   * back to before this call must find the object still in the bucket. Null when there is
   * no such file on a live note.
   */
  remove(noteId: string, filename: string): string | null {
    return this.sql.tx(() => {
      const row = this.resolve(noteId, filename);
      if (!row) return null;
      this.sql.exec(`DELETE FROM attachments WHERE id = ?1`, row.id);
      this.deletedBlobs.tombstone([row.r2_key], Date.now());
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
     * `'vision'` when the vision model wrote the row, whatever it found; `'assistant'`
     * when an assistant wrote it over MCP (`writeAssistantText` is the only writer of
     * that, bar an archive restoring it). Absent or null for a text layer, which is what
     * every row was before.
     */
    readBy?: ReadBy | null | undefined;
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
   * without this a copied PDF would drop out of search until a backfill pass re-read it:
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
   * Takes the text an assistant read off a file, over MCP, where nothing better is held.
   *
   * Three things may stand in the row and only one of them yields: nothing, or an empty
   * row (a text layer or the model that looked and found nothing), or the assistant's
   * own earlier words, which it may revise. A text layer is the file's own words and the
   * model's reading is the instance's; an assistant overwriting either would put a model
   * nobody here chose in front of both, so those are refused, by name, for the tool to
   * explain. Nor does a PDF nothing has looked at yet: a row here would set `has_text`
   * and take it off `needingText`, so its layer would never be read and the next press
   * would pay the model for a scan that had one, the guarantee lib/read-attachment.ts
   * keeps. It is refused as `unread` until the free reader has had its turn; a layer that
   * came back empty is a row, and yields. What is written is marked `assistant`, and `needingVision` offers it to the
   * next Auto-fill press, which has the model read the file itself and replaces it: the
   * attachment stays the source of truth, and the assistant's words bridge the gap until
   * someone presses. The note must be live, as every other write to a file requires.
   */
  writeAssistantText(noteId: string, filename: string, text: string): AssistantWrite {
    return this.sql.tx(() => {
      const row = this.sql.first<{ id: string; content_type: string; text: string | null; read_by: string | null }>(
        `SELECT a.id, a.content_type, t.text, t.read_by
           FROM attachments a
           JOIN notes n ON n.id = a.note_id
           LEFT JOIN attachment_text t ON t.attachment_id = a.id
          WHERE a.note_id = ?1 AND a.filename = ?2 AND n.deleted_at IS NULL`,
        noteId,
        filename,
      );
      if (!row) return { ok: false, reason: 'missing' };
      if (row.content_type === 'application/pdf' && row.text === null) return { ok: false, reason: 'unread' };
      if (row.text && row.read_by !== 'assistant') return { ok: false, reason: row.read_by === 'vision' ? 'vision' : 'layer' };
      this.recordText({ attachmentId: row.id, noteId, filename, text, readBy: 'assistant' });
      return { ok: true, reason: null };
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
   * One note's files still waiting for the vision model: a picture with no text row, or a
   * PDF whose text layer was read and found empty and that the model has not been asked
   * about. What an Auto-fill press reads before it suggests (`autofillPrelude`), capped
   * by the caller.
   *
   * The second half is what `read_by` exists for. An empty row from a text layer and an
   * empty row from the model look the same in `text`, and only one of them should be
   * offered to a reader that costs a request per file.
   *
   * Only ever one note's, never the account's backlog: every file here is a paid request,
   * and since MAK-179 the model reads only what a press asks about.
   *
   * Files nothing has read come first, whatever their age. A file the model declined over
   * an assistant's words keeps those words and is offered again on every press, and five
   * such files on one note would otherwise fill every slot of a press's cap for good.
   */
  needingVision(limit: number, noteId: string): PendingFile[] {
    const { pictures, pdfs } = visionPendingHalves('?2');
    // `created_at` and `read_by` are selected although the caller reads neither: the
    // ordering is on them, over the compound, and the outer SELECT may order by anything.
    return this.sql
      .exec<PendingRow & { read_by: string | null }>(
        `SELECT id, note_id, filename, content_type, size, r2_key, created_at, read_by
           FROM (${pictures} UNION ALL ${pdfs})
          ORDER BY (read_by IS 'assistant'), created_at
          LIMIT ?1`,
        limit,
        noteId,
      )
      .map((r) => ({ ...toPending(r), writtenBy: r.read_by === 'assistant' ? ('assistant' as const) : null }));
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
   * no text yet: extraction is asynchronous, and "not indexed yet" is a different answer
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
   * `textFor`, with how the text came to be (`summarize`'s `read`), for MCP's
   * `get_attachment_text`: an empty answer alone left the tool saying a file "may still be
   * being processed, or may have no text layer", which is the guess `read` exists to
   * settle. Null when there is no such file. `text` is null unless `read` is `vision` or
   * `text`.
   */
  textWithRead(noteId: string, filename: string, vision = true): { read: FileRead; text: string | null } | null {
    const row = this.sql.first<{ content_type: string; text: string | null; read_by: string | null }>(
      `SELECT a.content_type, t.text, t.read_by
         FROM attachments a
         LEFT JOIN attachment_text t ON t.attachment_id = a.id
        WHERE a.note_id = ?1 AND a.filename = ?2`,
      noteId,
      filename,
    );
    if (!row) return null;
    // Only the head goes to `summarize`, which folds what it is given into a summary this
    // caller does not want; trimmed first so a text that opens with blank lines is not
    // taken for an empty one.
    const head = row.text === null ? null : row.text.trim().slice(0, SUMMARY_SOURCE_CHARS);
    const { read } = summarize(row.content_type, head, row.read_by, vision);
    return { read, text: read === 'vision' || read === 'text' || read === 'assistant' ? row.text : null };
  }

  /**
   * Every file on a live note with whatever text it has, for auto-fill to read the note
   * whole.
   *
   * The same three answers `textFor` gives, per file: `null` while no text has been
   * recorded (a PDF not read yet, or whose read failed), and `''` for one read and found
   * empty. The type rides along because a caller telling "couldn't read" from "a file
   * nothing here reads" needs to know which it is looking at, and `readBy` because text
   * the language model wrote opens with a name for the file, which auto-fill can use.
   */
  textsForNote(noteId: string): Array<{ filename: string; contentType: string; text: string | null; readBy: ReadBy | null }> {
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
        readBy: textWriter(r.read_by),
      }));
  }

  /**
   * The text held for every file on a page of notes, for the export to write beside them.
   *
   * A statement of its own rather than a column on the page's attachments subquery, which
   * builds one JSON string per note; a note with a few long scans would build one past
   * the size a single value should be. A row per file stays small, since each text is
   * capped at half a million characters when it is stored. Only rows with text come back:
   * an empty row has nothing to carry.
   *
   * The ids go in as one JSON array because the engine binds at most a hundred values and
   * a page may be a hundred notes. The caller chunks by note so the answer stays under
   * the RPC payload ceiling.
   */
  textsForNotes(noteIds: string[]): Array<{ noteId: string; filename: string; text: string; readBy: ReadBy | null }> {
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
        readBy: textWriter(r.read_by),
      }));
  }

  /**
   * Every file of the given notes with what it says in brief (`summarize`), oldest first
   * within a note, for MCP's `get_note` and `list_notes` (MAK-172). Filling a notebook's
   * fields from its scans took a `get_note` and a `get_attachment_text` per note; with a
   * line per file on the list, a page of a hundred receipts shows its merchants, dates and
   * totals in one call.
   *
   * Only the head of each text is read, never the text whole: `SUMMARY_SOURCE_CHARS` of a
   * vision reading, whose summary is its first lines, and `TEXT_SUMMARY_SOURCE_CHARS` of
   * a text layer, whose total is usually at the foot of its first page.
   * Through `idx_attachments_note` by note, then the text by its key: two rows a file and
   * nothing that grows with the account. The ids go in as one JSON array for the reason
   * `textsForNotes` gives.
   */
  summariesForNotes(noteIds: string[], vision = true): Record<string, FileSummary[]> {
    const out: Record<string, FileSummary[]> = {};
    if (noteIds.length === 0) return out;
    for (const r of this.sql.exec<{ note_id: string; filename: string; content_type: string; size: number; head: string | null; read_by: string | null }>(
      `SELECT a.note_id, a.filename, a.content_type, a.size,
              substr(t.text, 1, CASE WHEN t.read_by = 'vision' THEN ?2 ELSE ?3 END) AS head, t.read_by
         FROM attachments a
         LEFT JOIN attachment_text t ON t.attachment_id = a.id
        WHERE a.note_id IN (SELECT value FROM json_each(?1))
        ORDER BY a.note_id, a.created_at, a.filename`,
      JSON.stringify(noteIds),
      SUMMARY_SOURCE_CHARS,
      TEXT_SUMMARY_SOURCE_CHARS,
    )) {
      (out[r.note_id] ??= []).push({
        filename: r.filename,
        contentType: r.content_type,
        size: r.size,
        ...summarize(r.content_type, r.head, r.read_by, vision),
      });
    }
    return out;
  }

  /**
   * The text held for files named by their own ids, for a device building the index it
   * searches with no connection (MAK-142). A device asks for the files of the notebooks
   * it keeps offline and of the notes opened on it lately, a few dozen ids at a time.
   *
   * Cut on bytes, like a feed page: a text can be half a million characters, and fifty of
   * those would be past what one answer should carry. The sizes are read first and the
   * texts only for the ids that fit, always at least one; the rest come back in `left`
   * for the next call. An id with no text row (a file never read, or gone) is in
   * neither list, which is the answer: there is nothing to index for it.
   *
   * The sizes are `octet_length`, which answers from the row's header: measuring with
   * `length(CAST(text AS BLOB))` loaded every text whole, overflow pages and all, to
   * decide which ones to then load. By primary key, so a call reads six rows per file as
   * the meter counts them (measured, on the archive-sized store) and nothing that grows
   * with the account. The ids go in as
   * one JSON array for the reason `textsForNotes` gives.
   */
  textsById(ids: string[], budget = TEXT_PAGE_BYTES): { texts: Array<{ id: string; text: string }>; left: string[] } {
    if (ids.length === 0) return { texts: [], left: [] };
    const sizes = new Map(
      this.sql
        .exec<{ id: string; bytes: number }>(
          `SELECT attachment_id AS id, octet_length(text) AS bytes
             FROM attachment_text
            WHERE attachment_id IN (SELECT value FROM json_each(?1))`,
          JSON.stringify(ids),
        )
        .map((r) => [r.id, r.bytes]),
    );
    const take: string[] = [];
    const left: string[] = [];
    let used = 0;
    for (const id of ids) {
      const bytes = sizes.get(id);
      if (bytes === undefined) continue;
      if (take.length > 0 && used + bytes > budget) {
        left.push(id);
        continue;
      }
      take.push(id);
      used += bytes;
    }
    if (take.length === 0) return { texts: [], left };
    const texts = this.sql.exec<{ id: string; text: string }>(
      `SELECT attachment_id AS id, text
         FROM attachment_text
        WHERE attachment_id IN (SELECT value FROM json_each(?1))`,
      JSON.stringify(take),
    );
    return { texts, left };
  }

  /** Attachment id for a filename within a live note. */
  idFor(noteId: string, filename: string): string | null {
    return this.resolve(noteId, filename)?.id ?? null;
  }

  /**
   * A file by its own id, with the note that holds it: what an upload that names its id
   * asks first, so a request replayed after a lost answer finds the file it already made
   * rather than storing `scan-2.pdf` beside it. By primary key; one row read.
   */
  byId(id: string): (AttachmentInfo & { noteId: string }) | null {
    const r = this.sql.first<{ note_id: string; filename: string; content_type: string; size: number }>(
      `SELECT note_id, filename, content_type, size FROM attachments WHERE id = ?1`,
      id,
    );
    return r ? { noteId: r.note_id, filename: r.filename, contentType: r.content_type, size: r.size } : null;
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
