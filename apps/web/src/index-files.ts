import { useSyncExternalStore } from 'react';
import type { IndexProgress } from './attachment-text.js';
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
  /** Null until a pass has started. */
  progress: IndexProgress | null;
  /** How many files a deferred pass left alone; see `AUTO_INDEX_LIMIT`. */
  remaining: number;
  error: string | null;
}

export interface Indexing {
  /** Starts a pass over everything pending. `auto` marks an unasked one, which runs once. */
  start(opts: { auto: boolean }): void;
  abort(): void;
  subscribe(listener: (state: IndexingState) => void): () => void;
  get(): IndexingState;
}

const initial: IndexingState = { status: 'idle', progress: null, remaining: 0, error: null };

export function createIndexing(spawn: () => Worker): Indexing {
  let state = initial;
  const listeners = new Set<(state: IndexingState) => void>();
  let worker: Worker | null = null;
  let autoStarted = false;

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
      else if (data.type === 'backfill-done') set({ status: 'done', progress: data.progress });
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

  return {
    start({ auto }) {
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
      set({
        status: 'running',
        progress: { done: 0, indexed: 0, unusable: 0, failed: 0, total: 0 },
        remaining: 0,
        error: null,
      });
      ensureWorker().postMessage({ type: 'backfill', auto } satisfies ImportRequest);
    },

    abort() {
      worker?.postMessage({ type: 'abort' } satisfies ImportRequest);
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

export function subscribeIndexing(listener: (state: IndexingState) => void): () => void {
  return indexing.subscribe(listener);
}

export function useIndexing(): IndexingState {
  return useSyncExternalStore(indexing.subscribe, indexing.get, indexing.get);
}
