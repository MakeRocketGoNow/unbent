import { isExtractable } from '@unbent/enex/ocr-text';
import type { AttachmentsRepo } from './attachments-repo.js';
import { canExtractOnServer, extractOnServer, type MarkdownConverter } from './extract-text.js';
import { canReadImages, formatReading, readableByVision, visionFrom, type VisionEnv, type VisionModel } from './vision.js';

/**
 * Reading one stored file into `attachment_text`, whichever way this deployment can.
 *
 * Two readers, tried in order of cost. The text layer first: Workers AI's conversion
 * reads a PDF's for free and in a second, and most scans have one. The vision model for
 * what that leaves — a picture, which has no layer, or a scan the conversion read and
 * found empty — at a request per file. The order is what keeps a text-layer PDF from ever
 * being sent to the paid reader, and a scan from being read twice.
 *
 * One place, because three paths need the same steps in the same order: the upload
 * (after the response, see `storeAttachment`), the browser reporting a PDF it read and
 * found empty (routes/attachments.ts), and the backfill over everything still pending.
 */

/** The file as the repo knows it, which is what both readers need. */
export interface StoredFile {
  id: string;
  noteId: string;
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
}

export interface Readers {
  /** The PDF text-layer reader, when the deployment binds Workers AI. */
  converter?: MarkdownConverter;
  /** The vision model, when the deployment has a key for one. */
  vision?: VisionModel;
}

export function readersFrom(env: VisionEnv & { AI?: MarkdownConverter }): Readers {
  return {
    ...(env.AI ? { converter: env.AI } : {}),
    ...(canReadImages(env) ? { vision: visionFrom(env) } : {}),
  };
}

/**
 * Whether the server will read this file after storing it, so the client knows not to.
 *
 * A PDF is the server's only where the conversion is bound: without it the text layer is
 * the browser's to read, as it always was, and the vision model is asked only for what
 * the browser then reports empty — sending every text-layer scan to the paid reader
 * because a laptop lacked a binding would be the wrong economy. A picture has no text
 * layer, so it is the server's wherever the vision model is.
 */
export function serverCanRead(
  env: VisionEnv & { AI?: unknown },
  contentType: string,
  size: number,
): boolean {
  if (canExtractOnServer(env, contentType, size)) return true;
  return canReadImages(env) && !isExtractable(contentType) && readableByVision(contentType, size);
}

/** Where the bytes come from; R2's binding, or a stand-in. */
export interface BlobStore {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/**
 * What became of the file: `text` from its layer, `vision` from the model, `empty` when
 * a reader looked and found nothing (recorded, so nobody looks again), `unread` when no
 * reader here could take it and the row stays pending for one that can.
 */
export type Reading = 'text' | 'vision' | 'empty' | 'unread';

export async function readAttachment(
  blobs: BlobStore,
  readers: Readers,
  attachments: Pick<AttachmentsRepo, 'recordText'>,
  file: StoredFile,
): Promise<Reading> {
  const record = (text: string, readBy: 'vision' | null) =>
    attachments.recordText({ attachmentId: file.id, noteId: file.noteId, filename: file.filename, text, readBy });

  let bytes: ArrayBuffer | null = null;
  const load = async () => {
    if (bytes) return bytes;
    const stored = await blobs.get(file.r2Key);
    if (!stored) throw new Error(`No object at ${file.r2Key}`);
    bytes = await stored.arrayBuffer();
    return bytes;
  };

  if (readers.converter && canExtractOnServer({ AI: readers.converter }, file.contentType, file.size)) {
    const extracted = await extractOnServer(readers.converter, file.filename, new Blob([await load()]));
    if (extracted?.quality.usable) {
      await record(extracted.text, null);
      return 'text';
    }
    // Read and found empty, or could not be read at all: the vision model's turn, if
    // there is one. Without one, an empty read closes the row as it always did and a
    // failed read leaves it for the browser's pass.
    if (!readers.vision) {
      if (extracted) await record('', null);
      return extracted ? 'empty' : 'unread';
    }
  }

  if (readers.vision && readableByVision(file.contentType, file.size)) {
    return readWithVision(readers.vision, attachments, file, await load());
  }

  return 'unread';
}

/**
 * The vision model alone, for a file that is past the text layer: a picture, or a scan
 * the layer had nothing for. Whatever it says is recorded under its name, so a backfill
 * never pays for the same file twice — a decline included.
 */
export async function readWithVision(
  vision: VisionModel,
  attachments: Pick<AttachmentsRepo, 'recordText'>,
  file: StoredFile,
  bytes: ArrayBuffer,
): Promise<Reading> {
  const reading = await vision.read({ filename: file.filename, contentType: file.contentType, bytes });
  await attachments.recordText({
    attachmentId: file.id,
    noteId: file.noteId,
    filename: file.filename,
    text: reading ? formatReading(reading) : '',
    readBy: 'vision',
  });
  return reading ? 'vision' : 'empty';
}
