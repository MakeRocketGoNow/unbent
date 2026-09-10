import { enmlToMarkdown } from './enml-to-markdown.js';
import { parseEnexStream } from './parse.js';
import { isExtractable } from './ocr-text.js';
import { extractPdfText } from './pdf-text.js';
import { contentHash, withSourceLink } from './note-body.js';
import type { EnexNote } from './types.js';

/**
 * Drives an ENEX import: parse, convert, upload.
 *
 * Runs wherever it is called from — the API calls are injected — so the orchestration can
 * be tested against a fake client without a browser or a server.
 */

export interface ImportProgress {
  /** Notes handed to the server so far, including ones skipped as already-imported. */
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  filesUploaded: number;
  /** Attachments whose embedded text was extracted and indexed. */
  filesIndexed: number;
  bytesRead: number;
  currentTitle: string;
}

export interface ImportFailure {
  title: string;
  reason: string;
}

/**
 * Consecutive failures carrying the same HTTP status that end a run.
 *
 * Low on purpose. The failures this catches are not a property of the notes — they are the
 * server having gone away — so every attempt after the first few is a request nobody
 * wanted, against a host that will not answer, producing a failure line that looks
 * individually actionable and is not.
 */
export const FAILURE_STREAK_LIMIT = 5;

/**
 * Thrown when a run gave up rather than reaching the end of the file.
 *
 * A run that stops early is not a run that finished, and reporting it as one is how a
 * merged pull request deleting its own preview Worker mid-import came to read as
 * "Finished. 58 notes imported" beside 36 notes that had simply never been tried.
 */
export class ImportStoppedError extends Error {
  constructor(
    readonly status: number,
    readonly streak: number,
    message: string,
  ) {
    super(message);
    this.name = 'ImportStoppedError';
  }
}

/**
 * The HTTP status an injected client attached to its error, if it attached one.
 *
 * Duck-typed rather than shared through a common error class: the client is whatever the
 * host injects — a browser worker, the CLI, a test fake — and requiring them all to throw
 * one library's error type to get a working breaker would be the wrong trade. An error
 * without a numeric status is a note-shaped failure and never trips it.
 */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Statuses that are about this note, not the host.
 *
 * The breaker exists because a deleted preview Worker answered every remaining request
 * with the same status — 404, 502, 503. The browser client attaches that status to every
 * `ApiError`, including the 400/413 a healthy server returns for a body over the cap or a
 * name it will not store. Five of those in a row used to abort the rest of the file, and
 * re-importing could not get past them: they fail again in the same order, the breaker
 * trips again, and everything after is never reached.
 */
function isNoteFailure(status: number): boolean {
  return status === 400 || status === 413 || status === 415 || status === 422;
}

export interface ImportClient {
  createNote: (input: {
    title: string;
    body: string;
    tags: string[];
    notebook?: string;
    createdAt: number;
    updatedAt: number;
    contentHash: string;
    sourceEnex?: string;
    sourceUrl?: string;
  }) => Promise<{ id: string; created: boolean }>;

  uploadFile: (
    noteId: string,
    filename: string,
    mime: string,
    bytes: Uint8Array,
  ) => Promise<{
    filename: string;
    /** `server` when the API is extracting the file's text itself; absent from older servers. */
    indexing?: 'server' | 'client';
  }>;

  /** Rewrites the body once real attachment filenames are known. */
  updateBody?: (noteId: string, body: string) => Promise<void>;

  /** Stores text extracted from an attachment so search can reach it. */
  saveFileText?: (noteId: string, filename: string, text: string) => Promise<void>;

  /**
   * Filenames already stored for a note.
   *
   * Used when a note was created on a prior run that died mid-upload: re-import must skip
   * the note (idempotent) but still fill in the missing files.
   */
  listFiles?: (noteId: string) => Promise<string[]>;
}

export interface ImportOptions {
  /** Applied to every note as the notebook column, not a tag. */
  notebookTag?: string;
  /**
   * Pull the text layer out of PDFs so scanned notes are searchable.
   *
   * Most notes in a real export are a scan with an empty body; without this they arrive
   * as title-only stubs. Costs roughly a second per PDF.
   */
  extractText?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  onFailure?: (failure: ImportFailure) => void;
}

export { contentHash, withSourceLink } from './note-body.js';

export async function importEnex(
  file: { name: string; stream: () => ReadableStream<Uint8Array> },
  client: ImportClient,
  options: ImportOptions = {},
): Promise<ImportProgress> {
  const progress: ImportProgress = {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    filesUploaded: 0,
    filesIndexed: 0,
    bytesRead: 0,
    currentTitle: '',
  };

  const notebookTag = options.notebookTag ?? file.name.replace(/\.enex$/i, '');

  /**
   * Stops the parse, for either reason: the caller cancelled, or the breaker tripped.
   * The two are told apart afterwards by whether `stopped` was set — a cancel returns the
   * progress so far, a trip throws.
   */
  const halt = new AbortController();
  const cancel = () => halt.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });

  /** Failures since the last note that worked, and the status they all shared. */
  let streak: { status: number | undefined; count: number } = { status: undefined, count: 0 };
  let stopped: ImportStoppedError | null = null;

  try {
    await parseEnexStream(file.stream(), {
      signal: halt.signal,

      onProgress: (bytes) => {
        progress.bytesRead = bytes;
      },

      onNote: async (note: EnexNote) => {
        // A cancelled import is not a failed one: skip quietly rather than filling the
        // failure log with thousands of "aborted" entries the user cannot act on.
        if (options.signal?.aborted) return;

        progress.currentTitle = note.title || 'Untitled';

        try {
          await importOne(note, notebookTag, client, progress, file.name, options);
          streak = { status: undefined, count: 0 };
        } catch (err) {
          if (options.signal?.aborted) return;
          progress.failed += 1;
          options.onFailure?.({
            title: note.title || 'Untitled',
            reason: (err as Error).message,
          });

          const status = statusOf(err);
          streak =
            status !== undefined && status === streak.status
              ? { status, count: streak.count + 1 }
              : { status, count: 1 };

          if (
            status !== undefined &&
            !isNoteFailure(status) &&
            streak.count >= FAILURE_STREAK_LIMIT
          ) {
            stopped = new ImportStoppedError(
              status,
              streak.count,
              `Stopped after ${streak.count} consecutive failures with status ${status} — ` +
                `the server stopped responding partway through the file. ` +
                `${progress.created.toLocaleString()} notes were imported before that. ` +
                `Import the same file again to continue; everything that landed is skipped.`,
            );
            halt.abort();
          }
        }

        progress.processed += 1;
        options.onProgress?.({ ...progress });
      },
    });
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }

  if (stopped) throw stopped;
  return progress;
}

async function importOne(
  note: EnexNote,
  notebookTag: string,
  client: ImportClient,
  progress: ImportProgress,
  sourceEnex: string,
  options: ImportOptions,
): Promise<void> {
  const { markdown, usedMd5 } = enmlToMarkdown(note.enml, note.resources);
  const body = withSourceLink(markdown, note.sourceUrl);

  const tags = [...new Set(note.tags.filter((t) => t.trim().length > 0))];
  const created = note.created?.getTime() ?? Date.now();

  const result = await client.createNote({
    title: note.title || 'Untitled',
    body,
    tags,
    notebook: notebookTag || undefined,
    createdAt: created,
    updatedAt: note.updated?.getTime() ?? created,
    contentHash: await contentHash(note.title, body),
    sourceEnex,
    sourceUrl: note.sourceUrl,
  });

  // Already imported: skip the note, but still fill attachments a prior run may have
  // missed. Without this, a worker crash mid-PDF leaves a permanent hole — re-import
  // sees the content hash, returns skipped, and never retries the upload.
  if (!result.created) {
    progress.skipped += 1;
    if (note.resources.length > 0 && client.listFiles) {
      const existing = new Set(await client.listFiles(result.id));
      const missing = note.resources.filter((r) => !existing.has(r.filename));
      if (missing.length > 0) {
        await uploadResources(missing, usedMd5, result.id, client, progress, options);
      }
    }
    return;
  }

  progress.created += 1;
  if (note.resources.length === 0) return;

  /**
   * Upload every resource, including ones no en-media element references.
   *
   * Evernote stores attachments that were added but never embedded in the note body, and
   * dropping them would lose files the user still considers part of the note. Unreferenced
   * ones are appended as links so they remain reachable.
   */
  const { renames, unreferenced } = await uploadResources(
    note.resources,
    usedMd5,
    result.id,
    client,
    progress,
    options,
  );

  if (renames.size === 0 && unreferenced.length === 0) return;

  let finalBody = body;
  for (const [from, to] of renames) {
    finalBody = finalBody.split(`files/${from}`).join(`files/${to}`);
  }
  if (unreferenced.length > 0) {
    const links = unreferenced.map((f) => `- [${f}](files/${f})`).join('\n');
    finalBody = `${finalBody}\n\n## Attachments\n\n${links}\n`.trim();
  }

  await client.updateBody?.(result.id, finalBody);
}

async function uploadResources(
  resources: EnexNote['resources'],
  usedMd5: Set<string>,
  noteId: string,
  client: ImportClient,
  progress: ImportProgress,
  options: ImportOptions,
): Promise<{ renames: Map<string, string>; unreferenced: string[] }> {
  const renames = new Map<string, string>();
  const unreferenced: string[] = [];

  for (const resource of resources) {
    const uploaded = await client.uploadFile(noteId, resource.filename, resource.mime, resource.bytes);
    progress.filesUploaded += 1;

    // The server suffixes collisions, so the stored name may differ from the requested one.
    if (uploaded.filename !== resource.filename) {
      renames.set(resource.filename, uploaded.filename);
    }
    if (!usedMd5.has(resource.md5)) unreferenced.push(uploaded.filename);

    /**
     * Index the text already embedded in the file.
     *
     * Evernote OCR'd scanned attachments and left the layer in place, so this is
     * extraction rather than OCR. Roughly a fifth of real scans yield noise instead of
     * language; those are dropped rather than indexed, so a failed scan does not pollute
     * search with character soup.
     *
     * Skipped when the server said it is extracting the text itself: a second of pdf.js
     * per file and a request per PDF, saved across an import of thousands.
     */
    if (uploaded.indexing === 'server') {
      progress.filesIndexed += 1;
    } else if (options.extractText && client.saveFileText && isExtractable(resource.mime)) {
      const extracted = await extractPdfText(resource.bytes);
      if (extracted.quality.usable) {
        await client.saveFileText(noteId, uploaded.filename, extracted.text);
        progress.filesIndexed += 1;
      }
    }
  }

  return { renames, unreferenced };
}
