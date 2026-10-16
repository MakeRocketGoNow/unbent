/// <reference lib="webworker" />
import {
  describeNotion,
  detectArchiveKind,
  importArchive,
  importEnex,
  importFormat,
  importNotion,
  type ImportClient,
  type ImportFailure,
  type ImportOptions,
  type ImportProgress,
  type ImportSkip,
  type NotionUnit,
} from '@unbent/enex';
import {
  apiFetch as api,
  indexFileBytes,
  indexPendingFiles,
  type IndexProgress,
} from './attachment-text.js';

/**
 * Runs an import off the main thread.
 *
 * Parsing 3.6GB takes ~70s of solid CPU; on the main thread that is 70 seconds of frozen
 * UI with no progress and no way to cancel. The worker also owns the fetch calls, so
 * uploads do not compete with rendering.
 *
 * Three formats arrive here (Evernote's ENEX, this app's own export, and Notion's), and
 * they share everything past the reader: the same client below, the same progress, the
 * same events. A zip is one of the last two, and only its entries say which, so a picked
 * zip is described first: the panel learns whether it is Notion's and, if so, what it
 * holds, before Start is pressed.
 *
 * Cookies travel with `credentials: 'include'`: a worker shares the document's cookie
 * jar but does not send them by default.
 */

/** What the panel chose from a described Notion export. */
export interface NotionChoices {
  include: string[];
  pagesNotebook: string;
  tagsAsTags: boolean;
}

export type ImportRequest =
  | { type: 'start'; file: File; extractText: boolean; notion?: NotionChoices }
  /** Says what a picked zip is, and for a Notion export what it holds. */
  | { type: 'describe'; file: File }
  /** Index every pending PDF. `auto` marks a pass nobody asked for, which stops short of a backlog. */
  | { type: 'backfill'; auto?: boolean }
  /** Index one file from its bytes, just uploaded under `filename`. */
  | { type: 'index-file'; noteId: string; filename: string; file: File }
  | { type: 'abort' };

export type ImportEvent =
  | { type: 'described'; kind: 'unbent' }
  | { type: 'described'; kind: 'notion'; units: NotionUnit[] }
  /** The zip could not be read; the panel says so beside the file rather than as a failed run. */
  | { type: 'described'; kind: 'unreadable'; message: string }
  | { type: 'backfill-progress'; progress: IndexProgress }
  | { type: 'backfill-done'; progress: IndexProgress }
  /** The pass declined to start: this many files are pending. See `AUTO_INDEX_LIMIT`. */
  | { type: 'backfill-deferred'; remaining: number }
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'failure'; failure: ImportFailure }
  | { type: 'skip'; skip: ImportSkip }
  | { type: 'done'; progress: ImportProgress }
  | { type: 'error'; message: string };

const post = (event: ImportEvent) => self.postMessage(event);

let controller: AbortController | null = null;

/**
 * Requests run one at a time, in the order they arrived.
 *
 * The worker is kept for the page's lifetime and takes more than one kind of job, so two
 * can be posted while one is running. Each waits its turn rather than starting at once:
 * pdf.js in this worker is one instance, and two extractions interleaved through it have
 * been seen to hang. `abort` is the exception: it must reach the run in progress.
 */
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<ImportRequest>) => {
  const request = event.data;
  if (request.type === 'abort') {
    controller?.abort();
    return;
  }
  queue = queue.then(() => handle(request));
};

/** The API, as both importers see it. */
const client: ImportClient = {
  createNote: async (input) => {
    const res = await api('/api/import/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return res.json() as Promise<{ id: string; created: boolean }>;
  },

  uploadFile: async (noteId, filename, mime, bytes, options) => {
    // `text=supplied` stops the server reading a file whose text comes next from the archive.
    const query = options?.textSupplied ? '?text=supplied' : '';
    const res = await api(`/api/notes/${noteId}/files${query}`, {
      method: 'PUT',
      headers: {
        'X-Filename': encodeURIComponent(filename),
        'Content-Type': mime,
      },
      // Bytes, not base64: sending the encoded form would add 33% to a multi-GB
      // upload for no benefit.
      body: bytes as unknown as BodyInit,
    });
    return res.json() as Promise<{ filename: string; indexing?: 'server' | 'client' }>;
  },

  importNotebook: async (definition) => {
    const res = await api('/api/import/notebook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(definition),
    });
    return res.json() as Promise<{ id: string; skipped: Array<{ name: string; reason: string }> }>;
  },

  listFiles: async (noteId) => {
    const res = await api(`/api/notes/${noteId}/files`, { method: 'GET' });
    const { files } = (await res.json()) as { files: Array<{ filename: string }> };
    return files.map((f) => f.filename);
  },

  updateBody: async (noteId, body) => {
    await api(`/api/notes/${noteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  },

  saveFileText: async (noteId, filename, text, readBy) => {
    await api(`/api/notes/${noteId}/files/${encodeURIComponent(filename)}/text`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readBy ? { text, readBy } : { text }),
    });
  },
};

async function handle(request: Exclude<ImportRequest, { type: 'abort' }>): Promise<void> {
  if (request.type === 'backfill') {
    await runBackfill(request.auto ?? false);
    return;
  }

  if (request.type === 'index-file') {
    try {
      await indexFileBytes(request.noteId, request.filename, new Uint8Array(await request.file.arrayBuffer()));
    } catch {
      // Nothing to report to anyone: the file is saved, its row stays pending, and the
      // next pass on open picks it up.
    }
    return;
  }

  if (request.type === 'describe') {
    try {
      const source = { name: request.file.name, blob: request.file };
      if ((await detectArchiveKind(request.file)) === 'notion') {
        post({ type: 'described', kind: 'notion', units: (await describeNotion(source)).units });
      } else {
        post({ type: 'described', kind: 'unbent' });
      }
    } catch (err) {
      post({ type: 'described', kind: 'unreadable', message: `Could not read the zip: ${(err as Error).message}` });
    }
    return;
  }

  const { file, extractText } = request;
  const format = importFormat(file.name);
  if (format === null) {
    // The picker already refuses these; this is the message for a caller that did not ask.
    post({ type: 'error', message: 'Choose an .enex, .zip or .md file.' });
    return;
  }

  controller = new AbortController();
  const options: ImportOptions = {
    extractText,
    signal: controller.signal,
    onProgress: (progress) => post({ type: 'progress', progress }),
    onFailure: (failure) => post({ type: 'failure', failure }),
    onSkip: (skip) => post({ type: 'skip', skip }),
  };

  try {
    let progress: ImportProgress;
    if (format === 'enex') {
      progress = await importEnex({ name: file.name, stream: () => file.stream() }, client, options);
    } else if (format === 'zip' && (await detectArchiveKind(file)) === 'notion') {
      // The panel's choices, or everything when it made none.
      progress = await importNotion({ name: file.name, blob: file }, client, {
        ...options,
        ...(request.notion
          ? {
              include: request.notion.include,
              pagesNotebook: request.notion.pagesNotebook,
              tagsAsTags: request.notion.tagsAsTags,
            }
          : {}),
      });
    } else {
      // A File is a Blob: zip.js reads it by byte range, so nothing is copied here.
      progress = await importArchive({ name: file.name, blob: file }, client, options);
    }

    post({ type: 'done', progress });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  } finally {
    controller = null;
  }
}

/** The pending pass, reported as events. The loop itself lives in attachment-text.ts. */
async function runBackfill(auto: boolean): Promise<void> {
  controller = new AbortController();
  try {
    const result = await indexPendingFiles({
      auto,
      signal: controller.signal,
      onProgress: (progress) => post({ type: 'backfill-progress', progress }),
    });
    if (result.deferred !== undefined) {
      post({ type: 'backfill-deferred', remaining: result.deferred });
    } else {
      post({ type: 'backfill-done', progress: result });
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  } finally {
    controller = null;
  }
}
