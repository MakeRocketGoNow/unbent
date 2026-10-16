import type { ReadBy } from '@unbent/shared';
import type { FieldValue, NotebookDefinition } from '@unbent/shared';
import { isExtractable } from './ocr-text.js';
import { extractPdfText } from './pdf-text.js';

/**
 * What every import shares, whatever file it reads.
 *
 * Two formats arrive here: Evernote's ENEX and Unbent's own export archive. They differ
 * in how a note and its files are found, and in nothing after that: the same request
 * per note, the same upload per file, the same idea of a failure worth stopping for. This
 * module is that second half, so the two drivers cannot drift apart on how a run is
 * accounted for or when it gives up.
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
  /**
   * How many notes the run will process in total, when that is known before it starts.
   *
   * Zero means unknown, which is the ENEX case: the parser streams the file and cannot say
   * how many notes are in it without reading it first, so its progress is measured in bytes
   * off the stream instead. An archive is the opposite (`getEntries` has already listed
   * every note directory before the first note is touched), so it fills this in, and the
   * bar counts notes rather than bytes.
   *
   * Bytes are a poor proxy for how far along an archive is: a real export is mostly its
   * attachments, so a handful of notes with images can be nearly all of the file while the
   * dozens of text notes after them are almost none of it. A byte bar raced to full on the
   * first image and then crawled across everything else. Notes are what the person is
   * watching mount up, and what the count beside the bar already shows.
   */
  notesTotal: number;
  currentTitle: string;
}

export interface ImportFailure {
  title: string;
  reason: string;
}

/**
 * A note the server said it already had.
 *
 * Reported one by one because a bare count could not be explained. Re-importing a
 * notebook after deleting it said "10 already present" into a notebook that held nothing,
 * and there was no way to find out what those ten were: they were copies inside the file
 * itself, matched against notes the same run had just created.
 */
export interface ImportSkip {
  title: string;
  /** The note it was matched to, which is where anyone wondering why should look. */
  noteId: string;
  /**
   * The match is a note this run created from earlier in the same file, rather than one
   * that was here before the run started. The first is a note the file holds twice; the
   * second is a resumed or repeated import doing its job.
   */
  earlierInFile: boolean;
}

/**
 * Consecutive failures carrying the same HTTP status that end a run.
 *
 * Low on purpose. The failures this catches are not a property of the notes (they are the
 * server having gone away), so every attempt after the first few is a request nobody
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
 * host injects (a browser worker, the CLI, a test fake) and requiring them all to throw
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
 * with the same status: 404, 502, 503. The browser client attaches that status to every
 * `ApiError`, including the 400/413 a healthy server returns for a body over the cap or a
 * name it will not store. Five of those in a row used to abort the rest of the file, and
 * re-importing could not get past them: they fail again in the same order, the breaker
 * trips again, and everything after is never reached.
 */
function isNoteFailure(status: number): boolean {
  return status === 400 || status === 413 || status === 415 || status === 422;
}

/**
 * Statuses worth trying the same note again for, rather than counting straight away.
 *
 * A 503/502/504 is the edge answering because the Worker was momentarily unavailable: an
 * overloaded or briefly-evicted isolate, not a note the server refuses and not a host that
 * is gone for good. Under a bulk import these come in bursts and then clear, so the same
 * note usually lands on a second try a moment later. Retrying it in place is what keeps one
 * blip from aborting the run and spending a fresh import's worth of requests re-treading
 * everything that already landed. A host that really has gone away fails every retry too,
 * so the breaker still trips, just after each note has tried a few times first.
 *
 * 404 is deliberately not here: the deleted-preview-Worker case answers 404, and a gone
 * Worker will not come back within a note's worth of backoff, so retrying it only delays
 * the breaker the run wants.
 */
function isTransientHostFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** How many extra tries a transient host failure gets before it counts. */
export const TRANSIENT_RETRY_LIMIT = 3;

/** Backoff before the Nth retry (1-based): 250ms, 500ms, 1s. Capped, so a long run cannot stall. */
function retryDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 2000);
}

export interface ImportClient {
  createNote: (input: {
    /**
     * The id the note had where it came from. Only an Unbent export carries one; the
     * server keeps it when it can, so a restored note lands back at its old address.
     */
    id?: string;
    title: string;
    body: string;
    tags: string[];
    notebook?: string;
    createdAt: number;
    updatedAt: number;
    contentHash: string;
    sourceEnex?: string;
    sourceUrl?: string;
    /** Custom field values by field name, as the export writes them; a multi-select's is a list. */
    fields?: Record<string, FieldValue>;
  }) => Promise<{ id: string; created: boolean }>;

  /**
   * `textSupplied` tells the server this file's text will follow through `saveFileText`,
   * so it should not read the file itself; see `uploadFiles`.
   */
  uploadFile: (
    noteId: string,
    filename: string,
    mime: string,
    bytes: Uint8Array,
    options?: { textSupplied?: boolean },
  ) => Promise<{
    filename: string;
    /** `server` when the API is extracting the file's text itself; absent from older servers. */
    indexing?: 'server' | 'client';
  }>;

  /** Rewrites the body once real attachment filenames are known. */
  updateBody?: (noteId: string, body: string) => Promise<void>;

  /**
   * Stores text extracted from an attachment so search can reach it. `readBy: 'vision'`
   * when the text is what the vision model read, restored from an archive's `described/`;
   * `'assistant'` when an assistant wrote it over MCP, restored from `written/`.
   */
  saveFileText?: (
    noteId: string,
    filename: string,
    text: string,
    readBy?: ReadBy,
  ) => Promise<void>;

  /**
   * Applies a notebook's definitions from the archive's `notebooks/<slug>.yaml`, before
   * any of its notes. Optional because an older server has no endpoint for it; the
   * archive still imports, with field types inferred from values as before.
   *
   * `skipped` names what the definition could not apply: a field by its name, or, with a
   * `kind`, the notebook's own emoji or purpose, by the value the archive held.
   */
  importNotebook?: (definition: NotebookDefinition) => Promise<{
    id: string;
    skipped: Array<{ name: string; reason: string; kind?: 'emoji' | 'purpose' }>;
  }>;

  /**
   * Filenames already stored for a note.
   *
   * Used when a note was created on a prior run that died mid-upload: re-import must skip
   * the note (idempotent) but still fill in the missing files.
   */
  listFiles?: (noteId: string) => Promise<string[]>;
}

export interface ImportOptions {
  /**
   * Applied to every note as the notebook column, not a tag.
   *
   * For an ENEX file this replaces the filename; for an Unbent export it replaces the
   * notebook each note names for itself.
   */
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
  onSkip?: (skip: ImportSkip) => void;
  /**
   * How the run waits between retries of a transient host failure. Real time by default;
   * a test injects a resolved promise so a retry path does not sleep for seconds.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One run's accounting: progress, per-note failures and skips, and the breaker.
 *
 * A driver wraps each note in `attempt` and calls `finish` when its file is exhausted.
 * `halt` is what the driver's reader should stop on: it fires for either reason a run
 * ends early, the caller cancelling or the breaker tripping, and `finish` tells the two
 * apart: a cancel returns the progress so far, a trip throws.
 */
export class ImportRun {
  readonly progress: ImportProgress = {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    filesUploaded: 0,
    filesIndexed: 0,
    bytesRead: 0,
    notesTotal: 0,
    currentTitle: '',
  };

  readonly halt = new AbortController();

  /** Failures since the last note that worked, and the status they all shared. */
  private streak: { status: number | undefined; count: number } = {
    status: undefined,
    count: 0,
  };

  private stopped: ImportStoppedError | null = null;

  /**
   * Every note this run created, so a skip can say whether it matched one of them.
   *
   * Ids only: the largest real export is about 13,000 notes, which is around a megabyte
   * of strings held for the length of a run.
   */
  private readonly createdIds = new Set<string>();

  private readonly cancel = () => this.halt.abort();

  constructor(private readonly options: ImportOptions) {
    options.signal?.addEventListener('abort', this.cancel, { once: true });
  }

  /**
   * Runs one note's work, retrying a transient host failure a few times before letting it
   * through to the caller's failure handling.
   *
   * The retry is per note and in place: a 503 from an overloaded Worker usually clears in a
   * moment, so trying the same note again is what keeps a burst from counting as failures
   * and aborting the run. A note-shaped failure (a rejected body, a bad name) and a host
   * that has truly gone (404) are not retried (the first is not the host's fault and the
   * second will not recover within a note's backoff), so both reach the breaker as before.
   * Whatever the last try threw is rethrown, so the streak still sees the real status.
   */
  private async runWithRetries(work: () => Promise<void>): Promise<void> {
    const sleep = this.options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let retries = 0; ; retries += 1) {
      try {
        await work();
        return;
      } catch (err) {
        const status = statusOf(err);
        if (
          status === undefined ||
          !isTransientHostFailure(status) ||
          retries >= TRANSIENT_RETRY_LIMIT ||
          this.options.signal?.aborted
        ) {
          throw err;
        }
        await sleep(retryDelayMs(retries + 1));
        if (this.options.signal?.aborted) throw err;
      }
    }
  }

  /**
   * Imports one note, recording the outcome either way.
   *
   * `title` is what the driver knows before the work starts. A driver that only learns
   * the real title partway through (an archive names a note inside the file it has yet
   * to read) may overwrite `progress.currentTitle` from inside `work`, and a failure is
   * reported under whichever name is current when it happens.
   */
  async attempt(title: string, work: () => Promise<void>): Promise<void> {
    const { options, progress } = this;

    // A cancelled import is not a failed one: skip quietly rather than filling the
    // failure log with thousands of "aborted" entries the user cannot act on.
    if (options.signal?.aborted) return;

    progress.currentTitle = title;

    try {
      await this.runWithRetries(work);
      this.streak = { status: undefined, count: 0 };
    } catch (err) {
      if (options.signal?.aborted) return;
      progress.failed += 1;
      options.onFailure?.({ title: progress.currentTitle, reason: (err as Error).message });

      const status = statusOf(err);
      this.streak =
        status !== undefined && status === this.streak.status
          ? { status, count: this.streak.count + 1 }
          : { status, count: 1 };

      if (status === 401) {
        // Not a streak: one is enough. The run's credentials are gone, and every request
        // after this one carries whatever session the browser holds next, which, once
        // somebody else signs in on the same device, is theirs. Waiting for five would
        // leave that window open for as long as the next note takes to parse.
        this.stopped = new ImportStoppedError(
          status,
          this.streak.count,
          `Stopped because you were signed out. ` +
            `${progress.created.toLocaleString()} notes were imported before that. ` +
            `Sign in and import the same file again to continue; everything that landed is skipped.`,
        );
        this.halt.abort();
      } else if (
        status !== undefined &&
        !isNoteFailure(status) &&
        this.streak.count >= FAILURE_STREAK_LIMIT
      ) {
        this.stopped = new ImportStoppedError(
          status,
          this.streak.count,
          `Stopped after ${this.streak.count} consecutive failures with status ${status}: ` +
            `the server stopped responding partway through the file. ` +
            `${progress.created.toLocaleString()} notes were imported before that. ` +
            `Import the same file again to continue; everything that landed is skipped.`,
        );
        this.halt.abort();
      }
    }

    progress.processed += 1;
    options.onProgress?.({ ...progress });
  }

  /**
   * Records something that went wrong that was not a note: a notebook's definitions the
   * server would not take, or one field of them it could not apply. Counted with the
   * failures and reported through the same log, since that is the list a person reads
   * to find out what did not land, but outside `attempt`, so it never counts toward the
   * notes processed and the bar still measures notes.
   */
  problem(title: string, reason: string): void {
    this.progress.failed += 1;
    this.options.onFailure?.({ title, reason });
  }

  /** Counts a note the server created. Drivers call this rather than bumping the count. */
  created(noteId: string): void {
    this.progress.created += 1;
    this.createdIds.add(noteId);
  }

  /**
   * Counts a note the server already had, and reports which note it matched.
   *
   * Named by `progress.currentTitle`, the same as a failure, so an archive's note is
   * reported under its real title rather than its path.
   */
  skipped(noteId: string): void {
    this.progress.skipped += 1;
    this.options.onSkip?.({
      title: this.progress.currentTitle,
      noteId,
      earlierInFile: this.createdIds.has(noteId),
    });
  }

  /**
   * Lets go of the caller's signal. Called by `finish`, and by a driver whose reader
   * threw before it got there, so a long-lived signal does not keep a dead run alive.
   */
  release(): void {
    this.options.signal?.removeEventListener('abort', this.cancel);
  }

  /** The result of a run whose file has been read to the end, or as far as it got. */
  finish(): ImportProgress {
    this.release();
    if (this.stopped) throw this.stopped;
    return this.progress;
  }
}

/** A file to store beside a note. */
export interface ImportFile {
  filename: string;
  mime: string;
  bytes: Uint8Array;
  /**
   * The text an Unbent archive carried beside the file, and who read it. Only that
   * importer sets it; see `textSidecarPath` in `@unbent/shared`.
   */
  text?: { text: string; readBy: ReadBy | null };
}

/**
 * Uploads a note's files, in order, and says which ones the server renamed.
 *
 * The server suffixes a name that is already taken on the note, so the stored name can
 * differ from the requested one; the map is `requested → stored` for every file that
 * happened to, so the caller can repoint the body's links.
 *
 * Takes an async iterable as readily as an array so a driver that can read its files
 * lazily (an archive, where each is a byte range) holds one attachment in memory at a
 * time rather than a note's worth.
 */
export async function uploadFiles(
  files: Iterable<ImportFile> | AsyncIterable<ImportFile>,
  noteId: string,
  client: ImportClient,
  progress: ImportProgress,
  options: ImportOptions,
): Promise<Map<string, string>> {
  const renames = new Map<string, string>();

  for await (const file of files) {
    /*
       A file that arrived with its text is not read again, by anyone. The server is told
       before the bytes land, because it starts reading the moment they do (a PDF through
       extraction, a picture through the vision model, a paid request per file) and a read
       that finished after the archive's text was saved would replace it with other words.
       The text then goes in as it was, under the reader that wrote it. If saving it fails
       the file is simply left unread, where the passes over pending files find it.
    */
    const supplied = file.text && client.saveFileText ? file.text : undefined;
    const uploaded = supplied
      ? await client.uploadFile(noteId, file.filename, file.mime, file.bytes, { textSupplied: true })
      : await client.uploadFile(noteId, file.filename, file.mime, file.bytes);
    progress.filesUploaded += 1;

    if (uploaded.filename !== file.filename) {
      renames.set(file.filename, uploaded.filename);
    }

    if (supplied) {
      await client.saveFileText!(noteId, uploaded.filename, supplied.text, supplied.readBy ?? undefined);
      progress.filesIndexed += 1;
      continue;
    }

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
    } else if (options.extractText && client.saveFileText && isExtractable(file.mime)) {
      const extracted = await extractPdfText(file.bytes);
      if (extracted.quality.usable) {
        await client.saveFileText(noteId, uploaded.filename, extracted.text);
        progress.filesIndexed += 1;
      }
    }
  }

  return renames;
}

/** The name a body's link uses for a file, after any rename the server made. */
export function storedName(renames: Map<string, string>, requested: string): string {
  return renames.get(requested) ?? requested;
}

/**
 * Repoints every `files/<from>` link in a body at the names the server actually stored.
 *
 * Exact paths, not substrings. Replacing `files/IMG_1.jpg` with a split/join also rewrote
 * `files/IMG_10.jpg` (camera-roll notes are full of those neighbours) so a collision
 * suffix on the shorter file silently retargeted the longer one's link, and sometimes
 * produced a name that is not a file at all (`files/IMG_1-2.jpg0.jpg`). Longest first is
 * not enough on its own: the longer neighbour is often *not* in the rename map.
 *
 * The boundary is the characters that end a destination in the markdown this importer
 * writes (`](files/…)`, `<files/…>`). A space is not one of them, because a real export
 * has names like `Menu Card.pdf` and `files/Menu` must not eat `files/Menu Card.pdf`.
 */
export function applyRenames(body: string, renames: Map<string, string>): string {
  if (renames.size === 0) return body;
  let out = body;
  // Longest first so a name that is a prefix of another is not rewritten out from under
  // it; entries rather than keys so the value does not need a second lookup.
  const entries = [...renames.entries()].sort(([a], [b]) => b.length - a.length);
  for (const [from, to] of entries) {
    const escaped = `files/${from}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}(?=$|[)\\n\\r>\\]])`, 'g'), `files/${to}`);
  }
  return out;
}
