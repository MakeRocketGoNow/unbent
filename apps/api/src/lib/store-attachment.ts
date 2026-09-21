import {
  FALLBACK_CONTENT_TYPE,
  formatAttachmentMarkdown,
  normalizeContentType,
  type AttachmentInfo,
} from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';
import type { NotesRepo } from './notes-repo.js';
import { readAttachment, readersFrom, serverCanRead } from './read-attachment.js';
import type { Env } from '../types.js';

/** One attachment after it is stored: what it is called now and how to link it. */
export interface StoredAttachment extends AttachmentInfo {
  /** The relative markdown path, `files/<filename>`. */
  path: string;
  /** The markdown that shows it in a note: an image for an image type, a link otherwise. */
  markdown: string;
  /**
   * Where the text extraction will happen. `server` means it is already under way in the
   * background; `client` means this deployment cannot, and the browser's pass will do it
   * the next time the notes are opened.
   */
  indexing: 'server' | 'client';
}

export interface StoreAttachmentInput {
  noteId: string;
  /** The name asked for. Suffixed when the note already has a file by that name. */
  filename: string;
  /** As declared by whoever supplied the bytes; normalized here, never verified. */
  contentType: string | null | undefined;
  /**
   * The bytes. A stream goes straight to R2 and is never held in memory, which is what
   * lets an attachment be larger than the Worker's own memory — but R2 has to know how
   * long it is, so a stream here must carry a known length: a request body with a
   * Content-Length, or a FixedLengthStream.
   */
  body: ReadableStream | ArrayBuffer;
  /** Append the markdown to the note body once the file is stored. */
  link: boolean;
}

/**
 * Stores bytes as an attachment of a note: the object, the row, the search text, and
 * optionally the link in the body.
 *
 * This is the one place a new attachment comes into being from bytes. The upload route
 * calls it with a request body; the MCP server calls it with a response it fetched on an
 * assistant's behalf. Both used to need the same six steps in the same order, and the
 * order matters — the row is written after R2 confirms the object, the extraction reads
 * the object back after the row exists, the link uses the name that was actually stored
 * — so it lives once, here, rather than being kept in step by hand. `copyAttachments` is
 * deliberately not a caller: a copy carries its source's extracted text across instead of
 * reading the file again, which is a different pipeline with a different middle.
 *
 * The caller checks that the note is the user's and that the filename is one that may be
 * stored; this trusts both. It does not trust the size: R2 reports the byte count it
 * received, and that is what the row records.
 */
export async function storeAttachment(
  env: Pick<Env, 'BLOBS' | 'AI' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_API_URL' | 'ANTHROPIC_MODEL'>,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repos: { attachments: AttachmentsRepo; notes: NotesRepo },
  input: StoreAttachmentInput,
): Promise<StoredAttachment> {
  const { attachments, notes } = repos;
  const { noteId } = input;

  const filename = await attachments.availableFilename(noteId, input.filename);
  const id = crypto.randomUUID();
  const key = attachments.buildKey(noteId, id, filename);

  /**
   * Record the declared type, normalized.
   *
   * Kept rather than verified: the search backfill filters on `application/pdf`, and the
   * export needs real types for the files it writes. What makes this safe is that nothing
   * is *served* from it unchecked — see the GET handler in routes/attachments.ts, which
   * decides the response type independently. Parameters are stripped here so a stored
   * value like `text/html; charset=utf-8` cannot later differ from what the allowlist
   * compares.
   */
  const contentType = normalizeContentType(input.contentType) || FALLBACK_CONTENT_TYPE;

  const object = await env.BLOBS.put(key, input.body, { httpMetadata: { contentType } });
  // Null only when a precondition was given and failed; none is, so this is unreachable.
  if (!object) throw new Error('Upload failed');

  // R2 reports the true byte count; anything the caller declared was a claim.
  const info = await attachments.record({
    id,
    noteId,
    filename,
    contentType,
    size: object.size,
    r2Key: key,
  });

  const path = `files/${filename}`;

  /**
   * Read the file here, where the deployment can.
   *
   * Every client then gets a searchable file without doing anything: the editor, the
   * phone, the import, an assistant, and whatever comes next. After the response rather
   * than before it, because the caller should return the moment the bytes are safe and a
   * reader is seconds of waiting on another service; `waitUntil` gives it thirty. A
   * failure of any kind leaves the row pending, and the passes over pending files remain
   * the fallback — only a reader that looked and found nothing writes the empty row. The
   * result says which way it went, so a client that would extract on its own knows not
   * to. Which readers run, and in what order, is lib/read-attachment.ts's business.
   */
  const indexing = serverCanRead(env, contentType, object.size) ? 'server' : 'client';
  if (indexing === 'server') {
    const readers = readersFrom(env);
    ctx.waitUntil(
      readAttachment(env.BLOBS, readers, attachments, {
        id,
        noteId,
        filename,
        contentType,
        size: object.size,
        r2Key: key,
      }).catch(() => {
        // Left pending for the passes.
      }),
    );
  }

  /**
   * `filename` rather than the requested name: availableFilename may have suffixed a
   * collision, and a link to the name we did not store points at nothing.
   */
  const markdown = formatAttachmentMarkdown(filename, path, {
    image: contentType.startsWith('image/'),
  });
  if (input.link) await notes.appendToBody(noteId, markdown);

  return { ...info, path, markdown, indexing };
}
