import { useSyncExternalStore } from 'react';
import { BlobWriter } from '@zip.js/zip.js';
import { writeArchive, type ExportSource } from '@unbent/enex';
import { exportFilename, type ExportFilter } from '@unbent/shared';
import * as api from './notes-api.js';

/**
 * The library export, built here in the browser.
 *
 * It was one request that streamed the zip from the Worker, reading each note and each
 * of its files as the browser pulled the bytes. A Worker request may make only so many
 * calls to D1 and R2 — a thousand on Workers Free by the platform's limits page — and a
 * library is tens of thousands of them, so the backup could never have finished on the
 * archive it existed for. Now the browser asks for a page of notes at a time, fetches
 * each file through the note's own file route (each its own request), and writes the zip
 * itself with the names and markdown from `@unbent/shared` (`writeArchive`, in the same
 * package as the importer): the same archive the Worker used to write.
 *
 * Where the bytes go decides whether a large library can be exported at all. Chrome and
 * Edge offer `showSaveFilePicker`, which hands over a stream to a file the person chose,
 * so the archive goes to disk as it is built and its size does not matter. Elsewhere the
 * zip is assembled in memory and handed over as a download when it is done, which caps
 * the export at what the tab can hold; the page says so. The picker has to be asked
 * inside the click that started the export — it is a user gesture — so `start` opens it
 * before it awaits anything.
 *
 * A module-level store rather than component state, the way indexing is (`index-files.ts`):
 * a run outlives the page it was started from, and the button on the note list, the one
 * beside a notebook and the export page all need to see that one is running.
 */

export type ExportStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error';

export interface ExportState {
  status: ExportStatus;
  /** Notes written so far, and how many the export holds. Total is null until known. */
  done: number;
  total: number | null;
  /** Files written so far, for the summary. */
  files: number;
  filename: string | null;
  /** Where the archive went: a file the person chose, or the browser's downloads. */
  destination: 'file' | 'download' | null;
  /** A stop has been asked for and the request in flight has not landed yet. */
  stopping: boolean;
  error: string | null;
}

const initial: ExportState = {
  status: 'idle',
  done: 0,
  total: null,
  files: 0,
  filename: null,
  destination: null,
  stopping: false,
  error: null,
};

/**
 * The File System Access API, which TypeScript's DOM library does not declare. Only the
 * shape used here; everything else about the handle is left alone.
 */
interface SaveFilePicker {
  (options: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }): Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
}

/** Where the archive's bytes are written, and how they reach the person afterwards. */
interface Destination {
  kind: 'file' | 'download';
  writable: WritableStream<Uint8Array>;
  /** For a download: the assembled blob, once the writable has been closed. */
  finish(): Promise<Blob | null>;
  /** Discards what was written; for a file, nothing is left on disk. */
  abort(): Promise<void>;
}

/** How many notes each page asks for: the endpoint's maximum, so a library is few requests. */
const PAGE = 100;

const liveSource: ExportSource = {
  page: (filter, cursor) => api.exportPage(filter, cursor, PAGE),
  file: async (noteId, filename, signal) => {
    const res = await fetch(`/api/notes/${noteId}/files/${encodeURIComponent(filename)}`, { signal });
    if (!res.ok || !res.body) throw new Error(`Could not read ${filename}: ${res.status}`);
    return res.body;
  },
  notebooks: async () => (await api.listNotebooks()).notebooks,
  fields: (id) => api.listNotebookFields(id),
};

/**
 * Asks the person where to save, on a browser that can stream to a file; otherwise sets
 * up an in-memory zip to hand over as a download. Null when the person cancelled the
 * picker, which is not an error.
 */
async function pickDestination(filename: string): Promise<Destination | null> {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker) {
    let handle: Awaited<ReturnType<SaveFilePicker>>;
    try {
      handle = await picker({
        suggestedName: filename,
        types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      throw err;
    }
    const writable = await handle.createWritable();
    return {
      kind: 'file',
      writable,
      finish: async () => null,
      abort: () => writable.abort().catch(() => undefined),
    };
  }

  const blobWriter = new BlobWriter('application/zip');
  return {
    kind: 'download',
    writable: blobWriter.writable,
    finish: () => blobWriter.getData(),
    abort: () => blobWriter.writable.abort().catch(() => undefined),
  };
}

/** Hands an in-memory archive to the browser's downloads, named as the file would be. */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked after the click has been handled, not before: a synchronous revoke races it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface Exporting {
  /**
   * Starts an export of `filter`, asking where to save first where the browser allows.
   * Must be called from the click that asked for it. Nothing happens while one runs.
   */
  start(filter: ExportFilter): void;
  /** Ends the running export between requests; what was written is discarded. */
  stop(): void;
  subscribe(listener: (state: ExportState) => void): () => void;
  get(): ExportState;
}

export function createExporting(source: ExportSource = liveSource, pick = pickDestination): Exporting {
  let state = initial;
  const listeners = new Set<(state: ExportState) => void>();
  let controller: AbortController | null = null;

  const set = (patch: Partial<ExportState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  };

  async function run(filter: ExportFilter, filename: string): Promise<void> {
    // The picker first, before any request: it needs the click's gesture, and a person
    // who cancels it has not started anything.
    let destination: Destination | null;
    try {
      destination = await pick(filename);
    } catch (err) {
      set({ status: 'error', error: (err as Error).message });
      return;
    }
    if (!destination) return;

    controller = new AbortController();
    set({
      status: 'running',
      done: 0,
      total: null,
      files: 0,
      filename,
      destination: destination.kind,
      stopping: false,
      error: null,
    });
    try {
      const progress = await writeArchive(destination.writable, filter, source, controller.signal, (p) =>
        set(p),
      );
      const blob = await destination.finish();
      if (blob) download(blob, filename);
      set({ ...progress, status: 'done', stopping: false });
    } catch (err) {
      await destination.abort();
      if (controller.signal.aborted) set({ status: 'stopped', stopping: false });
      else set({ status: 'error', stopping: false, error: (err as Error).message });
    } finally {
      controller = null;
    }
  }

  return {
    start(filter) {
      if (state.status === 'running') return;
      const stamp = new Date().toISOString().slice(0, 10);
      void run(filter, exportFilename(filter, stamp));
    },
    stop() {
      if (!controller || state.status !== 'running') return;
      set({ stopping: true });
      controller.abort();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
  };
}

const exporting = createExporting();

export const startExport = (filter: ExportFilter) => exporting.start(filter);
export const stopExport = () => exporting.stop();

export function useExporting(): ExportState {
  return useSyncExternalStore(exporting.subscribe, exporting.get);
}
