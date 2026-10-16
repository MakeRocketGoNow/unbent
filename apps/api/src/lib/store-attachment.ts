import {
  FALLBACK_CONTENT_TYPE,
  formatAttachmentMarkdown,
  normalizeContentType,
  type AttachmentInfo,
} from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';
import type { NotesRepo } from './notes-repo.js';
import { assertRoom, StorageFull } from './quota.js';
import { readAttachment, serverCanRead, uploadReaders } from './read-attachment.js';
import type { Env } from '../types.js';

/** One attachment after it is stored: what it is called now and how to link it. */
export interface StoredAttachment extends AttachmentInfo {
  /** The relative markdown path, `files/<filename>`. */
  path: string;
  /** The markdown that shows it in a note: an image for an image type, a link otherwise. */
  markdown: string;
  /**
   * Where the text extraction will happen. `server` means it is already under way in the
   * background; `client` means this deployment cannot, or the caller said it would supply
   * the text, and otherwise the browser's pass will do it the next time the notes are
   * opened.
   */
  indexing: 'server' | 'client';
}

export interface StoreAttachmentInput {
  noteId: string;
  /**
   * The id the file should have, when the client chose one: a file added offline is a row
   * on that device before the server has heard of it, and the row the feed later delivers
   * has to be the same one. The route has checked that nothing holds it. Minted here
   * otherwise.
   */
  id?: string | undefined;
  /** The name asked for. Suffixed when the note already has a file by that name. */
  filename: string;
  /** As declared by whoever supplied the bytes; normalized here, never verified. */
  contentType: string | null | undefined;
  /**
   * The bytes. A stream goes straight to R2 and is never held in memory, which is what
   * lets an attachment be larger than the Worker's own memory, but R2 has to know how
   * long it is, so a stream here must carry a known length: a request body with a
   * Content-Length, or a FixedLengthStream.
   */
  body: ReadableStream | ArrayBuffer;
  /** Append the markdown to the note body once the file is stored. */
  link: boolean;
  /**
   * The caller will record this file's text itself, so do not read it here. An import
   * from this app's own archive brings each file's text beside it; reading it again would
   * spend a vision request on words the archive already holds, and could land after the
   * archive's text and replace it with different ones.
   */
  textSupplied?: boolean;
  /**
   * The plan's storage in bytes, or null for no limit (lib/quota.ts). Required rather
   * than defaulted so that every way bytes come in decides: a caller with the plan row on
   * its context passes `quotaOf`, one without reads `quotaFor`.
   */
  quota: number | null;
  /**
   * How many bytes are coming, when the caller knows before they move: a request's
   * Content-Length. Checked against the quota before R2 is touched; the true size is
   * checked again after, since this is a claim.
   */
  declaredBytes?: number | undefined;
}

/**
 * Stores bytes as an attachment of a note: the object, the row, the search text, and
 * optionally the link in the body.
 *
 * This is the one place a new attachment comes into being from bytes. The upload route
 * calls it with a request body; the MCP server calls it with a response it fetched on an
 * assistant's behalf. Both used to need the same six steps in the same order, and the
 * order matters (the row is written after R2 confirms the object, the extraction reads
 * the object back after the row exists, the link uses the name that was actually stored),
 * so it lives once, here, rather than being kept in step by hand. `copyAttachments` is
 * deliberately not a caller: a copy carries its source's extracted text across instead of
 * reading the file again, which is a different pipeline with a different middle.
 *
 * The caller checks that the note is the user's and that the filename is one that may be
 * stored; this trusts both. It does not trust the size: R2 reports the byte count it
 * received, and that is what the row records.
 */
export async function storeAttachment(
  env: Pick<Env, 'BLOBS' | 'AI'>,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repos: { attachments: AttachmentsRepo; notes: NotesRepo },
  input: StoreAttachmentInput,
): Promise<StoredAttachment> {
  const { attachments, notes } = repos;
  const { noteId } = input;

  const filename = await attachments.availableFilename(noteId, input.filename);
  const id = input.id ?? crypto.randomUUID();
  const key = attachments.buildKey(noteId, id, filename);

  /**
   * Record the declared type, normalized.
   *
   * Kept rather than verified: the search backfill filters on `application/pdf`, and the
   * export needs real types for the files it writes. What makes this safe is that nothing
   * is *served* from it unchecked: see the GET handler in routes/attachments.ts, which
   * decides the response type independently. Parameters are stripped here so a stored
   * value like `text/html; charset=utf-8` cannot later differ from what the allowlist
   * compares.
   */
  const contentType = normalizeContentType(input.contentType) || FALLBACK_CONTENT_TYPE;

  // Before the bytes move, on what was declared; the stream is cancelled so the client
  // stops sending into a refusal it has already been given.
  if (input.declaredBytes !== undefined) {
    try {
      await assertRoom(attachments, input.quota, input.declaredBytes);
    } catch (err) {
      if (err instanceof StorageFull && input.body instanceof ReadableStream) await input.body.cancel().catch(() => {});
      throw err;
    }
  }

  const object = await env.BLOBS.put(key, input.body, { httpMetadata: { contentType } });
  // Null only when a precondition was given and failed; none is, so this is unreachable.
  if (!object) throw new Error('Upload failed');

  // R2 reports the true byte count; anything the caller declared was a claim. The quota
  // is decided again on that count, in the transaction that records the row, so two
  // uploads in flight cannot both take the last block (`AttachmentsStore.record`); the
  // refusal arrives as `StorageFull` (`translateStoreError`). The object goes before
  // it, since no row will ever name it.
  let info: AttachmentInfo;
  try {
    info = await attachments.record({ id, noteId, filename, contentType, size: object.size, r2Key: key }, { quota: input.quota });
  } catch (err) {
    if (err instanceof StorageFull) await env.BLOBS.delete(key).catch(() => {});
    throw err;
  }

  const path = `files/${filename}`;

  /**
   * Read the file's text layer here, where the deployment can.
   *
   * Every client then gets a searchable PDF without doing anything: the editor, the
   * phone, the import, an assistant, and whatever comes next. After the response rather
   * than before it, because the caller should return the moment the bytes are safe and a
   * reader is seconds of waiting on another service; `waitUntil` gives it thirty. A
   * failure of any kind leaves the row pending, and the browser's pass over pending files
   * remains the fallback: only a reader that looked and found nothing writes the empty
   * row. The result says which way it went, so a client that would extract on its own
   * knows not to.
   *
   * Only the layer, never the model: `uploadReaders` is the free reader alone. A picture,
   * or a scan the layer has nothing for, waits for an Auto-fill press on its note, since
   * MAK-179 made that the one place the model runs. Until then every picture was read as
   * it arrived, a paid request nobody asked for and an import's worth of them at once.
   * Which readers run, and in what order, is lib/read-attachment.ts's business.
   */
  const indexing =
    !input.textSupplied && serverCanRead(env, contentType, object.size) ? 'server' : 'client';
  if (indexing === 'server') {
    const readers = uploadReaders(env);
    ctx.waitUntil(
      readAttachment(env.BLOBS, readers, attachments, {
        id,
        noteId,
        filename,
        contentType,
        size: object.size,
        r2Key: key,
      }).catch((err: unknown) => {
        // Left pending for the passes, and said so, because a request the API refused
        // (a bad key, a shape it will not take) would otherwise look exactly like a file
        // nobody has got to yet. The id rather than the name: names come from the archive.
        console.error('read after upload:', id, (err as Error).message);
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
