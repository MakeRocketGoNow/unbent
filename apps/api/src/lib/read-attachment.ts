import { isExtractable } from '@unbent/enex/ocr-text';
import type { AttachmentsRepo } from './attachments-repo.js';
import type { PendingFile as StoredPending } from '../store/attachments.js';
import { canExtractOnServer, extractOnServer, type MarkdownConverter } from './extract-text.js';
import { canUseLlm, formatReading, readableByLlm, llmFrom, type LlmEnv, type LanguageModel } from './llm.js';
import { withReaderSlot } from './reader-gate.js';

/**
 * Reading one stored file into `attachment_text`, whichever way this deployment can.
 *
 * Two readers, tried in order of cost. The text layer first: Workers AI's conversion
 * reads a PDF's for free and in a second, and most scans have one. The vision model for
 * what that leaves — a picture, which has no layer, or a scan the conversion read and
 * found empty — at a request per file. The order is what keeps a text-layer PDF from ever
 * being sent to the paid reader, and a scan from being read twice.
 *
 * Who gets which reader is decided here too, and it is the one rule of MAK-179: the
 * layer reads anything, since it is free, and the model reads only inside an Auto-fill
 * press, since a person asked. An upload gets `uploadReaders`, the layer alone; the press
 * gets `autofillReaders`, both. Until then every picture was read as it arrived — from
 * the editor, the phone, an import or an assistant, a paid request nobody asked for and
 * an archive's worth of them at once on an import — and a scan the browser found empty
 * was sent to the model the moment it said so. Both now wait, pending, for the press.
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
  /** The language model, when the deployment has a key for one. Only its reading is needed here. */
  llm?: Pick<LanguageModel, 'read'>;
}

/**
 * The readers an upload may use: the text layer, and nothing that costs a request. What
 * `storeAttachment` hands `readAttachment` after the response.
 */
export function uploadReaders(env: { AI?: MarkdownConverter }): Readers {
  return env.AI ? { converter: env.AI } : {};
}

/**
 * The readers an Auto-fill press may use: the layer, and the model where the instance
 * has a key. The one place the model is built for reading — a test in
 * read-attachment.test.ts greps the source to keep it so — and `POST /notes/:id/autofill`
 * is its one caller.
 */
export function autofillReaders(env: LlmEnv & { AI?: MarkdownConverter }): Readers {
  return {
    ...uploadReaders(env),
    ...(canUseLlm(env) ? { llm: llmFrom(env) } : {}),
  };
}

/**
 * Whether the server will read this file after storing it, so the client knows not to.
 *
 * A PDF is the server's only where the conversion is bound: without it the text layer is
 * the browser's to read, as it always was. A picture is never the server's here: it has
 * no layer, and the model that could read it runs only inside an Auto-fill press
 * (MAK-179). So `client`, and the browser, which knows a picture has no text to extract,
 * leaves it pending for that press.
 */
export function serverCanRead(env: { AI?: unknown }, contentType: string, size: number): boolean {
  return canExtractOnServer(env, contentType, size);
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

  /*
     A PDF never goes to the paid reader from here without the conversion having looked
     first. Where the conversion is not bound, the text layer is the browser's to read,
     and a scan it reports empty waits for an Auto-fill press, which reads it through
     `readPendingFile`. `serverCanRead` keeps such a PDF from reaching this function at
     all; this keeps the guarantee that a text-layer scan is never paid for in the one
     function that could break it.

     Decided before the slot, because it reads nothing: a file no reader here can take must
     not wait behind ones that are holding memory.
  */
  if (isExtractable(file.contentType) && !readers.converter) return 'unread';

  /*
     Everything past here loads the whole file into the isolate. An import fires these off
     back to back in `waitUntil` on one isolate, so `withReaderSlot` caps how many hold a
     file at once — without it a burst of large attachments evicts the isolate with
     `exceededResources`, which reaches the browser as a 503 and stops the run. See
     reader-gate.ts.
  */
  return withReaderSlot(async () => {
    if (readers.converter && canExtractOnServer({ AI: readers.converter }, file.contentType, file.size)) {
      const extracted = await extractOnServer(readers.converter, file.filename, new Blob([await load()]));
      if (extracted?.quality.usable) {
        await record(extracted.text, null);
        return 'text';
      }
      // Read and found empty, or could not be read at all: the vision model's turn, if
      // there is one. Without one, an empty read closes the row as it always did and a
      // failed read leaves it for the browser's pass.
      if (!readers.llm) {
        if (extracted) await record('', null);
        return extracted ? 'empty' : 'unread';
      }
    }

    if (readers.llm && readableByLlm(file.contentType, file.size)) {
      return readWithLlm(readers.llm, attachments, file, await load());
    }

    return 'unread';
  });
}

/**
 * A file still waiting for a reader, and which one: `text` for a PDF nothing has looked
 * at, which takes the whole path (`readAttachment` — the layer, then the model for what
 * the layer lacks); `vision` for a file already past the layer — a picture, or a scan the
 * browser read and found empty — which goes to the model alone. The two are what the
 * store's `needingText` and `needingVision` list, respectively, and `writtenBy` is the
 * store's too: `assistant` when the text an assistant wrote over MCP is what a press is
 * re-reading past.
 */
export type PendingFile = StoredFile & Pick<StoredPending, 'writtenBy'> & { pending: 'text' | 'vision' };

/** What a pass over pending files did, for the caller to report or count. */
export interface ReadCounts {
  /** Recorded text, from the layer or the model. */
  read: number;
  /** A reader looked and found nothing; recorded, so it is not offered again. */
  empty: number;
  /** The file threw — missing object, model outage — and stays pending for a later pass. */
  failed: number;
  /** No reader here takes it; stays pending for a deployment that has one. */
  unread: number;
}

/**
 * Reads the files a caller has already chosen, one after another, and says what became
 * of each. Auto-fill's, reading the note in front of the person before it suggests; it
 * was also the loop behind Maintenance's bulk pass and MCP's read tool until MAK-179
 * confined the model to a press.
 *
 * The rules are that bulk pass's, which this was lifted from. One unreadable file must
 * not stop the pass — it is counted and the rest go on. A file past the model's size caps
 * is recorded as the model's empty answer rather than skipped, or every pass would offer
 * it again. The id is what gets logged, never the name, which comes from the archive and
 * can say too much.
 */
export async function readPendingFiles(
  blobs: BlobStore,
  readers: Readers,
  attachments: Pick<AttachmentsRepo, 'recordText'>,
  files: readonly PendingFile[],
): Promise<ReadCounts> {
  const counts: ReadCounts = { read: 0, empty: 0, failed: 0, unread: 0 };
  for (const file of files) {
    try {
      const outcome = await readPendingFile(blobs, readers, attachments, file);
      if (outcome === 'text' || outcome === 'vision') counts.read += 1;
      else counts[outcome] += 1;
    } catch (err) {
      console.error('read:', file.id, (err as Error).message);
      counts.failed += 1;
    }
  }
  return counts;
}

/** One file of `readPendingFiles`, thrown rather than counted so a single-file caller sees why. */
export async function readPendingFile(
  blobs: BlobStore,
  readers: Readers,
  attachments: Pick<AttachmentsRepo, 'recordText'>,
  file: PendingFile,
): Promise<Reading> {
  if (file.pending === 'text') return readAttachment(blobs, readers, attachments, file);

  if (!readers.llm) return 'unread';
  if (!readableByLlm(file.contentType, file.size)) {
    await attachments.recordText({ attachmentId: file.id, noteId: file.noteId, filename: file.filename, text: '', readBy: 'vision' });
    return 'empty';
  }
  const stored = await blobs.get(file.r2Key);
  if (!stored) throw new Error(`No object at ${file.r2Key}`);
  return readWithLlm(readers.llm, attachments, file, await stored.arrayBuffer());
}

/**
 * The vision model alone, for a file that is past the text layer: a picture, or a scan
 * the layer had nothing for. Whatever it says is recorded under its name, so a later
 * press never pays for the same file twice — a decline included.
 */
async function readWithLlm(
  llm: Pick<LanguageModel, 'read'>,
  attachments: Pick<AttachmentsRepo, 'recordText'>,
  file: StoredFile & Pick<StoredPending, 'writtenBy'>,
  bytes: ArrayBuffer,
): Promise<Reading> {
  const reading = await llm.read({ filename: file.filename, contentType: file.contentType, bytes });
  // A decline over an assistant's words leaves them standing: the model gave nothing to
  // put in their place, and an empty row would take text search and summaries were using.
  // The file stays offered to later presses — after anything nothing has read, which is
  // how `needingVision` orders them — so it is the one case a press pays for more than
  // once. The tool that writes those words says so.
  if (!reading && file.writtenBy === 'assistant') return 'empty';
  await attachments.recordText({
    attachmentId: file.id,
    noteId: file.noteId,
    filename: file.filename,
    text: reading ? formatReading(reading) : '',
    readBy: 'vision',
  });
  return reading ? 'vision' : 'empty';
}
