import type { AttachmentInfo } from '@unbent/shared';
import { StoreRepo } from './store-client.js';
import type { AttachmentRow, AttachmentsStore, PendingFile } from '../store/attachments.js';

/**
 * Attachment metadata for one user, answered by that user's store.
 *
 * A facade over `AttachmentsStore` (src/store/attachments.ts), one RPC call per method,
 * keeping the signatures the routes and orchestrators were written against. The SQL and
 * the reasoning behind each query live with the store; what stays here is the one thing
 * that needs the user id and not the database: the R2 key.
 *
 * R2 keys are built from the verified session's user id, never from client input, so
 * even a wrong query could not produce a key outside the user's own prefix. Bytes never
 * pass through the object; the Worker reads and writes R2 itself, before or after the
 * call that records the row.
 */
export class AttachmentsRepo extends StoreRepo {
  /**
   * Resolves `files/<filename>` within a live note, or a trashed one too with
   * `includeTrashed`. Null when there is no such file.
   */
  resolve(noteId: string, filename: string, opts?: { includeTrashed?: boolean }): Promise<AttachmentRow | null> {
    return this.call((s) => s.resolveAttachment(noteId, filename, opts));
  }

  listForNote(noteId: string): Promise<AttachmentInfo[]> {
    return this.call((s) => s.listAttachments(noteId));
  }

  /** A note's files, live or trashed, or null when there is no such note. */
  filesForNote(noteId: string): Promise<AttachmentInfo[] | null> {
    return this.call((s) => s.filesForNote(noteId));
  }

  /** True when the note exists and is not deleted. Ownership is the object's; see `reposFor`. */
  ownsNote(noteId: string): Promise<boolean> {
    return this.call((s) => s.ownsNote(noteId));
  }

  availableFilename(noteId: string, desired: string): Promise<string> {
    return this.call((s) => s.availableFilename(noteId, desired));
  }

  /** R2 key for a new attachment. Built from the session; never from client input. */
  buildKey(noteId: string, attachmentId: string, filename: string): string {
    return `users/${this.userId}/notes/${noteId}/files/${attachmentId}-${filename}`;
  }

  record(input: {
    id: string;
    noteId: string;
    filename: string;
    contentType: string;
    size: number;
    r2Key: string;
  }): Promise<AttachmentInfo>;
  record(input: Parameters<AttachmentsStore['record']>[0], opts: { ifAbsent: true }): Promise<AttachmentInfo | null>;
  record(input: Parameters<AttachmentsStore['record']>[0], opts?: { ifAbsent?: boolean }): Promise<AttachmentInfo | null> {
    return this.call((s) => s.recordAttachment(input, opts));
  }

  /** Returns the R2 key to delete, or null when there is no such file on a live note. */
  remove(noteId: string, filename: string): Promise<string | null> {
    return this.call((s) => s.removeAttachment(noteId, filename));
  }

  recordText(input: {
    attachmentId: string;
    noteId: string;
    filename: string;
    text: string;
    readBy?: 'vision' | null | undefined;
  }): Promise<void> {
    return this.call((s) => s.recordText(input));
  }

  copyText(fromAttachmentId: string, to: { attachmentId: string; noteId: string; filename: string }): Promise<void> {
    return this.call((s) => s.copyText(fromAttachmentId, to));
  }

  needingText(limit: number, noteId?: string): Promise<PendingFile[]> {
    return this.call((s) => s.needingText(limit, noteId));
  }

  needingVision(limit: number, noteId?: string): Promise<PendingFile[]> {
    return this.call((s) => s.needingVision(limit, noteId));
  }

  visionPending(noteId?: string): Promise<number> {
    return this.call((s) => s.visionPending(noteId));
  }

  pendingTextCount(noteId?: string): Promise<number> {
    return this.call((s) => s.pendingTextCount(noteId));
  }

  /** `GET /attachments/pending-text`: the next files and, when asked, how many remain, in one call. */
  pendingText(limit: number, noteId: string | undefined, counted: boolean): Promise<{ files: PendingFile[]; remaining?: number }> {
    return this.call((s) => s.pendingText(limit, noteId, counted));
  }

  textFor(noteId: string, filename: string): Promise<string | null> {
    return this.call((s) => s.textFor(noteId, filename));
  }

  textsForNote(noteId: string): Promise<Array<{ filename: string; contentType: string; text: string | null; readBy: 'vision' | null }>> {
    return this.call((s) => s.textsForNote(noteId));
  }

  /**
   * The texts for a page of notes, ten notes per call: each text can be half a million
   * characters and an RPC result is capped at 32 MiB, so a page of a hundred notes with
   * a few scans each is asked for in pieces. The export page uses `exportPage` instead,
   * which budgets by bytes; this is for callers that already hold the note ids.
   */
  async textsForNotes(noteIds: string[]): Promise<Array<{ noteId: string; filename: string; text: string; readBy: 'vision' | null }>> {
    const out: Array<{ noteId: string; filename: string; text: string; readBy: 'vision' | null }> = [];
    for (let i = 0; i < noteIds.length; i += 10) {
      const chunk = noteIds.slice(i, i + 10);
      out.push(...(await this.call((s) => s.textsForNotes(chunk))));
    }
    return out;
  }

  idFor(noteId: string, filename: string): Promise<string | null> {
    return this.call((s) => s.attachmentIdFor(noteId, filename));
  }

  keysForNote(noteId: string): Promise<string[]> {
    return this.call((s) => s.keysForNote(noteId));
  }

  /** A page of every R2 key the account references, for the blob sweep. */
  blobKeys(afterRowid = 0, limit = 1000): Promise<{ keys: string[]; nextRowid: number | null }> {
    return this.call((s) => s.allBlobKeys(afterRowid, limit));
  }

  /** What `read_attachment` asks before it reads, in one call. Null when the note is not live. */
  readPrelude(noteId: string, filename: string, filesPerNote: number): Promise<{ text: string | null; forText: PendingFile[]; forVision: PendingFile[] } | null> {
    return this.call((s) => s.attachmentReadPrelude(noteId, filename, filesPerNote));
  }
}
