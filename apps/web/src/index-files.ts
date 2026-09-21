import { useSyncExternalStore } from 'react';
import { isExtractable } from '@unbent/enex';
import type { IndexProgress } from './attachment-text.js';
import * as api from './notes-api.js';
import type { ReadPass, UploadedFile } from './notes-api.js';
import type { ImportEvent, ImportRequest } from './import-worker.js';

/**
 * The one place PDF indexing is started from, and the one place its state lives.
 *
 * Indexing used to be a private affair of the Import panel: it made a worker, listened to
 * it, and terminated it on unmount — so leaving Settings killed a run in progress. Now the
 * app starts a pass on open, the editor hands over a file it has just uploaded, and the
 * panel's button is one caller among several. A run has to outlive any one screen, and
 * every screen has to be able to see it, so the state is a module-level store that React
 * reads through `useSyncExternalStore` — which is what that hook is for.
 *
 * Built by a factory so a test can hand in a fake worker; the instance at the bottom spawns
 * the real one.
 */

export type IndexingStatus = 'idle' | 'running' | 'done' | 'deferred' | 'error';

export interface IndexingState {
  status: IndexingStatus;
  /**
   * Which half a running pass is in. The PDFs first, in the browser, where pdf.js is;
   * then, when asked, the images on the server, where the vision model is.
   */
  phase: 'pdfs' | 'images';
  /** Null until a pass has started. */
  progress: IndexProgress | null;
  /** The server's pass over images: read so far, and left. Null until one has started. */
  images: { read: number; remaining: number } | null;
  /** How many files a deferred pass left alone; see `AUTO_INDEX_LIMIT`. */
  remaining: number;
  error: string | null;
}

export interface Indexing {
  /**
   * Starts a pass over everything pending. `auto` marks an unasked one, which runs once.
   * `images` asks for the server's pass over images once the PDFs are done; never on an
   * unasked pass, since every image read is a paid request nobody chose to make.
   */
  start(opts: { auto: boolean; images?: boolean }): void;
  abort(): void;
  /**
   * Indexes one file whose bytes are in hand, right after its upload. Nothing happens
   * for a file with no text to extract.
   */
  indexFile(noteId: string, filename: string, file: File): void;
  subscribe(listener: (state: IndexingState) => void): () => void;
  get(): IndexingState;
}

const initial: IndexingState = {
  status: 'idle',
  phase: 'pdfs',
  progress: null,
  images: null,
  remaining: 0,
  error: null,
};

/** Files per call of the server's pass; each is seconds, and a request the person can stop. */
const IMAGES_PER_CALL = 3;

export function createIndexing(
  spawn: () => Worker,
  readImages: (limit: number) => Promise<ReadPass> = api.readPendingFiles,
): Indexing {
  let state = initial;
  const listeners = new Set<(state: IndexingState) => void>();
  let worker: Worker | null = null;
  let autoStarted = false;
  /** Whether the pass now running should go on to the images once the PDFs are done. */
  let wantImages = false;
  let stopImages = false;

  function set(patch: Partial<IndexingState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  /**
   * One worker, made on first use and kept.
   *
   * Kept rather than made per run because the editor posts it single files as they are
   * uploaded, and a worker per file would load pdf.js — about a megabyte — every time.
   */
  function ensureWorker(): Worker {
    if (worker) return worker;
    const w = spawn();
    w.onmessage = (event: MessageEvent<ImportEvent>) => {
      const data = event.data;
      if (data.type === 'backfill-progress') set({ progress: data.progress });
      else if (data.type === 'backfill-done') {
        if (wantImages) void runImages(data.progress);
        else set({ status: 'done', progress: data.progress });
      }
      else if (data.type === 'backfill-deferred') set({ status: 'deferred', remaining: data.remaining });
      else if (data.type === 'error') set({ status: 'error', error: data.message });
    };
    w.onerror = (event) => {
      // Module workers often die with an empty message — the nested pdf.js worker's
      // teardown is one way. Say something actionable, and drop the worker so the next
      // start gets a fresh one instead of posting into a corpse.
      set({ status: 'error', error: event.message || 'Indexing stopped unexpectedly — try again.' });
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  }

  /**
   * The second half: the server reads a few images per call until none are left.
   *
   * Stops early when a call moves nothing — every file left is one the server could not
   * read this time, and asking again would only pay to fail again. Those stay pending
   * for the next press.
   */
  async function runImages(progress: IndexProgress): Promise<void> {
    set({ status: 'running', phase: 'images', progress, images: { read: 0, remaining: 0 } });
    let read = 0;
    try {
      for (;;) {
        if (stopImages) break;
        const pass = await readImages(IMAGES_PER_CALL);
        read += pass.read;
        set({ images: { read, remaining: pass.remaining } });
        if (pass.remaining === 0 || pass.read + pass.empty === 0) break;
      }
      set({ status: 'done' });
    } catch (err) {
      set({ status: 'error', error: (err as Error).message });
    }
  }

  return {
    start({ auto, images = false }) {
      if (state.status === 'running') return;
      /**
       * The unasked run happens once per page load. StrictMode mounts effects twice in
       * development, and the shell re-renders whenever the session does; neither should
       * start a second download of the same files. The button is not gated this way —
       * pressing it is asking.
       */
      if (auto) {
        if (autoStarted) return;
        autoStarted = true;
      }
      wantImages = images && !auto;
      stopImages = false;
      set({
        status: 'running',
        phase: 'pdfs',
        progress: { done: 0, indexed: 0, unusable: 0, failed: 0, total: 0 },
        images: null,
        remaining: 0,
        error: null,
      });
      ensureWorker().postMessage({ type: 'backfill', auto } satisfies ImportRequest);
    },

    abort() {
      stopImages = true;
      worker?.postMessage({ type: 'abort' } satisfies ImportRequest);
    },

    /**
     * The File goes across as it is: it is structured-cloneable, and Chromium passes the
     * blob by reference, so the bytes already in hand reach the worker without a copy and
     * without fetching them back from R2. `filename` is the name the server stored, which
     * is not always the file's own — `availableFilename` suffixes a collision.
     */
    indexFile(noteId, filename, file) {
      if (!isExtractable(file.type)) return;
      ensureWorker().postMessage({ type: 'index-file', noteId, filename, file } satisfies ImportRequest);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get: () => state,
  };
}

export const indexing = createIndexing(
  () => new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' }),
);

export function startIndexing(opts: { auto: boolean; images?: boolean }): void {
  indexing.start(opts);
}

/**
 * Indexes a file the editor just uploaded, unless the server said it is doing that.
 * The server's word wins because the server has the bytes and the client's pass would
 * only race it — and lose, since the upsert takes whichever text lands last.
 */
export function indexUploadedFile(noteId: string, uploaded: UploadedFile, file: File): void {
  if (uploaded.indexing === 'server') return;
  indexing.indexFile(noteId, uploaded.filename, file);
}

export function subscribeIndexing(listener: (state: IndexingState) => void): () => void {
  return indexing.subscribe(listener);
}

export function useIndexing(): IndexingState {
  return useSyncExternalStore(indexing.subscribe, indexing.get, indexing.get);
}
