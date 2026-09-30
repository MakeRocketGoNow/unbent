import { useSyncExternalStore } from 'react';
import { importFormat, type ImportFailure, type ImportProgress, type NotionUnit } from '@unbent/enex';
import type { ImportEvent, ImportRequest, NotionChoices } from './import-worker.js';
import { emptySkipLog, recordSkip, type SkipLog } from './components/import-skips.js';

export type ImportStatus = 'idle' | 'running' | 'done' | 'error';

/** What the worker said a picked zip is: this app's own export, Notion's, or neither. */
export type ZipDescription =
  | { kind: 'unbent' }
  | { kind: 'notion'; units: NotionUnit[] }
  | { kind: 'unreadable'; message: string };

export interface ImportRunState {
  status: ImportStatus;
  /** The file picked, and then the file being (or last) imported. */
  file: File | null;
  /** Null until a zip has been read, and always for any other kind of file. */
  zip: ZipDescription | null;
  progress: ImportProgress | null;
  failures: ImportFailure[];
  skips: SkipLog;
  error: string | null;
  /** `Date.now()` at Start, and when the run ended; the panel's clock is the difference. */
  startedAt: number;
  endedAt: number | null;
  /** Counts runs, so something dismissed for one run does not hide the next. */
  run: number;
}

const initial: ImportRunState = {
  status: 'idle',
  file: null,
  zip: null,
  progress: null,
  failures: [],
  skips: emptySkipLog,
  error: null,
  startedAt: 0,
  endedAt: null,
  run: 0,
};

/**
 * Cap on the retained failures: a bad file could otherwise produce thousands of entries
 * and push the tab into swap.
 */
const FAILURE_LIST_LIMIT = 200;

function initialProgress(): ImportProgress {
  return {
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    filesUploaded: 0,
    filesIndexed: 0,
    bytesRead: 0,
    notesTotal: 0,
    currentTitle: 'Starting import…',
  };
}

export interface ImportRun {
  /** Takes a file and, for a zip, has the worker read it. Ignored while a run is going. */
  pick(file: File | null): void;
  /** Imports the picked file. Nothing happens without one, or while a run is going. */
  start(options: { extractText: boolean; notion?: NotionChoices }): void;
  /** Asks the run to end between notes; it reports back as done or error like any other. */
  stop(): void;
  /** Forgets a finished run so another file can be picked. Ignored while one is going. */
  reset(): void;
  /**
   * Ties the run to whoever is signed in, and throws it away if that changes or if
   * nobody is.
   *
   * The summary lists note titles, and a run still going after a sign-out is sending the
   * next person's cookies. Neither should reach a different account on the same browser.
   * `undefined` is a sign-out: the worker used to die with the panel, and now it has to
   * be stopped here or it keeps posting until the next request 401s — or until a second
   * person signs in on this tab and the request goes out as them.
   */
  claim(userId: string | undefined): void;
  subscribe(listener: () => void): () => void;
  get(): ImportRunState;
}

/**
 * The import run and its worker, held by the module rather than by the panel.
 *
 * They were the panel's own state, and the panel terminated the worker when it unmounted.
 * So anything that navigated away ended a running import, and a finished one's summary —
 * failures, the skipped-note list — went with the page. Three things worked around that:
 * the rail and the settings sub-nav went inert for the whole run, the skipped-note rows
 * opened in a new tab, and in the Android app, which has no tabs, the rows stopped being
 * links while a run went. Each was a patch on the one real problem, and the last still
 * lost the summary to a tap once the run was over.
 *
 * Here, the run lives as long as the page does, whatever route is on screen, and the
 * panel is a view onto it that can come and go. It is kept until the person says they are
 * done with it (`reset`), because a summary that disappears on a timer or on navigation
 * is the bug this replaces. The same shape as `export-archive.ts`.
 *
 * The worker is made on first need and kept for the next file: a zip is described before
 * Start, so it has to exist before a run does.
 */
export function createImportRun(
  spawnWorker: () => Worker = () =>
    new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' }),
): ImportRun {
  let state = initial;
  const listeners = new Set<() => void>();
  let worker: Worker | null = null;
  let owner: string | null = null;
  /**
   * Describes sent and not yet answered. The worker answers them in order but does not say
   * which file an answer is for, so only the answer to the latest pick is applied: one for
   * a file picked over since would otherwise draw the wrong zip's picker.
   */
  let describing = 0;

  const set = (patch: Partial<ImportRunState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  // The run lives in this tab, so closing or reloading it ends the import. Navigating
  // inside the app no longer does, which leaves this as the one way out worth a warning.
  // Through `globalThis`, and optional, because the tests run under Node.
  const guard = (e: BeforeUnloadEvent) => e.preventDefault();
  const end = (patch: Partial<ImportRunState>) => {
    globalThis.removeEventListener?.('beforeunload', guard);
    set({ ...patch, endedAt: Date.now() });
  };

  function onEvent(data: ImportEvent) {
    switch (data.type) {
      case 'described': {
        describing = Math.max(0, describing - 1);
        if (describing > 0 || !state.file || importFormat(state.file.name) !== 'zip') return;
        if (data.kind === 'notion') set({ zip: { kind: 'notion', units: data.units } });
        else if (data.kind === 'unbent') set({ zip: { kind: 'unbent' } });
        else set({ zip: { kind: 'unreadable', message: data.message } });
        return;
      }
      case 'progress':
        set({ progress: data.progress });
        return;
      case 'failure':
        if (state.failures.length < FAILURE_LIST_LIMIT) set({ failures: [...state.failures, data.failure] });
        return;
      case 'skip':
        set({ skips: recordSkip(state.skips, data.skip) });
        return;
      case 'done':
        end({ status: 'done', progress: data.progress });
        return;
      case 'error':
        end({ status: 'error', error: data.message });
        return;
    }
  }

  function spawn(): Worker {
    if (worker) return worker;
    const w = spawnWorker();
    worker = w;
    w.onmessage = (event: MessageEvent<ImportEvent>) => onEvent(event.data);
    w.onerror = (event) => {
      w.terminate();
      worker = null;
      describing = 0;
      // Module workers often report an empty message on abrupt death (e.g. nested pdf.js
      // worker teardown). Surface something actionable rather than a blank error line.
      const message = event.message || 'Import worker crashed — try again; already-imported notes are skipped.';
      if (state.status === 'running') end({ status: 'error', error: message });
      // A crash while reading a picked zip would otherwise leave it "reading" forever.
      else if (state.file && importFormat(state.file.name) === 'zip' && !state.zip) {
        set({ zip: { kind: 'unreadable', message } });
      }
    };
    return w;
  }

  return {
    pick(file) {
      if (state.status === 'running') return;
      set({ ...initial, run: state.run, file });
      if (file && importFormat(file.name) === 'zip') {
        describing += 1;
        spawn().postMessage({ type: 'describe', file } satisfies ImportRequest);
      }
    },
    start({ extractText, notion }) {
      const { file } = state;
      if (!file || state.status === 'running') return;
      globalThis.addEventListener?.('beforeunload', guard);
      // Progress is set before the worker module finishes loading, so the running state
      // shows at once and a worker startup failure is visible rather than an unchanged form.
      set({
        status: 'running',
        progress: initialProgress(),
        failures: [],
        skips: emptySkipLog,
        error: null,
        startedAt: Date.now(),
        endedAt: null,
        run: state.run + 1,
      });
      const request: ImportRequest = { type: 'start', file, extractText, ...(notion ? { notion } : {}) };
      spawn().postMessage(request);
    },
    stop() {
      if (state.status !== 'running') return;
      worker?.postMessage({ type: 'abort' } satisfies ImportRequest);
    },
    reset() {
      if (state.status === 'running') return;
      set({ ...initial, run: state.run });
    },
    claim(userId) {
      const next = userId ?? null;
      if (next === owner) return;
      // A different person, or nobody. Signing out used to unmount the panel and kill
      // the worker; the run now outlives the page, so it has to be dropped here or the
      // next fetch uses whoever's cookie is in the jar. The titles in the summary are
      // the other half — they must not be sitting there when the next person arrives.
      if (owner !== null || state.status === 'running') {
        worker?.terminate();
        worker = null;
        describing = 0;
        globalThis.removeEventListener?.('beforeunload', guard);
        set({ ...initial, run: state.run });
      }
      owner = next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
  };
}

const importRun = createImportRun();

export const pickImportFile = (file: File | null) => importRun.pick(file);
export const startImport = (options: { extractText: boolean; notion?: NotionChoices }) => importRun.start(options);
export const stopImport = () => importRun.stop();
export const resetImport = () => importRun.reset();
export const claimImportFor = (userId: string | undefined) => importRun.claim(userId);
export const subscribeImport = (listener: () => void) => importRun.subscribe(listener);
export const getImportRun = () => importRun.get();

export function useImportRun(): ImportRunState {
  return useSyncExternalStore(importRun.subscribe, importRun.get);
}

/**
 * Only whether an import is running, for a control that must not be used during one.
 * The state changes once per note; this re-renders when the answer does.
 */
export function useImportRunning(): boolean {
  return useSyncExternalStore(importRun.subscribe, () => importRun.get().status === 'running');
}
