import { useSyncExternalStore } from 'react';
import { BlobWriter } from '@zip.js/zip.js';
import { writeArchive, type ExportSource } from '@unbent/enex';
import { exportFilename, type ExportFilter } from '@unbent/shared';
import * as api from './notes-api.js';
import { hostApp, type HostApp } from './app-bridge.js';

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
 * the export at what the tab can hold; the page says so. Inside the Android app, the
 * app is the file system: the zip streams to it a piece at a time and it writes the
 * pieces into the phone's Downloads as they come, so there too size does not matter. The
 * picker has to be asked
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
  /**
   * What the latest export was of, and which run it was: a place that started one can
   * tell its own from another's, and a status that was dismissed stays dismissed for that
   * run only. Null and 0 until the first export starts.
   */
  filter: ExportFilter | null;
  run: number;
  /** Notes written so far, and how many the export holds. Total is null until known. */
  done: number;
  total: number | null;
  /** Files written so far, and files skipped because they were gone, for the summary. */
  files: number;
  skipped: number;
  filename: string | null;
  /**
   * Where the archive went: a file the person chose, the browser's downloads, or the
   * phone's Downloads by way of the Android app.
   */
  destination: DestinationKind | null;
  /** A stop has been asked for and the request in flight has not landed yet. */
  stopping: boolean;
  error: string | null;
}

const initial: ExportState = {
  status: 'idle',
  filter: null,
  run: 0,
  done: 0,
  total: null,
  files: 0,
  skipped: 0,
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

type DestinationKind = 'file' | 'download' | 'app';

/** Where the archive's bytes are written, and how they reach the person afterwards. */
export interface Destination {
  kind: DestinationKind;
  writable: WritableStream<Uint8Array>;
  /** For a download: the assembled blob, once the writable has been closed. */
  finish(): Promise<Blob | null>;
  /** Discards what was written; for a file, nothing is left on disk. */
  abort(): Promise<void>;
}

/** How many notes each page asks for: the endpoint's maximum, so a library is few requests. */
const PAGE = 100;

/**
 * How long to wait before each retry of a request that failed in passing: a dropped
 * connection or a 5xx. A blip clears in a second and a busy Worker in a few; three
 * retries cover both without leaving a person watching a stalled count for long when
 * the failure is one that will not clear today, like a spent database allowance.
 */
const RETRY_DELAYS = [1_000, 4_000, 15_000];

/**
 * A failure worth retrying: the server's 5xx, or a network error — fetch's own TypeError,
 * or the `OfflineError` the API client turns one into. The second is an `ApiError` with
 * status 0, so it has to be named before the status test, or a page request that met a
 * dropped connection would be taken for a refusal and end the whole export.
 */
export function transient(err: unknown): boolean {
  if (api.isOfflineError(err)) return true;
  return err instanceof api.ApiError ? err.status >= 500 : err instanceof TypeError;
}

/**
 * Runs `attempt`, retrying a transient failure after each of `RETRY_DELAYS`. One page or
 * one file failing once used to throw away the whole archive, which on a large library
 * is an hour of work lost to a hiccup. A stop cuts a wait short.
 */
async function retrying<T>(signal: AbortSignal | undefined, attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      const delay = RETRY_DELAYS[i];
      if (delay === undefined || signal?.aborted || !transient(err)) throw err;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      signal?.throwIfAborted();
    }
  }
}

const liveSource: ExportSource = {
  page: (filter, cursor, signal) => retrying(signal, () => api.exportPage(filter, cursor, PAGE)),
  file: (noteId, filename, signal) =>
    retrying(signal, async () => {
      // Unmarked: an export reads every file, and must not fill the offline cache with
      // them (`classify` in `sw/routes.ts`).
      const res = await api.request(`/api/notes/${noteId}/files/${encodeURIComponent(filename)}`, { signal });
      // Gone since the page listed it — its note deleted mid-export, or the object missing
      // from storage. Skipped and counted; see `ExportSource.file`.
      if (res.status === 404) return null;
      if (!res.ok || !res.body) {
        throw new api.ApiError(res.status, `Could not read ${filename}: ${await api.httpErrorMessage(res)}`);
      }
      return res.body;
    }),
  notebooks: async () => (await api.listNotebooks()).notebooks,
  fields: (id) => api.listNotebookFields(id),
};

/**
 * Asks the person where to save, on a browser that can stream to a file; otherwise sets
 * up an in-memory zip to hand over as a download. Null when the person cancelled the
 * picker, which is not an error.
 */
async function pickDestination(filename: string): Promise<Destination | null> {
  const app = hostApp();
  if (app?.saveBegin) return appDestination(app, filename);

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

/**
 * How much of the archive crosses to the app per call. The bridge carries strings, so each
 * piece goes as base64, a third larger; half a megabyte keeps a call short enough not to
 * stall the page and few enough that a gigabyte is two thousand of them, not a million.
 */
const APP_PIECE = 512 * 1024;

/** Bytes as base64, in slices, since spreading a large array into one call overflows the stack. */
function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

/**
 * The archive streamed to the app hosting this page, which writes it into the phone's
 * Downloads.
 *
 * A WebView offers no save picker, and the in-memory path ends by clicking a `blob:` link,
 * which the WebView hands to the app as a download of an address only this page can read:
 * the phone's download manager cannot fetch it, and the export would end with nothing
 * saved and nothing said. So the app takes the bytes directly. Each call is waited for,
 * which is the point — a page writing faster than the phone's storage waits on each piece
 * rather than queueing the library in memory — and a call that answers false is a write
 * that failed, which fails the export like any other error.
 *
 * Android answers each call synchronously and an iOS host with a promise (`HostApp`), and
 * `await` serves both: on a plain value it is a no-op, and on a promise it is what makes
 * `write` below return one, which a `WritableStream` holds the next chunk behind. The zip
 * writer waits on the stream in turn, so a slow native write slows the reads that feed it.
 *
 * `saveAbort` is called directly as well as through the stream: once a write has thrown,
 * the stream is errored and would never pass an abort on, and the app's half-written file
 * has to go either way.
 */
export async function appDestination(app: HostApp, filename: string): Promise<Destination> {
  const id = await app.saveBegin!(filename, 'application/zip');
  if (!id) throw new Error('The app could not create a file in Downloads.');
  let ended = false;
  /*
     The zip writer hands over many small chunks — a header here, a few bytes of a name
     there — and each call to the app has a fixed cost, so they are gathered into full
     pieces first. Copied as they are gathered, since the writer owns the buffers it passes.
     One buffer serves every piece even though `send` waits: the piece is base64 before
     the call is made, and the stream does not hand `write` another chunk until this one
     has returned.
  */
  const pending = new Uint8Array(APP_PIECE);
  let filled = 0;
  const send = async (piece: Uint8Array) => {
    if (!(await app.saveChunk!(id, toBase64(piece)))) {
      throw new Error('The phone could not write the archive to Downloads.');
    }
  };
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      let at = 0;
      while (at < chunk.length) {
        const take = Math.min(APP_PIECE - filled, chunk.length - at);
        pending.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === APP_PIECE) {
          await send(pending);
          filled = 0;
        }
      }
    },
    async close() {
      if (filled > 0) await send(pending.subarray(0, filled));
      if (!(await app.saveEnd!(id))) throw new Error('The phone could not finish writing the archive.');
      ended = true;
    },
  });
  return {
    kind: 'app',
    writable,
    finish: async () => null,
    abort: async () => {
      if (ended) return;
      app.saveAbort?.(id);
      await writable.abort().catch(() => undefined);
    },
  };
}

/**
 * What a finished export says it did, in the words of where it went: a chosen file and the
 * phone's Downloads were written as they went, a browser download was handed over at the
 * end.
 */
export function savedAs(state: Pick<ExportState, 'destination' | 'filename'>): string {
  if (state.destination === 'app') return `Saved ${state.filename} to Downloads`;
  return `${state.destination === 'file' ? 'Saved' : 'Downloaded'} ${state.filename}`;
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
      filter,
      run: state.run + 1,
      done: 0,
      total: null,
      files: 0,
      skipped: 0,
      filename,
      destination: destination.kind,
      stopping: false,
      error: null,
    });
    // An export lives in this tab, so closing or reloading it throws the run away, and a
    // large one is an hour's work. The browser's own "Leave site?" is the whole warning:
    // what it says cannot be chosen, only whether it is asked. Through `globalThis`, and
    // optional, because the store's tests run it under Node, which has no window.
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    globalThis.addEventListener?.('beforeunload', guard);
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
      globalThis.removeEventListener?.('beforeunload', guard);
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

/**
 * Whether `state` is an export of `filter`. Compared as the query the pages are fetched
 * with, which is already the export's normal form: no empty lists, no sort that means
 * nothing without a date range.
 */
export function isExportOf(state: ExportState, filter: ExportFilter): boolean {
  if (!state.filter) return false;
  return api.exportQuery(state.filter).toString() === api.exportQuery(filter).toString();
}

export function useExporting(): ExportState {
  return useSyncExternalStore(exporting.subscribe, exporting.get);
}

/** Whether an export is running, outside React — for the reload a deploy asks for. */
export const isExportRunning = () => exporting.get().status === 'running';

/**
 * Only whether an export is running, for a control that has to wait for one. The state
 * changes once per note, so a component reading all of it re-renders thousands of times
 * over an archive export; this one re-renders when the answer changes — twice.
 */
export function useExportRunning(): boolean {
  return useSyncExternalStore(exporting.subscribe, () => exporting.get().status === 'running');
}
