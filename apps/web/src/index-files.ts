import { useSyncExternalStore } from 'react';
import { isExtractable } from '@unbent/enex';
import type { IndexProgress } from './attachment-text.js';
import type { UploadedFile } from './notes-api.js';
import type { ImportEvent, ImportRequest } from './import-worker.js';

/**
 * The one place PDF indexing is started from, and the one place its state lives.
 *
 * Indexing used to be a private affair of the Import panel: it made a worker, listened to
 * it, and terminated it on unmount, so leaving Settings killed a run in progress. Now the
 * app starts a pass on open, the editor hands over a file it has just uploaded, and the
 * panel's button is one caller among several. A run has to outlive any one screen, and
 * every screen has to be able to see it, so the state is a module-level store that React
 * reads through `useSyncExternalStore`, which is what that hook is for.
 *
 * Built by a factory so a test can hand in a fake worker; the instance at the bottom spawns
 * the real one.
 */

/**
 * `stopped` is a pass the person ended, keeping whatever it had done by then. Not `error`,
 * which is a pass that ended itself, and not `done`, which promises nothing was left.
 */
export type IndexingStatus = 'idle' | 'running' | 'done' | 'stopped' | 'deferred' | 'error';

export interface IndexingState {
  status: IndexingStatus;
  /** Null until a pass has started. */
  progress: IndexProgress | null;
  /** How many files a deferred pass left alone; see `AUTO_INDEX_LIMIT`. */
  remaining: number;
  /**
   * A stop has been asked for and the pass has not ended yet. Set for as long as the file
   * in flight takes to land, so the screen can say the press was heard rather than look as
   * if it was ignored.
   */
  stopping: boolean;
  error: string | null;
}

export interface Indexing {
  /**
   * Starts the browser's pass over the pending PDFs. `auto` marks an unasked one, which
   * runs once. Only ever the PDFs: a pass over the account's pictures ran on the server
   * from here until MAK-179, a paid request per file, and went when the language model
   * was confined to Auto-fill.
   */
  start(opts: { auto: boolean }): void;
  /**
   * Ends the running pass, between files (the worker's abort), with the file in flight
   * left to land rather than wasted, and the state saying `stopping` until it does.
   * Nothing happens when no pass is running.
   */
  stop(): void;
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
  progress: null,
  remaining: 0,
  stopping: false,
  error: null,
};

export function createIndexing(spawn: () => Worker): Indexing {
  let state = initial;
  const listeners = new Set<(state: IndexingState) => void>();
  let worker: Worker | null = null;
  let autoStarted = false;
  /**
   * A stop asked for during this pass, read by the worker's answers: an abort ends the
   * worker's pass with the same `backfill-done` a finished one sends (or, when it cuts a
   * fetch short, an `error`), and this is what tells those apart from the real thing.
   */
  let stopping = false;

  function set(patch: Partial<IndexingState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  /**
   * One worker, made on first use and kept.
   *
   * Kept rather than made per run because the editor posts it single files as they are
   * uploaded, and a worker per file would load pdf.js (about a megabyte) every time.
   */
  function ensureWorker(): Worker {
    if (worker) return worker;
    const w = spawn();
    w.onmessage = (event: MessageEvent<ImportEvent>) => {
      const data = event.data;
      if (data.type === 'backfill-progress') set({ progress: data.progress });
      else if (data.type === 'backfill-done') {
        set({ status: stopping ? 'stopped' : 'done', stopping: false, progress: data.progress });
      }
      else if (data.type === 'backfill-deferred') set({ status: 'deferred', remaining: data.remaining });
      else if (data.type === 'error') {
        if (stopping) set({ status: 'stopped', stopping: false });
        else set({ status: 'error', error: data.message });
      }
    };
    w.onerror = (event) => {
      // Module workers often die with an empty message: the nested pdf.js worker's
      // teardown is one way. Say something actionable, and drop the worker so the next
      // start gets a fresh one instead of posting into a corpse.
      set({ status: 'error', stopping: false, error: event.message || 'Indexing stopped unexpectedly. Try again.' });
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
    return w;
  }

  return {
    start({ auto }) {
      if (state.status === 'running') return;
      /**
       * The unasked run happens once per page load. StrictMode mounts effects twice in
       * development, and the shell re-renders whenever the session does; neither should
       * start a second download of the same files. The button is not gated this way:
       * pressing it is asking.
       */
      if (auto) {
        if (autoStarted) return;
        autoStarted = true;
      }
      stopping = false;
      set({
        status: 'running',
        progress: { done: 0, indexed: 0, unusable: 0, failed: 0, total: 0 },
        remaining: 0,
        stopping: false,
        error: null,
      });
      ensureWorker().postMessage({ type: 'backfill', auto } satisfies ImportRequest);
    },

    stop() {
      if (state.status !== 'running') return;
      stopping = true;
      set({ stopping: true });
      worker?.postMessage({ type: 'abort' } satisfies ImportRequest);
    },

    /**
     * The File goes across as it is: it is structured-cloneable, and Chromium passes the
     * blob by reference, so the bytes already in hand reach the worker without a copy and
     * without fetching them back from R2. `filename` is the name the server stored, which
     * is not always the file's own: `availableFilename` suffixes a collision.
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

export function startIndexing(opts: { auto: boolean }): void {
  indexing.start(opts);
}

export function stopIndexing(): void {
  indexing.stop();
}

/**
 * Indexes a file the editor just uploaded, unless the server said it is doing that.
 * The server's word wins because the server has the bytes and the client's pass would
 * only race it, and lose, since the upsert takes whichever text lands last.
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
